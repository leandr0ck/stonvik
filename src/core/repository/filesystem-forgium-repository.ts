import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import type { CaptureInput, ClarificationField, Classification, CreateFeatureInput, ExecutionProfile, Feature, FeatureManifest, FeatureState, InboxItem, Receipt, ReceiptEvidence, RepositoryStatus, ReviewDecision, RunEvent, ValidationReport, VerificationReceipt } from "../domain/types.js";
import { FEATURE_STATES } from "../domain/types.js";
import { FeatureAlreadyExistsError, FeatureNotFoundError, FeatureStateConflictError, ForgiumNotInitializedError, InvalidInboxItemError, InvalidManifestError, InvalidReceiptError, InvalidStateTransitionError, LoopAlreadyRunningError, ReceiptAlreadyExistsError, ReviewReceiptRequiredError } from "../errors/forgium-errors.js";
import { InboxFrontmatterSchema } from "../schemas/inbox.schema.js";
import { ManifestSchema } from "../schemas/manifest.schema.js";
import { ReceiptSchema } from "../schemas/receipt.schema.js";
import { DefinitionDocumentSchema, DefinitionMetadataSchema } from "../schemas/definition.schema.js";
import { ClassificationReceiptSchema } from "../schemas/classification-receipt.schema.js";
import { RunEventSchema } from "../schemas/run-event.schema.js";
import { isoNow, shortId, slugify, timestampForFile } from "../services/id.js";
import { validateClassification } from "../services/classification.js";
import { specFlowCommandsForSpec } from "../services/spec-flow-commands.js";
import { canTransition } from "../transitions/transition-rules.js";
import { forgiumPaths } from "./paths.js";
import type { ExecutionOutcome, ExecutionResult } from "../execution/execution-adapter.js";
import { ExecutionAdapterRegistry } from "../execution/execution-adapter.js";

const exec = promisify(execCallback);
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_SUMMARY_LENGTH = 2_000;
type RepositoryEventCallback = (event: Omit<RunEvent, "at">, options?: { durable?: boolean }) => Promise<void> | void;

export class FilesystemForgiumRepository {
  private readonly paths;
  private readonly eventStreams = new Map<string, { eventIds: Set<string>; lastSequence: number }>();
  private readonly eventWrites = new Map<string, Promise<void>>();
  constructor(public readonly root: string) { this.paths = forgiumPaths(root); }

  async init(): Promise<void> {
    for (const dir of this.paths.createdDirs) await fs.mkdir(dir, { recursive: true });
    await this.ensureGitignoreRuntime();
  }

