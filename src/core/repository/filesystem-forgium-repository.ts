import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import type { CaptureInput, CreateFeatureInput, Draft, DraftFrontmatter, ExecutionProfile, Feature, FeatureManifest, FeatureState, InboxItem, Receipt, ReceiptEvidence, RepositoryStatus, ReviewDecision, ValidationReport, VerificationReceipt } from "../domain/types.js";
import { FEATURE_STATES } from "../domain/types.js";
import { DraftAlreadyExistsError, DraftNotFoundError, FeatureAlreadyExistsError, FeatureNotFoundError, FeatureStateConflictError, ForgiumNotInitializedError, InvalidDraftError, InvalidInboxItemError, InvalidManifestError, InvalidReceiptError, InvalidStateTransitionError, ReceiptAlreadyExistsError, ReviewReceiptRequiredError } from "../errors/forgium-errors.js";
import { DraftSchema } from "../schemas/draft.schema.js";
import { InboxFrontmatterSchema } from "../schemas/inbox.schema.js";
import { ManifestSchema } from "../schemas/manifest.schema.js";
import { ReceiptSchema } from "../schemas/receipt.schema.js";
import { isoNow, shortId, slugify, timestampForFile } from "../services/id.js";
import { specFlowCommandsForSpec } from "../services/spec-flow-commands.js";
import { canTransition } from "../transitions/transition-rules.js";
import { forgiumPaths } from "./paths.js";

const exec = promisify(execCallback);
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_SUMMARY_LENGTH = 2_000;

export class FilesystemForgiumRepository {
  private readonly paths;
  constructor(public readonly root: string) { this.paths = forgiumPaths(root); }

  async init(): Promise<void> {
    for (const dir of this.paths.requiredDirs) await fs.mkdir(dir, { recursive: true });
    await this.ensureGitignoreRuntime();
  }

