import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import type { CaptureInput, CreateFeatureInput, ExecutionProfile, Feature, FeatureManifest, FeatureState, InboxItem, RepositoryStatus, ValidationReport } from "../domain/types.js";
import { FEATURE_STATES } from "../domain/types.js";
import { FeatureAlreadyExistsError, FeatureNotFoundError, FeatureStateConflictError, ForgiumNotInitializedError, InvalidInboxItemError, InvalidManifestError, InvalidStateTransitionError } from "../errors/forgium-errors.js";
import { InboxFrontmatterSchema } from "../schemas/inbox.schema.js";
import { ManifestSchema } from "../schemas/manifest.schema.js";
import { isoNow, shortId, slugify, timestampForFile } from "../services/id.js";
import { specFlowCommandsForSpec } from "../services/spec-flow-commands.js";
import { canTransition } from "../transitions/transition-rules.js";
import { forgiumPaths } from "./paths.js";

export class FilesystemForgiumRepository {
  private readonly paths;
  constructor(public readonly root: string) { this.paths = forgiumPaths(root); }

  async init(): Promise<void> {
    for (const dir of this.paths.requiredDirs) await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(this.root, ".loop"), { recursive: true });
    await this.ensureGitignoreRuntime();
  }

  async capture(input: CaptureInput): Promise<InboxItem> {
    await this.assertInitialized();
    const text = input.text.trim();
    if (!text) throw new InvalidInboxItemError("Capture text cannot be empty.");
    const lines = text.split(/\r?\n/);
    const title = lines[0]!.replace(/^#\s+/, "").trim();
    const body = lines.slice(1).join("\n").trim();
    const stamp = timestampForFile();
    const idSuffix = shortId();
    const id = `inbox-${stamp}-${idSuffix}`;
    const created = isoNow();
    const source = input.source ?? "cli";
    const filename = `${stamp}-${idSuffix}.md`;
    const filePath = path.join(this.paths.inbox, filename);
    const content = this.renderInbox({ id, source, created, status: "captured", title, body, path: filePath });
    await this.writeFileAtomic(filePath, content);
    return { id, source, created, status: "captured", title, body: body || undefined, path: filePath };
  }

  async listInbox(): Promise<InboxItem[]> {
    await this.assertInitialized();
    const entries = await safeReaddir(this.paths.inbox);
    const items: InboxItem[] = [];
    for (const entry of entries.filter((e) => e.endsWith(".md")).sort()) {
      items.push(await this.readInboxFile(path.join(this.paths.inbox, entry)));
    }
    return items.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  }

  async createFeature(input: CreateFeatureInput): Promise<Feature> {
    await this.assertInitialized();
    const slug = input.slug ? slugify(input.slug) : slugify(input.title);
    const id = input.id ?? `feature-${slug}`;
    const featurePath = this.paths.featureDir("ready", slug);
    if (await exists(featurePath)) throw new FeatureAlreadyExistsError(id);
    const manifest: FeatureManifest = {
      schemaVersion: 1,
      id,
      title: input.title,
      created: isoNow(),
      source: input.source,
      goal: input.goal,
      acceptance: input.acceptance,
      constraints: input.constraints
    };
    const parsed = ManifestSchema.safeParse(manifest);
    if (!parsed.success) throw new InvalidManifestError(parsed.error.message);
    await fs.mkdir(featurePath, { recursive: false });
    await this.writeFileAtomic(path.join(featurePath, "manifest.yaml"), YAML.stringify(manifest));
    return this.readFeature(featurePath, "ready");
  }

  async listFeatures(state?: FeatureState): Promise<Feature[]> {
    await this.assertInitialized();
    const states = state ? [state] : FEATURE_STATES;
    const features: Feature[] = [];
    for (const s of states) {
      for (const entry of (await safeReaddir(this.paths.featureStateDir(s))).sort()) {
        const full = this.paths.featureDir(s, entry);
        if ((await fs.stat(full)).isDirectory()) features.push(await this.readFeature(full, s));
      }
    }
    return features.sort((a, b) => a.manifest.created.localeCompare(b.manifest.created) || a.id.localeCompare(b.id));
  }

  async getFeature(id: string): Promise<Feature | null> {
    for (const feature of await this.listFeatures()) if (feature.id === id || feature.slug === id) return feature;
    return null;
  }

  async getNextReady(): Promise<Feature | null> { return (await this.listFeatures("ready"))[0] ?? null; }

  async startFeature(id: string): Promise<Feature> { return this.transition(id, "doing", true); }
  async submitForReview(id: string): Promise<Feature> { return this.transition(id, "review"); }
  async completeFeature(id: string): Promise<Feature> { return this.transition(id, "done"); }
  async returnToDoing(id: string): Promise<Feature> { return this.transition(id, "doing"); }
  async unblockFeature(id: string): Promise<Feature> { return this.transition(id, "ready"); }
  async blockFeature(id: string, reason: string): Promise<Feature> {
    const feature = await this.transition(id, "blocked");
    await fs.appendFile(path.join(feature.path, "notes.md"), `\n## Blocked ${new Date().toISOString()}\n\n${reason}\n`);
    return feature;
  }

  async inspectExecutionMode(id: string): Promise<ExecutionProfile> {
    const feature = await this.requireFeature(id);
    const specPath = path.join(feature.path, "spec.md");
    const ticketsPath = path.join(feature.path, "tickets");
    const hasSpec = await exists(specPath);
    const hasTickets = await exists(ticketsPath);
    if (hasSpec && hasTickets) {
      const commands = specFlowCommandsForSpec(specPath);
      return { kind: "spec-flow", specPath, ticketsPath, commands: { implement: commands.implement, next: commands.next } };
    }
    if (hasSpec) return { kind: "spec-needs-plan", specPath, commands: specFlowCommandsForSpec(specPath) };
    return { kind: "direct" };
  }

  async getStatus(): Promise<RepositoryStatus> {
    await this.assertInitialized();
    const inbox: Record<string, number> = { captured: 0, promoted: 0, merged: 0, deferred: 0 };
    for (const item of await this.listInbox()) inbox[item.status] = (inbox[item.status] ?? 0) + 1;
    const features = Object.fromEntries(FEATURE_STATES.map((s) => [s, 0])) as RepositoryStatus["features"];
    for (const feature of await this.listFeatures()) features[feature.state]++;
    return { inbox, features };
  }

  async validate(): Promise<ValidationReport> {
    const issues: ValidationReport["issues"] = [];
    for (const dir of this.paths.requiredDirs) if (!(await exists(dir))) issues.push({ severity: "error", code: "MISSING_DIRECTORY", message: `Missing directory: ${path.relative(this.root, dir)}`, path: dir });
    if (issues.length) return { valid: false, issues };
    for (const file of (await safeReaddir(this.paths.inbox)).filter((e) => e.endsWith(".md"))) {
      try { await this.readInboxFile(path.join(this.paths.inbox, file)); } catch (error) { issues.push({ severity: "error", code: "INVALID_INBOX_ITEM", message: String((error as Error).message), path: path.join(this.paths.inbox, file) }); }
    }
    for (const state of FEATURE_STATES) {
      for (const entry of await safeReaddir(this.paths.featureStateDir(state))) {
        const full = this.paths.featureDir(state, entry);
        if (!(await fs.stat(full)).isDirectory()) continue;
        try { await this.readFeature(full, state); } catch (error) { issues.push({ severity: "error", code: "INVALID_FEATURE", message: String((error as Error).message), path: full }); }
      }
    }
    return { valid: issues.filter((i) => i.severity === "error").length === 0, issues };
  }

  private async transition(id: string, to: FeatureState, createLease = false): Promise<Feature> {
    const feature = await this.requireFeature(id);
    if (!canTransition(feature.state, to)) throw new InvalidStateTransitionError(feature.state, to);
    ManifestSchema.parse(feature.manifest);
    const dest = this.paths.featureDir(to, feature.slug);
    if (await exists(dest)) throw new FeatureStateConflictError(`Destination already exists: ${dest}`);
    await fs.rename(feature.path, dest);
    if (createLease) await this.createLease(feature.id);
    return this.readFeature(dest, to);
  }

  private async createLease(featureId: string): Promise<void> {
    const runsDir = path.join(this.paths.runtime, "runs");
    await fs.mkdir(runsDir, { recursive: true });
    const runId = `run-${timestampForFile()}-${shortId()}`;
    await this.writeFileAtomic(path.join(runsDir, `${runId}.json`), JSON.stringify({ runId, featureId, startedAt: isoNow(), host: os.hostname(), pid: process.pid }, null, 2));
  }

  private async requireFeature(id: string): Promise<Feature> { const feature = await this.getFeature(id); if (!feature) throw new FeatureNotFoundError(id); return feature; }

  private async assertInitialized(): Promise<void> {
    for (const dir of this.paths.requiredDirs) if (!(await exists(dir))) throw new ForgiumNotInitializedError();
  }

  private async readFeature(featurePath: string, state: FeatureState): Promise<Feature> {
    const manifestPath = path.join(featurePath, "manifest.yaml");
    const manifest = ManifestSchema.parse(YAML.parse(await fs.readFile(manifestPath, "utf8"))) as FeatureManifest;
    return {
      id: manifest.id,
      slug: path.basename(featurePath),
      state,
      path: featurePath,
      manifest,
      artifacts: {
        spec: (await exists(path.join(featurePath, "spec.md"))) ? path.join(featurePath, "spec.md") : undefined,
        ticketsDirectory: (await exists(path.join(featurePath, "tickets"))) ? path.join(featurePath, "tickets") : undefined,
        notes: (await exists(path.join(featurePath, "notes.md"))) ? path.join(featurePath, "notes.md") : undefined,
        research: (await exists(path.join(featurePath, "research.md"))) ? path.join(featurePath, "research.md") : undefined
      }
    };
  }

  private async readInboxFile(filePath: string): Promise<InboxItem> {
    const raw = await fs.readFile(filePath, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new InvalidInboxItemError(`Missing frontmatter in ${filePath}`);
    const frontmatter = InboxFrontmatterSchema.parse(YAML.parse(match[1]!));
    const body = match[2]!.trim();
    const titleMatch = body.match(/^#\s+(.+)$/m);
    if (!titleMatch) throw new InvalidInboxItemError(`Inbox item must contain one H1 title: ${filePath}`);
    const rest = body.replace(/^#\s+.+\n?/, "").trim();
    return { ...frontmatter, title: titleMatch[1]!.trim(), body: rest || undefined, path: filePath };
  }

  private renderInbox(item: InboxItem): string {
    const fm: Record<string, unknown> = { id: item.id, source: item.source, created: item.created, status: item.status };
    if (item.featureRef) fm.featureRef = item.featureRef;
    return `---\n${YAML.stringify(fm)}---\n\n# ${item.title}\n${item.body ? `\n${item.body}\n` : ""}`;
  }

  private async ensureGitignoreRuntime(): Promise<void> {
    const gitignore = path.join(this.root, ".gitignore");
    const line = ".loop/runtime/";
    const current = await fs.readFile(gitignore, "utf8").catch(() => "");
    if (!current.split(/\r?\n/).includes(line)) await fs.appendFile(gitignore, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${line}\n`);
  }

  private async writeFileAtomic(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, filePath);
  }
}

async function exists(filePath: string): Promise<boolean> { try { await fs.access(filePath); return true; } catch { return false; } }
async function safeReaddir(dir: string): Promise<string[]> { try { return await fs.readdir(dir); } catch { return []; } }