  async acquireLoopLease(runId: string): Promise<() => Promise<void>> {
    await this.assertInitialized();
    await fs.mkdir(this.paths.runtime, { recursive: true });
    const lockPath = path.join(this.paths.runtime, "run-loop.lock");
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ runId, pid: process.pid, host: os.hostname(), acquiredAt: isoNow() }, null, 2));
      await handle.close();
      return async () => { await fs.rm(lockPath, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        let stale = false;
        try {
          const current = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: number; acquiredAt?: string };
          const age = current.acquiredAt ? Date.now() - Date.parse(current.acquiredAt) : Number.POSITIVE_INFINITY;
          let alive = false;
          if (typeof current.pid === "number") { try { process.kill(current.pid, 0); alive = true; } catch { alive = false; } }
          stale = !alive || age > 24 * 60 * 60 * 1000;
        } catch { stale = true; }
        if (stale) { await fs.rm(lockPath, { force: true }); return this.acquireLoopLease(runId); }
        throw new LoopAlreadyRunningError();
      }
      throw error;
    }
  }

  async persistEvent(event: RunEvent): Promise<void> {
    const parsed = RunEventSchema.parse(event) as RunEvent;
    const eventPath = path.join(this.paths.events, event.at.slice(0, 10), `${encodeURIComponent(event.runId ?? "legacy")}.ndjson`);
    const previous = this.eventWrites.get(eventPath) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(eventPath), { recursive: true });
      const stream = await this.eventStream(eventPath);
      this.validateEventAppend(parsed, stream);
      await fs.appendFile(eventPath, `${JSON.stringify(parsed)}\n`, "utf8");
      this.recordEventAppend(parsed, stream);
    });
    this.eventWrites.set(eventPath, write);
    try {
      await write;
    } finally {
      if (this.eventWrites.get(eventPath) === write) this.eventWrites.delete(eventPath);
    }
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

  async deferInbox(id: string): Promise<InboxItem> {
    const item = await this.requireInbox(id);
    return this.deferInboxItem(item);
  }

  async deferInboxItem(item: InboxItem): Promise<InboxItem> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id || current.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${item.id}`);
    const deferred = { ...current, status: "deferred" as const };
    await this.writeInboxItem(deferred);
    return deferred;
  }

  async requestInboxClarification(id: string, field: ClarificationField): Promise<InboxItem> {
    const item = await this.requireInbox(id);
    return this.requestInboxClarificationItem(item, field);
  }

  async requestInboxClarificationItem(item: InboxItem, field: ClarificationField): Promise<InboxItem> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id || current.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${item.id}`);
    const pending = { ...current, status: "needs_clarification" as const, clarification: { field } };
    await this.writeInboxItem(pending);
    return pending;
  }

  async answerInboxClarification(id: string, answer: string): Promise<InboxItem> {
    const item = await this.requireInbox(id);
    return this.answerInboxClarificationItem(item, answer);
  }

  async answerInboxClarificationItem(item: InboxItem, answer: string): Promise<InboxItem> {
    const current = await this.readInboxFile(item.path);
    const normalized = answer.trim();
    if (current.id !== item.id || current.status !== "needs_clarification" || !current.clarification || !normalized) throw new InvalidInboxItemError(`Inbox item does not have a pending clarification: ${item.id}`);
    const answered = { ...current, status: "captured" as const, clarification: { ...current.clarification, answer: normalized } };
    await this.writeInboxItem(answered);
    return answered;
  }

  async rejectInbox(id: string): Promise<InboxItem> {
    const item = await this.requireInbox(id);
    return this.rejectInboxItem(item);
  }

  async rejectInboxItem(item: InboxItem): Promise<InboxItem> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id || current.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${item.id}`);
    const rejected = { ...current, status: "rejected" as const };
    await this.writeInboxItem(rejected);
    return rejected;
  }

  async requireDefinitionForInbox(id: string, kind: "spec" | "adr", legacyReference = false): Promise<InboxItem> {
    const item = await this.requireInbox(id);
    return this.requireDefinitionForInboxItem(item, kind, legacyReference);
  }

  async requireDefinitionForInboxItem(item: InboxItem, kind: "spec" | "adr", legacyReference = false): Promise<InboxItem> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id || current.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${item.id}`);
    const slug = `${slugify(current.title)}-${current.id.slice(-5)}`;
    const definitionDir = this.paths.definitionDir(slug);
    const definitionPath = path.join(definitionDir, kind === "spec" ? "spec.md" : "adr.md");
    if (await exists(definitionDir)) throw new InvalidInboxItemError(`Definition already exists: ${path.relative(this.root, definitionDir)}`);
    await fs.mkdir(definitionDir, { recursive: false });
    try {
      await this.writeFileAtomic(path.join(definitionDir, "definition.yaml"), YAML.stringify({ schemaVersion: 1, inboxRef: current.id, kind, created: isoNow(), document: path.basename(definitionPath) }));
      await this.writeFileAtomic(definitionPath, this.renderDefinitionTemplate(current, kind));
    } catch (error) {
      await fs.rm(definitionDir, { recursive: true, force: true });
      throw error;
    }
    let referencePath = definitionPath;
    if (legacyReference) {
      referencePath = path.join(kind === "spec" ? this.paths.specs : this.paths.adrs, `${slug}.md`);
      await this.writeFileAtomic(referencePath, await fs.readFile(definitionPath, "utf8"));
    }
    const needsDefinition = { ...current, status: "needs_definition" as const, definitionRef: path.relative(this.root, referencePath), definitionKind: kind };
    await this.writeInboxItem(needsDefinition);
    return needsDefinition;
  }

  async confirmDefinitionForInbox(id: string): Promise<Feature> {
    const item = await this.requireInbox(id);
    return this.confirmDefinitionForInboxItem(item);
  }

  async confirmDefinitionForInboxItem(item: InboxItem): Promise<Feature> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id || current.status !== "needs_definition" || !current.definitionRef || !current.definitionKind) throw new InvalidInboxItemError(`Inbox item does not require a definition: ${item.id}`);
    const referencedPath = path.resolve(this.root, current.definitionRef);
    const internalDir = this.paths.definitionDir(`${slugify(current.title)}-${current.id.slice(-5)}`);
    const allowedReference = isWithin(this.paths.definitions, referencedPath)
      || isWithin(current.definitionKind === "spec" ? this.paths.specs : this.paths.adrs, referencedPath);
    const documentPath = referencedPath;
    if (!allowedReference) throw new InvalidInboxItemError(`Definition path is outside the definition tree: ${current.definitionRef}`);
    if (!(await exists(documentPath)) || !(await exists(internalDir))) throw new InvalidInboxItemError(`Definition is missing: ${current.definitionRef}`);
    const metadataPath = path.join(internalDir, "definition.yaml");
    const metadata = DefinitionMetadataSchema.safeParse(YAML.parse(await fs.readFile(metadataPath, "utf8")));
    if (!metadata.success || metadata.data.inboxRef !== current.id || metadata.data.kind !== current.definitionKind || (metadata.data.document !== path.basename(documentPath) && metadata.data.document !== (current.definitionKind === "spec" ? "spec.md" : "adr.md"))) throw new InvalidInboxItemError(`Definition metadata is invalid: ${current.definitionRef}`);
    const definition = await this.readDefinitionWorkDefinition(documentPath, current);
    return this.createFeatureFromInboxItem(current, definition);
  }

  async mergeInbox(id: string, featureId: string): Promise<InboxItem> {
    const item = await this.requireInbox(id);
    if (item.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${id}`);
    const feature = await this.getFeature(featureId);
    if (!feature) throw new FeatureNotFoundError(featureId);
    return this.moveInboxProvenance(item, feature, "merged");
  }

  async createFeature(input: CreateFeatureInput): Promise<Feature> {
    await this.assertInitialized();
    const slug = input.slug ? slugify(input.slug) : slugify(input.title);
    const id = input.id ?? `feature-${slug}`;
    const featurePath = this.paths.featureDir("ready", slug);
    if (await this.featureIdExists(id) || await exists(featurePath)) throw new FeatureAlreadyExistsError(id);
    const manifest: FeatureManifest = {
      schemaVersion: 1,
      id,
      title: input.title,
      created: isoNow(),
      source: input.source,
      goal: input.goal,
      acceptance: input.acceptance,
      constraints: input.constraints,
      verification: input.verification,
      classification: input.classification,
    };
    try {
      if (manifest.classification) validateClassification(manifest.classification);
    } catch (error) {
      throw new InvalidManifestError(`Invalid classification: ${String((error as Error).message)}`);
    }
    const parsed = ManifestSchema.safeParse(manifest);
    if (!parsed.success) throw new InvalidManifestError(parsed.error.message);
    const staging = path.join(this.paths.featureStateDir("ready"), `.creating-${slug}-${process.pid}-${shortId()}`);
    await fs.mkdir(staging, { recursive: false });
    try {
      await this.writeFileAtomic(path.join(staging, "manifest.yaml"), YAML.stringify(manifest));
      await fs.rename(staging, featurePath);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return this.readFeature(featurePath, "ready");
  }

  async recordClassification(item: InboxItem, classification: Classification, runId: string): Promise<void> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id) throw new InvalidInboxItemError(`Inbox item does not match its path: ${item.id}`);
    if (current.status !== "captured" && current.status !== "needs_definition") {
      throw new InvalidInboxItemError(`Inbox item is already attached or closed: ${item.id}`);
    }
    let parsed: Classification;
    try { parsed = validateClassification(classification); }
    catch (error) { throw new InvalidInboxItemError(`Invalid classification: ${String((error as Error).message)}`); }
    await fs.mkdir(this.paths.inboxReceipts, { recursive: true });
    const receipt = { schemaVersion: 1 as const, kind: "classification" as const, inboxId: current.id, runId, created: isoNow(), outcome: "classified" as const, classification: parsed };
    ClassificationReceiptSchema.parse(receipt);
    const baseName = `${item.id}-${runId}`;
    const preferredPath = path.join(this.paths.inboxReceipts, `${baseName}.yaml`);
    const receiptPath = await exists(preferredPath) ? path.join(this.paths.inboxReceipts, `${baseName}-${shortId()}.yaml`) : preferredPath;
    await this.writeFileAtomic(receiptPath, YAML.stringify(receipt));
  }

  async createFeatureFromInbox(inboxId: string, input: Omit<CreateFeatureInput, "source">): Promise<Feature> {
    const item = await this.requireInbox(inboxId);
    return this.createFeatureFromInboxItem(item, input);
  }

  async createFeatureFromInboxItem(item: InboxItem, input: Omit<CreateFeatureInput, "source">): Promise<Feature> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id || (current.status !== "captured" && current.status !== "needs_definition")) throw new InvalidInboxItemError(`Inbox item cannot create Work: ${item.id}`);
    const feature = await this.createFeature({ ...input, source: { type: "inbox", ref: current.id } });
    try {
      await this.moveInboxProvenance(current, feature, "promoted");
    } catch (error) {
      await fs.rm(feature.path, { recursive: true, force: true });
      throw error;
    }
    return feature;
  }

  async migrateInboxProvenance(): Promise<{ migrated: string[]; skipped: Array<{ inboxId: string; reason: string }> }> {
    await this.assertInitialized();
    const migrated: string[] = [];
    const skipped: Array<{ inboxId: string; reason: string }> = [];
    for (const item of await this.listInbox()) {
      if ((item.status !== "promoted" && item.status !== "merged") || !item.featureRef) continue;
      const feature = await this.getFeature(item.featureRef);
      if (!feature) {
        skipped.push({ inboxId: item.id, reason: `Referenced Work does not exist: ${item.featureRef}` });
        continue;
      }
      await this.moveInboxProvenance(item, feature, item.status);
      migrated.push(item.id);
    }
    return { migrated, skipped };
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

  async verifyFeature(id: string, options: { evidence?: ReceiptEvidence[]; runId?: string; onEvent?: RepositoryEventCallback } = {}): Promise<VerificationReceipt> {
    const feature = await this.requireFeature(id);
    await options.onEvent?.({ type: "status", kind: "verification.started", phase: "verification", workId: feature.id, message: `Verification started for ${feature.id}.` });
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
          await options.onEvent?.({ type: "status", kind: "verification.check.finished", phase: "verification", workId: feature.id, message: `Verification check ${command.name} passed.`, elapsedMs: Date.now() - started });
        } catch (error) {
          const commandError = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
          checks.push({ name: command.name, command: command.run, cwd: ".", exitCode: typeof commandError.code === "number" ? commandError.code : null, durationMs: Date.now() - started, status: commandError.killed ? "cancelled" : "failed", outputSummary: redactOutput(`${commandError.stdout ?? ""}${commandError.stderr ?? ""}`) });
          await options.onEvent?.({ type: "status", kind: "verification.check.finished", phase: "verification", severity: commandError.killed ? "warning" : "error", workId: feature.id, message: `Verification check ${command.name} ${commandError.killed ? "was cancelled" : "failed"}.`, elapsedMs: Date.now() - started });
        }
      }
      evidence = policy.requiredEvidence?.map((required) => options.evidence?.find((candidate) => candidate.criterion === required.criterion && candidate.kind === required.kind) ?? { ...required, status: "pending" as const });
      if (checks.some((check) => check.status === "cancelled")) outcome = "cancelled";
      else if (checks.some((check) => check.status === "failed")) outcome = "failed";
      else if (evidence?.some((item) => item.status !== "passed")) outcome = "manual_required";
      else outcome = "passed";
    }

    const receipt = this.createVerificationReceipt(feature, runId, outcome, checks, evidence);
    await options.onEvent?.({ type: outcome === "passed" ? "receipt" : "gate", kind: "verification.finished", phase: "verification", severity: outcome === "passed" ? "info" : "error", workId: feature.id, message: `Verification finished with outcome ${outcome}.`, nextAction: outcome === "passed" ? "Continue to independent review." : "Inspect verification evidence before retrying." });
    await this.persistReceipt(feature, receipt);
    if (outcome === "failed" || outcome === "cancelled" || outcome === "manual_required") {
      await this.persistReceipt(feature, this.createHandoffReceipt(feature, runId, outcome === "cancelled" ? "cancelled" : "failed", receipt.id, receipt.summary));
    } else {
      await this.transition(id, "review");
    }
    return receipt;
  }

  async reviewFeature(id: string, decision: ReviewDecision, summary: string, actorName = "forgium", findings?: string[], runId?: string): Promise<Feature> {
    const feature = await this.requireFeature(id);
    if (feature.state !== "review") throw new InvalidStateTransitionError(feature.state, "review");
    await this.persistReceipt(feature, this.createReviewReceipt(feature, decision, summary, actorName, findings, runId));
    if (decision === "needs_human") return feature;
    return this.transition(id, decision === "approved" ? "done" : decision === "changes_requested" ? "doing" : "blocked");
  }

  async executeFeature(id: string, registry: ExecutionAdapterRegistry, signal?: AbortSignal, options: { runId?: string; onEvent?: RepositoryEventCallback } = {}): Promise<{ outcome: ExecutionOutcome | "needs_human"; feature: Feature; summary: string; adapterId?: string; details?: Record<string, unknown> }> {
    const current = await this.requireFeature(id);
    if (current.state !== "ready" && current.state !== "doing") throw new InvalidStateTransitionError(current.state, "doing");
    const profile = await this.inspectExecutionMode(id);
    const runId = options.runId ?? `run-${timestampForFile()}-${shortId()}`;
    const request = { root: this.root, feature: current, profile, runId, permissions: "repository" as const, allowedPaths: ["source files and tests; never product/, features/, or .forgium/"], signal };
    const adapter = await registry.resolve(request);
    if (!adapter) return { outcome: "needs_human", feature: current, summary: "No execution adapter is available for this Feature." };

    const doing = current.state === "ready" ? await this.startFeature(id) : current;
    if (current.state === "ready") await options.onEvent?.({ type: "transition", kind: "work.transitioned", phase: "execution", workId: doing.id, state: "doing", message: `Work ${doing.id} transitioned to doing.` });
    const activeProfile = await this.inspectExecutionMode(id);
    const fingerprint = await this.durableFeatureFingerprint(id);
    let result: ExecutionResult;
    try {
      result = await adapter.execute({
        ...request,
        feature: doing,
        profile: activeProfile,
        onProgress: async (progress) => options.onEvent?.({
          type: "status",
          kind: progress.kind,
          phase: progress.phase,
          severity: progress.severity,
          workId: doing.id,
          message: progress.message,
          elapsedMs: progress.elapsedMs,
        }, { durable: progress.durable === true }),
      });
    } catch (error) {
      result = { outcome: "needs_human", summary: "Execution adapter failed before returning a structured result.", reason: String((error as Error).message) };
    }
    result.details = { ...(result.details ?? {}), featureFingerprint: fingerprint };
    await this.persistReceipt(doing, this.createExecutionReceipt(doing, runId, adapter.id, result));
    if (result.outcome === "completed") {
      const verification = await this.verifyFeature(id, { runId, onEvent: options.onEvent });
      return { outcome: verification.outcome === "passed" ? result.outcome : verification.outcome === "manual_required" ? "needs_human" : "verification_failed", feature: (await this.requireFeature(id)), summary: result.summary, adapterId: adapter.id, details: result.details };
    }
    if (result.outcome === "blocked") {
      const blocked = await this.transition(id, "blocked");
      await this.persistReceipt(blocked, this.createHandoffReceipt(blocked, runId, result.outcome, undefined, result.reason ?? result.summary));
      return { outcome: result.outcome, feature: blocked, summary: result.summary, adapterId: adapter.id, details: result.details };
    }
    if (result.outcome === "needs_human") {
      await this.persistReceipt(doing, this.createHandoffReceipt(doing, runId, "needs_human", undefined, result.reason ?? result.summary));
      return { outcome: result.outcome, feature: doing, summary: result.summary, adapterId: adapter.id, details: result.details };
    }
    if (result.outcome === "verification_failed") {
      await this.persistReceipt(doing, this.createHandoffReceipt(doing, runId, "failed", undefined, result.reason ?? result.summary));
    } else {
      await this.persistReceipt(doing, this.createHandoffReceipt(doing, runId, "cancelled", undefined, result.reason ?? result.summary));
    }
    return { outcome: result.outcome, feature: await this.requireFeature(id), summary: result.summary, adapterId: adapter.id, details: result.details };
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

  async getActiveFeatures(): Promise<Feature[]> { return (await this.listFeatures()).filter((feature) => feature.state === "doing" || feature.state === "review"); }

  async durableFeatureFingerprint(id: string): Promise<string> {
    const feature = await this.requireFeature(id);
    const parts: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of (await safeReaddir(directory)).sort()) {
        if (entry === "receipts") continue;
        const full = path.join(directory, entry);
        const stat = await fs.stat(full).catch(() => undefined);
        if (!stat) continue;
        if (stat.isDirectory()) await walk(full);
        else parts.push(`${path.relative(feature.path, full)}:${stat.size}:${stat.mtimeMs}`);
      }
    };
    await walk(feature.path);
    return parts.join("|");
  }

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
    const inbox: Record<string, number> = { captured: 0, needs_definition: 0, promoted: 0, merged: 0, deferred: 0, rejected: 0 };
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
    for (const file of (await safeReaddir(this.paths.inboxReceipts)).filter((e) => e.endsWith(".yaml"))) {
      try { ClassificationReceiptSchema.parse(YAML.parse(await fs.readFile(path.join(this.paths.inboxReceipts, file), "utf8"))); }
      catch (error) { issues.push({ severity: "error", code: "INVALID_CLASSIFICATION_RECEIPT", message: String((error as Error).message), path: path.join(this.paths.inboxReceipts, file) }); }
    }
    for (const file of await recursiveFiles(this.paths.events, (entry) => entry.endsWith(".ndjson"))) {
      try {
        const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
        const seenIds = new Set<string>();
        const lastSequence = new Map<string, number>();
        for (const line of lines) {
          const event = RunEventSchema.parse(JSON.parse(line)) as RunEvent;
          if (event.schemaVersion !== 2) continue;
          const eventId = event.eventId!;
          const runId = event.runId!;
          const sequence = event.sequence!;
          if (seenIds.has(eventId)) throw new Error(`Duplicate run event ID: ${eventId}`);
          seenIds.add(eventId);
          const previous = lastSequence.get(runId) ?? 0;
          if (sequence <= previous) throw new Error(`Run event sequence is not increasing for ${runId}.`);
          lastSequence.set(runId, sequence);
        }
      } catch (error) { issues.push({ severity: "error", code: "INVALID_RUN_EVENT", message: String((error as Error).message), path: file }); }
    }
    for (const entry of await safeReaddir(this.paths.definitions)) {
      const definitionDir = this.paths.definitionDir(entry);
      try {
        const metadata = DefinitionMetadataSchema.parse(YAML.parse(await fs.readFile(path.join(definitionDir, "definition.yaml"), "utf8")));
        const documentPath = path.join(definitionDir, metadata.document);
        if (!isWithin(definitionDir, documentPath) || !(await exists(documentPath))) throw new Error("Definition document is missing.");
      } catch (error) { issues.push({ severity: "error", code: "INVALID_DEFINITION", message: String((error as Error).message), path: definitionDir }); }
    }
    for (const state of FEATURE_STATES) {
      for (const entry of await safeReaddir(this.paths.featureStateDir(state))) {
        const full = this.paths.featureDir(state, entry);
        if (!(await fs.stat(full)).isDirectory()) continue;
        let feature: Feature | undefined;
        try { feature = await this.readFeature(full, state); } catch (error) { issues.push({ severity: "error", code: "INVALID_FEATURE", message: String((error as Error).message), path: full }); }
        try { await this.validateReceiptFiles(full); } catch (error) { issues.push({ severity: "error", code: "INVALID_RECEIPT", message: String((error as Error).message), path: full }); }
        if (feature) {
          try { await this.validateInboxProvenance(feature); } catch (error) { issues.push({ severity: "error", code: "INVALID_INBOX_PROVENANCE", message: String((error as Error).message), path: full }); }
        }
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

  private async featureIdExists(id: string): Promise<boolean> {
    for (const feature of await this.listFeatures()) if (feature.id === id) return true;
    return false;
  }

  private async requireInbox(id: string): Promise<InboxItem> {
    const item = (await this.listInbox()).find((candidate) => candidate.id === id);
    if (!item) throw new InvalidInboxItemError(`Inbox item not found: ${id}`);
    return item;
  }

  private provenanceInboxDir(featurePath: string): string { return path.join(featurePath, "provenance", "inbox"); }
  private provenanceClassificationDir(featurePath: string): string { return path.join(featurePath, "provenance", "classification"); }

  private async moveInboxProvenance(item: InboxItem, feature: Feature, status: "promoted" | "merged"): Promise<InboxItem> {
    const original = await fs.readFile(item.path, "utf8");
    const inboxPath = path.join(this.provenanceInboxDir(feature.path), path.basename(item.path));
    const receiptPaths = await this.classificationReceiptPaths(item.id);
    const receiptDestination = this.provenanceClassificationDir(feature.path);
    const movedReceipts: Array<{ from: string; to: string }> = [];
    if (await exists(inboxPath)) throw new InvalidInboxItemError(`Inbox provenance already exists: ${path.relative(this.root, inboxPath)}`);
    for (const receiptPath of receiptPaths) {
      const destination = path.join(receiptDestination, path.basename(receiptPath));
      if (await exists(destination)) throw new InvalidInboxItemError(`Classification provenance already exists: ${path.relative(this.root, destination)}`);
      movedReceipts.push({ from: receiptPath, to: destination });
    }

    const moved = { ...item, status, featureRef: feature.id, path: inboxPath };
    try {
      await fs.mkdir(path.dirname(inboxPath), { recursive: true });
      await fs.rename(item.path, inboxPath);
      await this.writeInboxItem(moved);
      await fs.mkdir(receiptDestination, { recursive: true });
      for (const receipt of movedReceipts) await fs.rename(receipt.from, receipt.to);
      return moved;
    } catch (error) {
      for (const receipt of [...movedReceipts].reverse()) {
        if (await exists(receipt.to)) await fs.rename(receipt.to, receipt.from);
      }
      if (await exists(inboxPath)) await fs.rm(inboxPath, { force: true });
      if (!(await exists(item.path))) await this.writeFileAtomic(item.path, original);
      throw error;
    }
  }

  private async classificationReceiptPaths(inboxId: string): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of (await safeReaddir(this.paths.inboxReceipts)).filter((name) => name.endsWith(".yaml"))) {
      const receiptPath = path.join(this.paths.inboxReceipts, entry);
      if (entry.startsWith(`${inboxId}-`)) {
        paths.push(receiptPath);
        continue;
      }
      try {
        const receipt = ClassificationReceiptSchema.parse(YAML.parse(await fs.readFile(receiptPath, "utf8")));
        if (receipt.inboxId === inboxId) paths.push(receiptPath);
      } catch {
        // Invalid unrelated receipts remain in the global directory for validate().
      }
    }
    return paths;
  }

  private async validateInboxProvenance(feature: Feature): Promise<void> {
    const inboxIds = new Set<string>();
    for (const entry of (await safeReaddir(this.provenanceInboxDir(feature.path))).filter((name) => name.endsWith(".md"))) {
      const item = await this.readInboxFile(path.join(this.provenanceInboxDir(feature.path), entry));
      if ((item.status !== "promoted" && item.status !== "merged") || item.featureRef !== feature.id) {
        throw new InvalidInboxItemError(`Inbox provenance ${item.id} does not reference Work ${feature.id}.`);
      }
      inboxIds.add(item.id);
    }
    for (const entry of (await safeReaddir(this.provenanceClassificationDir(feature.path))).filter((name) => name.endsWith(".yaml"))) {
      const receipt = ClassificationReceiptSchema.parse(YAML.parse(await fs.readFile(path.join(this.provenanceClassificationDir(feature.path), entry), "utf8")));
      if (!inboxIds.has(receipt.inboxId)) throw new InvalidInboxItemError(`Classification provenance references unattached Inbox item: ${receipt.inboxId}`);
    }
  }

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

  private createReviewReceipt(feature: Feature, decision: ReviewDecision, summary: string, actorName: string, findings?: string[], runId?: string): Receipt {
    return {
      ...this.receiptBase(feature, "review", decision, summary, runId ?? `review-${timestampForFile()}-${shortId()}`, "reviewer", actorName),
      kind: "review",
      outcome: decision,
      decision,
      findings: findings?.length ? findings : undefined,
    };
  }

  private createExecutionReceipt(feature: Feature, runId: string, engine: string, result: ExecutionResult): Receipt {
    return {
      ...this.receiptBase(feature, "execution", result.outcome, result.summary, runId, "executor", engine),
      kind: "execution",
      outcome: result.outcome,
      engine,
      artifacts: result.artifacts,
      details: result.details,
    };
  }

  private createHandoffReceipt(feature: Feature, runId: string, outcome: "failed" | "blocked" | "needs_human" | "cancelled", relatedReceipt: string | undefined, reason: string): Receipt {
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

  private renderInbox(item: InboxItem): string {
    const fm: Record<string, unknown> = { id: item.id, source: item.source, created: item.created, status: item.status };
    if (item.definitionRef) fm.definitionRef = item.definitionRef;
    if (item.definitionKind) fm.definitionKind = item.definitionKind;
    if (item.featureRef) fm.featureRef = item.featureRef;
    if (item.clarification) fm.clarification = item.clarification;
    return `---\n${YAML.stringify(fm)}---\n\n# ${item.title}\n${item.body ? `\n${item.body}\n` : ""}`;
  }

  private renderDefinitionTemplate(item: InboxItem, kind: "spec" | "adr"): string {
    return `---\n${YAML.stringify({
      forgium: {
        schemaVersion: 1,
        source: { type: "inbox", ref: item.id },
        title: item.title,
        goal: "",
        acceptance: [],
        constraints: [],
        verification: { commands: [], requiredEvidence: [] },
      },
    })}---\n\n# ${kind === "spec" ? "Technical Spec" : "Architecture Decision"} — ${item.title}\n\n## Context\n\n${item.body ?? item.title}\n\n## Decisions\n\n${kind === "spec" ? "## Implementation slices\n" : "## Consequences\n"}`;
  }

  private async readDefinitionWorkDefinition(definitionPath: string, item: InboxItem): Promise<Omit<CreateFeatureInput, "source">> {
    const raw = await fs.readFile(definitionPath, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?[\s\S]*$/);
    if (!match) throw new InvalidInboxItemError(`Definition is missing frontmatter: ${item.definitionRef}`);
    const parsed = YAML.parse(match[1]!) as { forgium?: Partial<CreateFeatureInput> & { schemaVersion?: number; source?: { type?: string; ref?: string } } };
    const definition = parsed.forgium;
    if (!definition || definition.schemaVersion !== 1 || definition.source?.type !== "inbox" || definition.source.ref !== item.id) {
      throw new InvalidInboxItemError(`Definition does not reference Inbox item: ${item.id}`);
    }
    if (typeof definition.title !== "string" || typeof definition.goal !== "string" || !Array.isArray(definition.acceptance) || !definition.verification) {
      throw new InvalidInboxItemError(`Definition has an incomplete Work definition: ${item.definitionRef}`);
    }
    const document = DefinitionDocumentSchema.safeParse({
      schemaVersion: 1,
      inboxRef: item.id,
      kind: item.definitionKind,
      title: definition.title,
      goal: definition.goal,
      acceptance: definition.acceptance,
      verification: definition.verification,
    });
    if (!document.success) throw new InvalidInboxItemError(`Definition has an invalid Work contract: ${document.error.message}`);
    return {
      title: definition.title,
      goal: definition.goal,
      acceptance: definition.acceptance,
      constraints: definition.constraints,
      verification: definition.verification,
      slug: definition.slug,
    };
  }

  private async ensureGitignoreRuntime(): Promise<void> {
    const gitignore = path.join(this.root, ".gitignore");
    const line = ".forgium/runtime/";
    const current = await fs.readFile(gitignore, "utf8").catch(() => "");
    if (!current.split(/\r?\n/).includes(line)) await fs.appendFile(gitignore, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${line}\n`);
  }

  private async eventStream(eventPath: string): Promise<{ eventIds: Set<string>; lastSequence: number }> {
    const existing = this.eventStreams.get(eventPath);
    if (existing) return existing;
    const stream = { eventIds: new Set<string>(), lastSequence: 0 };
    const lines = (await fs.readFile(eventPath, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
    for (const line of lines) this.recordEventAppend(RunEventSchema.parse(JSON.parse(line)) as RunEvent, stream);
    this.eventStreams.set(eventPath, stream);
    return stream;
  }

  private validateEventAppend(event: RunEvent, stream: { eventIds: Set<string>; lastSequence: number }): void {
    if (event.schemaVersion !== 2) return;
    if (stream.eventIds.has(event.eventId!)) throw new Error(`Duplicate run event ID: ${event.eventId}`);
    if (event.sequence! <= stream.lastSequence) throw new Error(`Run event sequence is not increasing for ${event.runId}.`);
  }

  private recordEventAppend(event: RunEvent, stream: { eventIds: Set<string>; lastSequence: number }): void {
    if (event.schemaVersion !== 2) return;
    if (stream.eventIds.has(event.eventId!)) throw new Error(`Duplicate run event ID: ${event.eventId}`);
    if (event.sequence! <= stream.lastSequence) throw new Error(`Run event sequence is not increasing for ${event.runId}.`);
    stream.eventIds.add(event.eventId!);
    stream.lastSequence = event.sequence!;
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
async function recursiveFiles(dir: string, include: (name: string) => boolean): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as fssync.Dirent[]);
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return recursiveFiles(entryPath, include);
    return include(entry.name) ? [entryPath] : [];
  }));
  return files.flat();
}
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