  async capture(input: CaptureInput): Promise<InboxItem> {
    await this.assertInitialized();
    const text = input.text.trim();
    if (!text) throw new InvalidInboxItemError("Capture text cannot be empty.");
    const lines = text.split(/\r?\n/);
    const title = lines[0]!.replace(/^#\s+/, "").trim();
    if (!title) throw new InvalidInboxItemError("Capture title cannot be empty.");
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

  async listDrafts(): Promise<Draft[]> {
    await this.assertInitialized();
    const drafts: Draft[] = [];
    for (const entry of (await safeReaddir(this.paths.featureStateDir("draft"))).sort()) {
      const full = this.paths.featureDir("draft", entry);
      if ((await fs.stat(full)).isDirectory()) drafts.push(await this.readDraft(full));
    }
    return drafts.sort((a, b) => a.frontmatter.created.localeCompare(b.frontmatter.created) || a.id.localeCompare(b.id));
  }

  async getDraft(id: string): Promise<Draft | null> {
    for (const draft of await this.listDrafts()) if (draft.id === id || draft.slug === id) return draft;
    return null;
  }

  async createDraftFromInbox(id: string): Promise<Draft> {
    await this.assertInitialized();
    const item = (await this.listInbox()).find((candidate) => candidate.id === id);
    if (!item) throw new InvalidInboxItemError(`Inbox item not found: ${id}`);
    if (item.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${id}`);

    const slug = slugify(item.title);
    const draftId = `draft-${slug}`;
    const draftPath = this.paths.featureDir("draft", slug);
    if (await exists(draftPath)) throw new DraftAlreadyExistsError(draftId);

    const frontmatter: DraftFrontmatter = {
      schemaVersion: 1,
      id: draftId,
      created: isoNow(),
      source: { type: "inbox", ref: item.id },
      title: item.title,
      goal: "",
      acceptance: [],
      constraints: []
    };
    DraftSchema.parse(frontmatter);
    const draftContent = this.renderDraft(frontmatter, item.body ? `${item.title}\n\n${item.body}` : item.title);
    await fs.mkdir(draftPath, { recursive: false });
    try {
      await this.writeFileAtomic(path.join(draftPath, "draft.md"), draftContent);
      await this.writeInboxItem({ ...item, status: "drafted", draftRef: draftId });
    } catch (error) {
      await fs.rm(draftPath, { recursive: true, force: true });
      throw error;
    }
    return this.readDraft(draftPath);
  }

  async deferInbox(id: string): Promise<InboxItem> {
    const item = await this.requireInbox(id);
    if (item.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${id}`);
    const deferred = { ...item, status: "deferred" as const };
    await this.writeInboxItem(deferred);
    return deferred;
  }

  async mergeInbox(id: string, featureId: string): Promise<InboxItem> {
    const item = await this.requireInbox(id);
    if (item.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${id}`);
    if (!(await this.getFeature(featureId))) throw new FeatureNotFoundError(featureId);
    const merged = { ...item, status: "merged" as const, featureRef: featureId };
    await this.writeInboxItem(merged);
    return merged;
  }

  async promoteDraft(id: string): Promise<Feature> {
    await this.assertInitialized();
    const draft = await this.requireDraft(id);
    const frontmatter = this.parsePromotableDraft(draft);
    const featureId = `feature-${draft.slug}`;
    const sourceInbox = (await this.listInbox()).find((item) => item.id === frontmatter.source.ref);
    if (!sourceInbox || sourceInbox.status !== "drafted" || sourceInbox.draftRef !== draft.id) {
      throw new InvalidDraftError(`Draft source is not linked to a drafted Inbox item: ${draft.id}`);
    }
    if (await this.featureIdExists(featureId) || await exists(this.paths.featureDir("ready", draft.slug))) {
      throw new FeatureAlreadyExistsError(featureId);
    }

    const manifest: FeatureManifest = {
      schemaVersion: 1,
      id: featureId,
      title: frontmatter.title.trim(),
      created: frontmatter.created,
      source: frontmatter.source,
      goal: frontmatter.goal.trim(),
      acceptance: frontmatter.acceptance.map((criterion) => criterion.trim()).filter(Boolean),
      constraints: frontmatter.constraints?.map((constraint) => constraint.trim()).filter(Boolean)
    };
    ManifestSchema.parse(manifest);
    const destination = this.paths.featureDir("ready", draft.slug);
    const manifestPath = path.join(draft.path, "manifest.yaml");
    try {
      await this.writeFileAtomic(manifestPath, YAML.stringify(manifest));
      await fs.rename(draft.path, destination);
    } catch (error) {
      await fs.rm(manifestPath, { force: true });
      throw error;
    }

    try {
      await this.writeInboxItem({ ...sourceInbox, status: "promoted", featureRef: featureId });
    } catch (error) {
      await fs.rename(destination, draft.path).catch(() => undefined);
      await fs.rm(manifestPath, { force: true });
      throw error;
    }
    return this.readFeature(destination, "ready");
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
      constraints: input.constraints,
      verification: input.verification
    };
    const parsed = ManifestSchema.safeParse(manifest);
    if (!parsed.success) throw new InvalidManifestError(parsed.error.message);
    await fs.mkdir(featurePath, { recursive: false });
    await this.writeFileAtomic(path.join(featurePath, "manifest.yaml"), YAML.stringify(manifest));
    return this.readFeature(featurePath, "ready");
  }

  async listReceipts(featureId: string): Promise<Receipt[]> {
    const feature = await this.requireFeature(featureId);
    const receipts: Receipt[] = [];
    for (const entry of (await safeReaddir(path.join(feature.path, "receipts"))).filter((name) => name.endsWith(".yaml")).sort()) {
      const receiptPath = path.join(feature.path, "receipts", entry);
      try {
        const receipt = ReceiptSchema.parse(YAML.parse(await fs.readFile(receiptPath, "utf8"))) as Receipt;
        this.validateReceiptReferences(feature.path, receipt);
        receipts.push(receipt);
      } catch (error) {
        throw new InvalidReceiptError(`Invalid receipt ${receiptPath}: ${String((error as Error).message)}`);
      }
    }
    return receipts.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  }

  async verifyFeature(id: string, options: { evidence?: ReceiptEvidence[]; runId?: string } = {}): Promise<VerificationReceipt> {
    const feature = await this.requireFeature(id);
    if (feature.state !== "doing") throw new InvalidStateTransitionError(feature.state, "review");
    const runId = options.runId ?? `run-${timestampForFile()}-${shortId()}`;
    const policy = feature.manifest.verification;
    const checks: VerificationReceipt["checks"] = [];
    let evidence: ReceiptEvidence[] | undefined;
    let outcome: VerificationReceipt["outcome"] = "not_configured";

    if (policy) {
      for (const command of policy.commands) {
        const started = Date.now();
        try {
          const result = await exec(command.run, { cwd: this.root, timeout: command.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 });
          checks.push({ name: command.name, command: command.run, cwd: ".", exitCode: 0, durationMs: Date.now() - started, status: "passed", outputSummary: redactOutput(`${result.stdout}${result.stderr}`) });
        } catch (error) {
          const commandError = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
          checks.push({ name: command.name, command: command.run, cwd: ".", exitCode: typeof commandError.code === "number" ? commandError.code : null, durationMs: Date.now() - started, status: commandError.killed ? "cancelled" : "failed", outputSummary: redactOutput(`${commandError.stdout ?? ""}${commandError.stderr ?? ""}`) });
        }
      }
      evidence = policy.requiredEvidence?.map((required) => options.evidence?.find((candidate) => candidate.criterion === required.criterion && candidate.kind === required.kind) ?? { ...required, status: "pending" as const });
      if (checks.some((check) => check.status === "cancelled")) outcome = "cancelled";
      else if (checks.some((check) => check.status === "failed")) outcome = "failed";
      else if (evidence?.some((item) => item.status !== "passed")) outcome = "manual_required";
      else outcome = "passed";
    }

    const receipt = this.createVerificationReceipt(feature, runId, outcome, checks, evidence);
    await this.persistReceipt(feature, receipt);
    if (outcome === "failed" || outcome === "cancelled") {
      await this.persistReceipt(feature, this.createHandoffReceipt(feature, runId, outcome === "cancelled" ? "cancelled" : "failed", receipt.id, receipt.summary));
    } else {
      await this.transition(id, "review");
    }
    return receipt;
  }

  async reviewFeature(id: string, decision: ReviewDecision, summary: string, actorName = "forgium"): Promise<Feature> {
    const feature = await this.requireFeature(id);
    if (feature.state !== "review") throw new InvalidStateTransitionError(feature.state, "review");
    await this.persistReceipt(feature, this.createReviewReceipt(feature, decision, summary, actorName));
    return this.transition(id, decision === "approved" ? "done" : decision === "changes_requested" ? "doing" : "blocked");
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
  async completeFeature(id: string): Promise<Feature> {
    const feature = await this.requireFeature(id);
    if (!(await this.hasApprovedReviewReceipt(feature))) throw new ReviewReceiptRequiredError(id);
    return this.transition(id, "done");
  }
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
    const inbox: Record<string, number> = { captured: 0, drafted: 0, promoted: 0, merged: 0, deferred: 0 };
    for (const item of await this.listInbox()) inbox[item.status] = (inbox[item.status] ?? 0) + 1;
    const features = Object.fromEntries(FEATURE_STATES.map((s) => [s, 0])) as RepositoryStatus["features"];
    for (const feature of await this.listFeatures()) features[feature.state]++;
    return { inbox, drafts: await this.countDirectories(this.paths.featureStateDir("draft")), features };
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
        try { await this.validateReceiptFiles(full); } catch (error) { issues.push({ severity: "error", code: "INVALID_RECEIPT", message: String((error as Error).message), path: full }); }
      }
    }
    for (const entry of await safeReaddir(this.paths.featureStateDir("draft"))) {
      const full = this.paths.featureDir("draft", entry);
      if (!(await fs.stat(full)).isDirectory()) continue;
      try { await this.readDraft(full); } catch (error) { issues.push({ severity: "error", code: "INVALID_DRAFT", message: String((error as Error).message), path: full }); }
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

  private async requireInbox(id: string): Promise<InboxItem> {
    const item = (await this.listInbox()).find((candidate) => candidate.id === id);
    if (!item) throw new InvalidInboxItemError(`Inbox item not found: ${id}`);
    return item;
  }

  private async requireDraft(id: string): Promise<Draft> { const draft = await this.getDraft(id); if (!draft) throw new DraftNotFoundError(id); return draft; }

  private async assertInitialized(): Promise<void> {
    for (const dir of this.paths.requiredDirs) if (!(await exists(dir))) throw new ForgiumNotInitializedError();
  }

  private createVerificationReceipt(feature: Feature, runId: string, outcome: VerificationReceipt["outcome"], checks: VerificationReceipt["checks"], evidence?: ReceiptEvidence[]): VerificationReceipt {
    return {
      ...this.receiptBase(feature, "verification", outcome, `Verification outcome: ${outcome}.`, runId, "verifier", "forgium"),
      kind: "verification",
      outcome,
      checks,
      evidence
    };
  }

  private createReviewReceipt(feature: Feature, decision: ReviewDecision, summary: string, actorName: string): Receipt {
    return {
      ...this.receiptBase(feature, "review", decision, summary, `review-${timestampForFile()}-${shortId()}`, "reviewer", actorName),
      kind: "review",
      outcome: decision,
      decision
    };
  }

  private createHandoffReceipt(feature: Feature, runId: string, outcome: "failed" | "cancelled", relatedReceipt: string, reason: string): Receipt {
    return {
      ...this.receiptBase(feature, "handoff", outcome, reason, runId, "system", "forgium"),
      kind: "handoff",
      outcome,
      reason,
      relatedReceipt
    };
  }

  private receiptBase(feature: Feature, kind: Receipt["kind"], outcome: string, summary: string, runId: string, actorType: string, actorName: string) {
    return {
      schemaVersion: 1 as const,
      id: `receipt-${timestampForFile()}-${shortId()}-${kind}`,
      kind,
      created: isoNow(),
      feature: { id: feature.id, manifestPath: "manifest.yaml" },
      runId,
      actor: { type: actorType, name: actorName, version: "0.1.0" },
      outcome,
      summary: summary.trim() || "No summary provided."
    };
  }

  private async persistReceipt(feature: Feature, receipt: Receipt): Promise<void> {
    const parsed = ReceiptSchema.safeParse(receipt);
    if (!parsed.success) throw new InvalidReceiptError(parsed.error.message);
    if (receipt.feature.id !== feature.id) throw new InvalidReceiptError(`Receipt feature does not match ${feature.id}.`);
    this.validateReceiptReferences(feature.path, receipt);
    const receiptsPath = path.join(feature.path, "receipts");
    const receiptPath = path.join(receiptsPath, `${receipt.id}.yaml`);
    if (await exists(receiptPath)) throw new ReceiptAlreadyExistsError(receipt.id);
    await this.writeFileAtomic(receiptPath, YAML.stringify(receipt));
  }

  private async validateReceiptFiles(featurePath: string): Promise<void> {
    for (const entry of (await safeReaddir(path.join(featurePath, "receipts"))).filter((name) => name.endsWith(".yaml"))) {
      const receiptPath = path.join(featurePath, "receipts", entry);
      let receipt: Receipt;
      try { receipt = ReceiptSchema.parse(YAML.parse(await fs.readFile(receiptPath, "utf8"))) as Receipt; }
      catch (error) { throw new InvalidReceiptError(`${receiptPath}: ${String((error as Error).message)}`); }
      this.validateReceiptReferences(featurePath, receipt);
    }
  }

  private validateReceiptReferences(featurePath: string, receipt: Receipt): void {
    const manifestPath = path.resolve(featurePath, receipt.feature.manifestPath);
    if (!isWithin(featurePath, manifestPath) || !fssync.existsSync(manifestPath)) throw new InvalidReceiptError(`Missing manifest reference: ${receipt.feature.manifestPath}`);
    const refs: string[] = [];
    if (receipt.kind === "verification") refs.push(...(receipt.evidence ?? []).flatMap((item) => item.ref ? [item.ref] : []));
    if (receipt.kind === "execution") refs.push(...(receipt.artifacts ?? []));
    for (const ref of refs) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) continue;
      const resolved = path.resolve(featurePath, ref);
      if (!isWithin(featurePath, resolved) || !fssync.existsSync(resolved)) throw new InvalidReceiptError(`Invalid local receipt reference: ${ref}`);
    }
  }

  private async hasApprovedReviewReceipt(feature: Feature): Promise<boolean> {
    const receipts = await this.listReceipts(feature.id);
    return receipts.some((receipt) => receipt.kind === "review" && receipt.decision === "approved");
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
        research: (await exists(path.join(featurePath, "research.md"))) ? path.join(featurePath, "research.md") : undefined,
        receiptsDirectory: (await exists(path.join(featurePath, "receipts"))) ? path.join(featurePath, "receipts") : undefined
      }
    };
  }

  private async readDraft(draftPath: string): Promise<Draft> {
    const draftFile = path.join(draftPath, "draft.md");
    const raw = await fs.readFile(draftFile, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) throw new InvalidDraftError(`Missing frontmatter in ${draftFile}`);
    let frontmatter: DraftFrontmatter;
    try { frontmatter = DraftSchema.parse(YAML.parse(match[1]!)) as DraftFrontmatter; }
    catch (error) { throw new InvalidDraftError(`Invalid Draft frontmatter in ${draftFile}: ${String((error as Error).message)}`); }
    return { id: frontmatter.id, slug: path.basename(draftPath), path: draftPath, frontmatter, body: match[2]!.trim() };
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

  private async writeInboxItem(item: InboxItem): Promise<void> {
    await this.writeFileAtomic(item.path, this.renderInbox(item));
  }

  private renderDraft(frontmatter: DraftFrontmatter, originalText: string): string {
    return `---\n${YAML.stringify(frontmatter)}---\n\n# Contexto original\n\n${originalText.trim()}\n\n## Notas de definición\n\n<!-- Decisiones, enlaces de investigación y detalles no contractuales. -->\n`;
  }

  private parsePromotableDraft(draft: Draft): DraftFrontmatter {
    const parsed = DraftSchema.safeParse(draft.frontmatter);
    if (!parsed.success) throw new InvalidDraftError(`Invalid Draft ${draft.id}: ${parsed.error.message}`);
    const frontmatter = parsed.data as DraftFrontmatter;
    if (!frontmatter.title.trim() || !frontmatter.goal.trim() || !frontmatter.acceptance.some((criterion) => criterion.trim())) {
      throw new InvalidDraftError(`Draft is incomplete and cannot be promoted: ${draft.id}`);
    }
    return frontmatter;
  }

  private async featureIdExists(id: string): Promise<boolean> {
    for (const feature of await this.listFeatures()) if (feature.id === id) return true;
    return false;
  }

  private async countDirectories(directory: string): Promise<number> {
    let count = 0;
    for (const entry of await safeReaddir(directory)) {
      if ((await fs.stat(path.join(directory, entry))).isDirectory()) count++;
    }
    return count;
  }

  private renderInbox(item: InboxItem): string {
    const fm: Record<string, unknown> = { id: item.id, source: item.source, created: item.created, status: item.status };
    if (item.draftRef) fm.draftRef = item.draftRef;
    if (item.featureRef) fm.featureRef = item.featureRef;
    return `---\n${YAML.stringify(fm)}---\n\n# ${item.title}\n${item.body ? `\n${item.body}\n` : ""}`;
  }

  private async ensureGitignoreRuntime(): Promise<void> {
    const gitignore = path.join(this.root, ".gitignore");
    const line = ".forgium/runtime/";
    const current = await fs.readFile(gitignore, "utf8").catch(() => "");
    if (!current.split(/\r?\n/).includes(line)) await fs.appendFile(gitignore, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${line}\n`);
  }

  private async writeFileAtomic(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, content, "utf8");
      await fs.rename(tmp, filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }
}

async function exists(filePath: string): Promise<boolean> { try { await fs.access(filePath); return true; } catch { return false; } }
async function safeReaddir(dir: string): Promise<string[]> { try { return await fs.readdir(dir); } catch { return []; } }
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function redactOutput(output: string): string {
  const redacted = output
    .replace(/(authorization\s*:\s*|bearer\s+|token\s*=\s*|password\s*=\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .trim();
  return redacted.length > MAX_OUTPUT_SUMMARY_LENGTH ? `${redacted.slice(0, MAX_OUTPUT_SUMMARY_LENGTH)}…` : redacted;
}
