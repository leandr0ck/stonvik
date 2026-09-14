import fs, { type FileHandle } from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import type { ActorRef, CaptureInput, ClarificationField, Classification, CreateFeatureInput, DefinitionRef, ExecutionProfile, ExternalExecutionEvidence, ExternalExecutionReport, Feature, FeatureManifest, FeatureState, InboxItem, Receipt, ReceiptEvidence, RepositoryStatus, ReviewDecision, RoutingDecision, RoutingPolicy, RunEvent, ValidationReport, VerificationReceipt, WorkHandoff, WorkClaim } from "../domain/types.js";
import { FEATURE_STATES } from "../domain/types.js";
import { ActorInvalidError, FeatureAlreadyExistsError, FeatureNotFoundError, FeatureStateConflictError, StonvikNotInitializedError, InvalidInboxItemError, InvalidManifestError, InvalidReceiptError, InvalidStateTransitionError, LoopAlreadyRunningError, ReceiptAlreadyExistsError, ReviewReceiptRequiredError, WorkClaimConflictError, WorkReportInvalidError, ReviewActorInvalidError, ReviewSelfApprovalError } from "../errors/stonvik-errors.js";
import { InboxFrontmatterSchema } from "../schemas/inbox.schema.js";
import { ManifestSchema } from "../schemas/manifest.schema.js";
import { ReceiptSchema } from "../schemas/receipt.schema.js";
import { DefinitionRefsSchema } from "../schemas/definition.schema.js";
import { ClassificationReceiptSchema } from "../schemas/classification-receipt.schema.js";
import { RunEventSchema } from "../schemas/run-event.schema.js";
import { ActorRefSchema } from "../schemas/actor.schema.js";
import { RoutingDecisionSchema } from "../schemas/routing.schema.js";
import { ExternalExecutionReportSchema } from "../schemas/external-execution-report.schema.js";
import { WorkClaimSchema } from "../schemas/work-claim.schema.js";
import { WorkHandoffSchema } from "../schemas/handoff.schema.js";
import { routingPolicyFromConfig, buildRoutingDecision, validateRoutingDecisionShape, type RoutingSignalOverrides } from "../services/routing.js";
import { createWorkHandoff } from "../services/work-handoff.js";
import { loadCoreConfig } from "../services/config.js";
import { actorKey, sameActor } from "../services/actors.js";
import { isoNow, shortId, slugify, timestampForFile } from "../services/id.js";
import { validateClassification } from "../services/classification.js";
import { canTransition } from "../transitions/transition-rules.js";
import { stonvikPaths } from "./paths.js";
import type { ExecutionOutcome, ExecutionResult } from "../execution/execution-adapter.js";
import { ExecutionAdapterRegistry } from "../execution/execution-adapter.js";

const exec = promisify(execCallback);
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_SUMMARY_LENGTH = 2_000;
type RepositoryEventCallback = (event: Omit<RunEvent, "at">, options?: { durable?: boolean }) => Promise<void> | void;

export class FilesystemStonvikRepository {
  private readonly paths;
  private readonly eventStreams = new Map<string, { eventIds: Set<string>; lastSequence: number }>();
  private readonly eventWrites = new Map<string, Promise<void>>();
  constructor(public readonly root: string) { this.paths = stonvikPaths(root); }

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
    const items: InboxItem[] = [];
    for (const entry of (await safeReaddir(this.paths.inbox)).filter((e) => e.endsWith(".md")).sort()) {
      items.push(await this.readInboxFile(path.join(this.paths.inbox, entry)));
    }
    for (const entry of (await safeReaddir(this.paths.inboxReview)).filter((e) => e.endsWith(".md")).sort()) {
      items.push(await this.readInboxFile(path.join(this.paths.inboxReview, entry)));
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


  async listReview(): Promise<InboxItem[]> {
    await this.assertInitialized();
    const items: InboxItem[] = [];
    for (const entry of (await safeReaddir(this.paths.inboxReview)).filter((e) => e.endsWith(".md")).sort()) {
      items.push(await this.readInboxFile(path.join(this.paths.inboxReview, entry)));
    }
    return items.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  }

  async moveToReview(item: InboxItem, questions: string): Promise<InboxItem> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id) throw new InvalidInboxItemError(`Inbox item does not match: ${item.id}`);
    if (current.status === "needs_review") return current;
    const reviewDir = this.paths.inboxReview;
    await fs.mkdir(reviewDir, { recursive: true });
    const destPath = path.join(reviewDir, path.basename(item.path));
    if (await exists(destPath)) throw new InvalidInboxItemError(`Review item already exists: ${path.relative(this.root, destPath)}`);
    const reviewed = { ...current, status: "needs_review" as const, path: destPath };
    const timestamp = new Date().toISOString();
    const reviewBlock = `\n\n<!-- stonvik:review -->\n> **Stonvik — needs review** (${timestamp})\n${questions.split("\n").map((l) => `> ${l}`).join("\n")}\n`;
    await this.writeFileAtomic(destPath, this.renderInbox(reviewed) + reviewBlock);
    await fs.rm(item.path, { force: true });
    return reviewed;
  }

  async moveReviewToInbox(item: InboxItem): Promise<InboxItem> {
    const current = await this.readInboxFile(item.path);
    if (current.id !== item.id || current.status !== "needs_review") throw new InvalidInboxItemError(`Inbox item is not in review: ${item.id}`);
    const destPath = path.join(this.paths.inbox, path.basename(item.path));
    if (await exists(destPath)) throw new InvalidInboxItemError(`Inbox item already exists: ${path.relative(this.root, destPath)}`);
    const restored = { ...current, status: "captured" as const, path: destPath };
    await this.writeFileAtomic(destPath, this.renderInbox(restored));
    await fs.rm(item.path, { force: true });
    return restored;
  }


  /** Record the triage decision without creating executable Work. */
  async triageInbox(
    inboxId: string,
    options: {
      route: RoutingDecision["route"];
      actor: ActorRef;
      signals?: RoutingSignalOverrides;
      policy?: RoutingPolicy;
    },
  ): Promise<InboxItem> {
    const current = await this.requireInbox(inboxId);
    if (current.status !== "captured") throw new InvalidInboxItemError(`Inbox item is not captured: ${inboxId}`);
    const actor = this.assertActor(options.actor, "triager");
    const config = await loadCoreConfig(this.root);
    const decision = buildRoutingDecision(current, options.route, actor, options.signals, options.policy ?? routingPolicyFromConfig(config));
    const status = options.route === "direct" ? "captured" : "needs_definition";
    const triaged = { ...current, status: status as InboxItem["status"], routingDecision: decision };
    await this.writeInboxItem(triaged);
    return triaged;
  }

  /** Create ready Work from a triaged Inbox item and user-owned definitions. */
  async defineWorkFromInbox(inboxId: string, input: Omit<CreateFeatureInput, "source">): Promise<Feature> {
    const item = await this.requireInbox(inboxId);
    if (item.status !== "captured" && item.status !== "needs_definition") throw new InvalidInboxItemError(`Inbox item cannot be defined: ${inboxId}`);
    const route = item.routingDecision?.route;
    const definitions = input.definitions ?? [];
    if (route && route !== "direct" && !definitions.some((definition) => definition.kind === route)) {
      throw new InvalidInboxItemError(`Triage route ${route} requires a matching user-owned definition.`);
    }
    return this.createFeatureFromInboxItem(item, { ...input, definitions: definitions.length ? definitions : undefined });
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
    let routingDecision: RoutingDecision | undefined;
    try {
      routingDecision = input.routingDecision ? RoutingDecisionSchema.parse(input.routingDecision) as RoutingDecision : undefined;
    } catch (error) {
      throw new InvalidManifestError(`Invalid routing decision: ${String((error as Error).message)}`);
    }
    const routingDecisionRef = routingDecision ? input.routingDecisionRef ?? "routing-decision.yaml" : input.routingDecisionRef;
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
      routingDecision,
      definitions: input.definitions,
      routingDecisionRef,
    };
    try {
      if (manifest.classification) validateClassification(manifest.classification);
      if (manifest.routingDecision) validateRoutingDecisionShape(manifest.routingDecision);
    } catch (error) {
      throw new InvalidManifestError(`Invalid Work metadata: ${String((error as Error).message)}`);
    }
    if (input.definitions !== undefined) {
      const parsedDefinitions = DefinitionRefsSchema.safeParse(input.definitions);
      if (!parsedDefinitions.success) throw new InvalidManifestError(parsedDefinitions.error.message);
      await this.validateDefinitionReferences(input.definitions);
    }
    const parsed = ManifestSchema.safeParse(manifest);
    if (!parsed.success) throw new InvalidManifestError(parsed.error.message);
    const normalizedManifest = parsed.data as FeatureManifest;
    const staging = path.join(this.paths.featureStateDir("ready"), `.creating-${slug}-${process.pid}-${shortId()}`);
    await fs.mkdir(staging, { recursive: false });
    try {
      await this.writeFileAtomic(path.join(staging, "manifest.yaml"), YAML.stringify(normalizedManifest));
      if (routingDecision) {
        const routingRef = routingDecisionRef ?? "routing-decision.yaml";
        const routingPath = path.resolve(staging, routingRef);
        if (!isSafeRepositoryPath(routingRef) || !isWithin(staging, routingPath)) throw new InvalidManifestError("Routing decision reference must stay inside the Work.");
        await this.writeFileAtomic(routingPath, YAML.stringify(routingDecision));
      }
      await fs.rename(staging, featurePath);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return this.readFeature(featurePath, "ready");
  }

  /** Claim ready Work, or resume unclaimed doing Work after a failed/reviewed attempt. */
  async startWork(id: string, actorInput: ActorRef, runId?: string): Promise<Feature> {
    const actor = this.assertActor(actorInput, "implementer");
    const current = await this.requireFeature(id);
    if (current.state !== "ready" && current.state !== "doing") throw new InvalidStateTransitionError(current.state, "doing");
    const claimPath = this.paths.claimPath(current.id);
    if (current.state === "doing") {
      const existing = await this.readWorkClaim(claimPath);
      if (existing) {
        if (isLiveClaim(existing)) {
          if (!sameActor(existing.actor, actor)) throw new WorkClaimConflictError(`Work ${id} is claimed by ${actorKey(existing.actor)}.`);
          return current;
        }
        throw new WorkClaimConflictError(`Work ${id} has a stale claim. Use recovery explicitly before claiming it again.`);
      }
    }

    const claim: WorkClaim = {
      schemaVersion: 1,
      workId: current.id,
      runId: runId ?? `run-${timestampForFile()}-${shortId()}`,
      actor,
      claimedAt: isoNow(),
      host: os.hostname(),
      pid: process.pid,
    };
    WorkClaimSchema.parse(claim);
    await fs.mkdir(this.paths.claims, { recursive: true });
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(claimPath, "wx");
      await handle.writeFile(JSON.stringify(claim, null, 2));
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkClaimConflictError(`Work ${id} is already claimed.`);
      throw error;
    }

    let doing = current;
    let transitioned = false;
    try {
      if (current.state === "ready") {
        doing = await this.transition(id, "doing");
        transitioned = true;
      }
      const receipt = this.createActorExecutionReceipt(doing, claim.runId, actor, "started", `Work claimed by ${actorKey(actor)}.`);
      await this.persistReceipt(doing, receipt);
    } catch (error) {
      await fs.rm(claimPath, { force: true });
      if (transitioned && await exists(doing.path) && !(await exists(current.path))) await fs.rename(doing.path, current.path);
      throw error;
    }
    return doing;
  }

  async getWorkClaim(id: string): Promise<WorkClaim | null> {
    const feature = await this.requireFeature(id);
    const claim = await this.readWorkClaim(this.paths.claimPath(feature.id));
    return claim;
  }

  /** Reclaim a doing Work only after its previous local process is no longer live. */
  async recoverWork(id: string, actorInput: ActorRef, runId?: string): Promise<Feature> {
    const actor = this.assertActor(actorInput, "implementer");
    const feature = await this.requireFeature(id);
    if (feature.state !== "doing") throw new InvalidStateTransitionError(feature.state, "doing");
    const claimPath = this.paths.claimPath(feature.id);
    const previous = await this.readWorkClaim(claimPath);
    const previousRaw = await fs.readFile(claimPath, "utf8").catch(() => undefined);
    if (previous && isLiveClaim(previous) && !sameActor(previous.actor, actor)) {
      throw new WorkClaimConflictError(`Work ${id} is still claimed by ${actorKey(previous.actor)}.`);
    }
    const claim: WorkClaim = {
      schemaVersion: 1,
      workId: feature.id,
      runId: runId ?? `recovery-${timestampForFile()}-${shortId()}`,
      actor,
      claimedAt: isoNow(),
      host: os.hostname(),
      pid: process.pid,
    };
    WorkClaimSchema.parse(claim);
    await this.writeFileAtomic(claimPath, JSON.stringify(claim, null, 2));
    try {
      const receipt = this.createActorExecutionReceipt(feature, claim.runId, actor, "recovered", `Work recovered by ${actorKey(actor)}.`);
      await this.persistReceipt(feature, receipt);
    } catch (error) {
      if (previousRaw !== undefined) await this.writeFileAtomic(claimPath, previousRaw);
      else await fs.rm(claimPath, { force: true });
      throw error;
    }
    return feature;
  }

  async createWorkHandoff(id: string): Promise<WorkHandoff> {
    const feature = await this.requireFeature(id);
    return WorkHandoffSchema.parse(createWorkHandoff(feature)) as WorkHandoff;
  }

  async handoffWork(id: string): Promise<WorkHandoff> {
    return this.createWorkHandoff(id);
  }

  /** Import a result produced by a human, agent, CI job, or local process. */
  async recordExternalExecutionReport(
    id: string,
    reportInput: ExternalExecutionReport,
    options: { runId?: string } = {},
  ): Promise<{ feature: Feature; receipt: Receipt; nextAction: string }> {
    const report = this.parseExternalExecutionReport(reportInput);
    const feature = await this.requireFeature(id);
    if (feature.state !== "doing") throw new WorkReportInvalidError(`Work ${id} must be doing before an execution report is imported.`);
    const claim = await this.readWorkClaim(this.paths.claimPath(feature.id));
    if (claim && !sameActor(claim.actor, report.actor)) throw new WorkClaimConflictError(`Execution report actor ${actorKey(report.actor)} does not match the Work claim owned by ${actorKey(claim.actor)}.`);
    if (claim && options.runId && options.runId !== claim.runId) throw new WorkReportInvalidError(`Execution report run ID does not match the Work claim: ${claim.runId}.`);
    this.validateExternalExecutionReferences(report, feature.path);
    const runId = options.runId ?? claim?.runId ?? `run-${timestampForFile()}-${shortId()}`;
    const execution = this.createActorExecutionReceipt(feature, runId, report.actor, report.outcome, report.summary, report.artifacts, report.evidence, report.details);
    await this.persistReceipt(feature, execution);
    await this.releaseWorkClaim(feature.id);

    if (report.outcome === "blocked") {
      const blocked = await this.transition(id, "blocked");
      await fs.appendFile(path.join(blocked.path, "notes.md"), `\n## Blocked ${isoNow()}\n\n${report.summary.trim()}\n`);
      const handoff = this.createHandoffReceipt(blocked, runId, "blocked", execution.id, report.summary);
      await this.persistReceipt(blocked, handoff);
      return { feature: blocked, receipt: execution, nextAction: `Resolve the blocker for ${id}.` };
    }
    if (report.outcome === "needs_human") {
      const handoff = this.createHandoffReceipt(feature, runId, "needs_human", execution.id, report.summary);
      await this.persistReceipt(feature, handoff);
      return { feature, receipt: execution, nextAction: "Record the required human decision before continuing." };
    }
    if (report.outcome === "cancelled") {
      const handoff = this.createHandoffReceipt(feature, runId, "cancelled", execution.id, report.summary);
      await this.persistReceipt(feature, handoff);
      return { feature, receipt: execution, nextAction: `Recover or restart Work ${id}.` };
    }
    return { feature, receipt: execution, nextAction: `Run \`stonvik verify ${id}\` before requesting independent review.` };
  }

  async reportWork(id: string, report: ExternalExecutionReport, options?: { runId?: string }): Promise<{ feature: Feature; receipt: Receipt; nextAction: string }> {
    return this.recordExternalExecutionReport(id, report, options);
  }

  async importExecutionReport(id: string, report: ExternalExecutionReport, options?: { runId?: string }): Promise<{ feature: Feature; receipt: Receipt; nextAction: string }> {
    return this.recordExternalExecutionReport(id, report, options);
  }

  /** The public verification path requires a completed external execution report. */
  async verifyWork(id: string, options: { evidence?: ReceiptEvidence[]; runId?: string } = {}): Promise<VerificationReceipt> {
    const feature = await this.requireFeature(id);
    const receipts = await this.listReceipts(id);
    const execution = [...receipts].reverse().find((receipt) => receipt.kind === "execution");
    const latestReview = [...receipts].reverse().find((receipt) => receipt.kind === "review");
    if (!execution || execution.outcome !== "completed" || (latestReview?.kind === "review" && latestReview.decision === "changes_requested" && latestReview.created > execution.created)) {
      throw new WorkReportInvalidError(`A current completed execution report is required before verifying Work ${id}.`);
    }
    const reportEvidence = execution.kind === "execution"
      ? (execution.evidence ?? []).map((evidence) => ({ ...evidence, status: "passed" as const }))
      : [];
    return this.verifyFeature(id, { ...options, evidence: options.evidence ?? reportEvidence });
  }

  /** Record an independent review; this path enforces the external lifecycle gates. */
  async reviewWork(
    id: string,
    actorInput: ActorRef,
    decision: ReviewDecision,
    summary: string,
    findings?: string[],
    runId?: string,
  ): Promise<Feature> {
    const actor = this.assertActor(actorInput, "reviewer");
    const feature = await this.requireFeature(id);
    if (feature.state !== "review") throw new InvalidStateTransitionError(feature.state, "done");
    const receipts = await this.listReceipts(id);
    const execution = [...receipts].reverse().find((receipt) => receipt.kind === "execution" && receipt.outcome === "completed");
    if (!execution) throw new ReviewActorInvalidError(`A completed external execution report is required before reviewing ${id}.`);
    const verification = [...receipts].reverse().find((receipt) => receipt.kind === "verification");
    if (!verification || verification.outcome !== "passed" || verification.created < execution.created) throw new ReviewActorInvalidError(`A current passing verification receipt is required before reviewing ${id}.`);
    if (sameActor(execution.actor, actor)) throw new ReviewSelfApprovalError(`The reviewer ${actorKey(actor)} cannot approve the same Work execution.`);
    const normalizedSummary = summary.trim();
    if (!normalizedSummary) throw new ReviewActorInvalidError("Review summary cannot be empty.");
    if (!["approved", "changes_requested", "blocked", "needs_human"].includes(decision)) throw new ReviewActorInvalidError(`Invalid review decision: ${decision}`);
    const receipt = this.createActorReviewReceipt(feature, actor, decision, normalizedSummary, findings, runId);
    await this.persistReceipt(feature, receipt);
    if (decision === "needs_human") return feature;
    if (decision === "approved") return feature;
    const next = decision === "changes_requested" ? "doing" : "blocked";
    const updated = await this.transition(id, next);
    if (next === "blocked") await fs.appendFile(path.join(updated.path, "notes.md"), `\n## Blocked ${isoNow()}\n\n${normalizedSummary}\n`);
    await this.releaseWorkClaim(updated.id);
    return updated;
  }

  /** Ship reviewed Work after an independent approval and current verification. */
  async shipWork(id: string): Promise<Feature> {
    const feature = await this.requireFeature(id);
    if (feature.state !== "review") throw new InvalidStateTransitionError(feature.state, "done");
    const receipts = await this.listReceipts(id);
    const latest = <T extends Receipt["kind"]>(kind: T) => [...receipts].reverse().find((receipt): receipt is Extract<Receipt, { kind: T }> => receipt.kind === kind);
    const review = latest("review");
    if (!review || review.decision !== "approved") throw new ReviewReceiptRequiredError(id);
    const execution = [...receipts].reverse().find((receipt) => receipt.kind === "execution" && receipt.outcome === "completed");
    const verification = latest("verification");
    if (!execution || !verification || verification.outcome !== "passed" || verification.created < execution.created || review.created < verification.created) {
      throw new ReviewReceiptRequiredError(id);
    }
    const shipped = await this.transition(id, "done");
    await this.releaseWorkClaim(shipped.id);
    return shipped;
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
    const feature = await this.createFeature({
      ...input,
      source: { type: "inbox", ref: current.id },
      ...(input.routingDecision ?? current.routingDecision
        ? { routingDecision: input.routingDecision ?? current.routingDecision, routingDecisionRef: input.routingDecisionRef ?? `provenance/routing/${current.id}.yaml` }
        : {}),
    });
    try {
      await this.moveInboxProvenance(current, feature, "promoted");
    } catch (error) {
      await fs.rm(feature.path, { recursive: true, force: true });
      throw error;
    }
    return feature;
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
    if (outcome !== "passed") {
      await this.persistReceipt(feature, this.createHandoffReceipt(feature, runId, outcome === "cancelled" ? "cancelled" : "failed", receipt.id, receipt.summary));
    } else {
      await this.transition(id, "review");
    }
    return receipt;
  }

  async executeFeature(id: string, registry: ExecutionAdapterRegistry, signal?: AbortSignal, options: { runId?: string; onEvent?: RepositoryEventCallback } = {}): Promise<{ outcome: ExecutionOutcome | "needs_human"; feature: Feature; summary: string; adapterId?: string; details?: Record<string, unknown> }> {
    const current = await this.requireFeature(id);
    if (current.state !== "ready" && current.state !== "doing") throw new InvalidStateTransitionError(current.state, "doing");
    const profile = await this.inspectExecutionMode(id);
    const runId = options.runId ?? `run-${timestampForFile()}-${shortId()}`;
    const request = { root: this.root, feature: current, profile, runId, permissions: "repository" as const, allowedPaths: ["source files and tests; never product/, features/, or .stonvik/"], signal };
    const adapter = await registry.resolve(request);
    if (!adapter) return { outcome: "needs_human", feature: current, summary: "No execution adapter is available for this Feature." };

    const executionActor: ActorRef = { type: "process", name: adapter.id, role: "implementer" };
    const doing = current.state === "ready" ? await this.startWork(id, executionActor, runId) : current;
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
    await this.persistReceipt(doing, this.createActorExecutionReceipt(doing, runId, executionActor, result.outcome, result.summary, result.artifacts, undefined, result.details));
    await this.releaseWorkClaim(doing.id);
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

  async unblockFeature(id: string): Promise<Feature> { return this.transition(id, "ready"); }
  async blockFeature(id: string, reason: string): Promise<Feature> {
    const feature = await this.transition(id, "blocked");
    await fs.appendFile(path.join(feature.path, "notes.md"), `\n## Blocked ${new Date().toISOString()}\n\n${reason}\n`);
    return feature;
  }

  async inspectExecutionMode(id: string): Promise<ExecutionProfile> {
    await this.requireFeature(id);
    // Stonvik records the workflow gates but never infers an implementation
    // method from filenames or document contents.
    return { kind: "direct" };
  }

  async getStatus(): Promise<RepositoryStatus> {
    await this.assertInitialized();
    const inbox: Record<string, number> = { captured: 0, needs_definition: 0, needs_review: 0, promoted: 0, merged: 0, deferred: 0, rejected: 0 };
    for (const item of await this.listInbox()) inbox[item.status] = (inbox[item.status] ?? 0) + 1;
    const features = Object.fromEntries(FEATURE_STATES.map((s) => [s, 0])) as RepositoryStatus["features"];
    for (const feature of await this.listFeatures()) features[feature.state]++;
    return { inbox, features };
  }

  async validate(): Promise<ValidationReport> {
    const issues: ValidationReport["issues"] = [];
    for (const dir of this.paths.requiredDirs) if (!(await exists(dir))) issues.push({ severity: "error", code: "MISSING_DIRECTORY", message: `Missing directory: ${path.relative(this.root, dir)}`, path: dir });
    if (issues.length) return { valid: false, issues };
    try { await loadCoreConfig(this.root); }
    catch (error) { issues.push({ severity: "error", code: "CONFIG_INVALID", message: String((error as Error).message), path: path.join(this.root, "stonvik.json") }); }
    for (const file of (await safeReaddir(this.paths.inbox)).filter((e) => e.endsWith(".md"))) {
      try { await this.readInboxFile(path.join(this.paths.inbox, file)); } catch (error) { issues.push({ severity: "error", code: "INVALID_INBOX_ITEM", message: String((error as Error).message), path: path.join(this.paths.inbox, file) }); }
    }
    for (const file of (await safeReaddir(this.paths.inboxReview)).filter((e) => e.endsWith(".md"))) {
      try { await this.readInboxFile(path.join(this.paths.inboxReview, file)); } catch (error) { issues.push({ severity: "error", code: "INVALID_INBOX_ITEM", message: String((error as Error).message), path: path.join(this.paths.inboxReview, file) }); }
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
    for (const state of FEATURE_STATES) {
      for (const entry of await safeReaddir(this.paths.featureStateDir(state))) {
        const full = this.paths.featureDir(state, entry);
        if (!(await fs.stat(full)).isDirectory()) continue;
        let feature: Feature | undefined;
        try { feature = await this.readFeature(full, state); } catch (error) { issues.push({ severity: "error", code: "INVALID_FEATURE", message: String((error as Error).message), path: full }); }
        try { await this.validateReceiptFiles(full); } catch (error) { issues.push({ severity: "error", code: "INVALID_RECEIPT", message: String((error as Error).message), path: full }); }
        if (feature) {
          try { await this.validateInboxProvenance(feature); } catch (error) { issues.push({ severity: "error", code: "INVALID_INBOX_PROVENANCE", message: String((error as Error).message), path: full }); }
          try { await this.validateWorkMetadata(feature); } catch (error) { issues.push({ severity: "error", code: "INVALID_WORK_METADATA", message: String((error as Error).message), path: full }); }
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === "error").length === 0, issues };
  }

  private assertActor(input: ActorRef, defaultRole: ActorRef["role"]): ActorRef {
    const parsed = ActorRefSchema.safeParse(input);
    if (!parsed.success) throw new ActorInvalidError(parsed.error.message);
    return { ...parsed.data, role: parsed.data.role ?? defaultRole } as ActorRef;
  }

  private parseExternalExecutionReport(input: ExternalExecutionReport): ExternalExecutionReport {
    const parsed = ExternalExecutionReportSchema.safeParse(input);
    if (!parsed.success) throw new WorkReportInvalidError(parsed.error.message);
    return parsed.data as ExternalExecutionReport;
  }

  private async readWorkClaim(claimPath: string): Promise<WorkClaim | null> {
    try {
      const parsed = WorkClaimSchema.safeParse(JSON.parse(await fs.readFile(claimPath, "utf8")));
      if (!parsed.success) throw new WorkClaimConflictError(`Invalid Work claim: ${parsed.error.message}`);
      return parsed.data as WorkClaim;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof WorkClaimConflictError) throw error;
      throw new WorkClaimConflictError(`Invalid Work claim: ${String((error as Error).message)}`);
    }
  }

  private async releaseWorkClaim(workId: string): Promise<void> {
    await fs.rm(this.paths.claimPath(workId), { force: true });
  }

  private validateExternalExecutionReferences(report: ExternalExecutionReport, featurePath: string): void {
    const existsInRepository = (reference: string): boolean => {
      if (!isSafeRepositoryPath(reference)) return false;
      return [path.resolve(this.root, reference), path.resolve(featurePath, reference)].some((candidate) => {
        try {
          const stat = fssync.lstatSync(candidate);
          return !stat.isSymbolicLink();
        } catch {
          return false;
        }
      });
    };
    for (const artifact of report.artifacts ?? []) {
      if (isExternalUrl(artifact) || !existsInRepository(artifact)) throw new WorkReportInvalidError(`Invalid artifact path: ${artifact}`);
    }
    for (const evidence of report.evidence ?? []) {
      if (!evidence.ref || isExternalUrl(evidence.ref)) continue;
      if (!existsInRepository(evidence.ref)) throw new WorkReportInvalidError(`Invalid evidence path: ${evidence.ref}`);
    }
  }

  private async transition(id: string, to: FeatureState): Promise<Feature> {
    const feature = await this.requireFeature(id);
    if (!canTransition(feature.state, to)) throw new InvalidStateTransitionError(feature.state, to);
    ManifestSchema.parse(feature.manifest);
    const dest = this.paths.featureDir(to, feature.slug);
    if (await exists(dest)) throw new FeatureStateConflictError(`Destination already exists: ${dest}`);
    await fs.rename(feature.path, dest);
    return this.readFeature(dest, to);
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

  private async validateWorkMetadata(feature: Feature): Promise<void> {
    if (feature.manifest.classification) validateClassification(feature.manifest.classification);
    await this.validateDefinitionReferences(feature.manifest.definitions);
    const decision = feature.manifest.routingDecision;
    if (!decision) return;
    validateRoutingDecisionShape(decision);
    const reference = feature.manifest.routingDecisionRef;
    if (!reference || !isSafeRepositoryPath(reference)) throw new InvalidManifestError(`Work ${feature.id} has no safe routing decision reference.`);
    const referencePath = path.resolve(feature.path, reference);
    if (!isWithin(feature.path, referencePath) || !(await exists(referencePath))) throw new InvalidManifestError(`Routing decision reference is missing: ${reference}`);
    const parsed = RoutingDecisionSchema.parse(YAML.parse(await fs.readFile(referencePath, "utf8"))) as RoutingDecision;
    if (parsed.inboxId !== decision.inboxId
      || parsed.inboxId !== (feature.manifest.source?.type === "inbox" ? feature.manifest.source.ref : parsed.inboxId)
      || stableJson(parsed) !== stableJson(decision)) {
      throw new InvalidManifestError(`Routing decision does not match Work ${feature.id}.`);
    }
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
    for (const dir of this.paths.requiredDirs) if (!(await exists(dir))) throw new StonvikNotInitializedError();
  }

  private createVerificationReceipt(feature: Feature, runId: string, outcome: VerificationReceipt["outcome"], checks: VerificationReceipt["checks"], evidence?: ReceiptEvidence[]): VerificationReceipt {
    return {
      ...this.receiptBase(feature, "verification", outcome, `Verification outcome: ${outcome}.`, runId, "verifier", "stonvik"),
      kind: "verification",
      outcome,
      checks,
      evidence
    };
  }

  private createActorExecutionReceipt(
    feature: Feature,
    runId: string,
    actor: ActorRef,
    outcome: string,
    summary: string,
    artifacts?: string[],
    evidence?: ExternalExecutionEvidence[],
    details?: Record<string, unknown>,
  ): Receipt {
    return {
      ...this.receiptBase(feature, "execution", outcome, summary, runId, actor.type, actor.name),
      kind: "execution",
      outcome,
      actor: { ...actor },
      artifacts,
      evidence,
      details,
    };
  }

  private createActorReviewReceipt(
    feature: Feature,
    actor: ActorRef,
    decision: ReviewDecision,
    summary: string,
    findings?: string[],
    runId?: string,
  ): Receipt {
    return {
      ...this.receiptBase(feature, "review", decision, summary, runId ?? `review-${timestampForFile()}-${shortId()}`, actor.type, actor.name),
      kind: "review",
      outcome: decision,
      decision,
      actor: { ...actor },
      findings: findings?.length ? findings : undefined,
    };
  }

  private createHandoffReceipt(feature: Feature, runId: string, outcome: "failed" | "blocked" | "needs_human" | "cancelled", relatedReceipt: string | undefined, reason: string): Receipt {
    return {
      ...this.receiptBase(feature, "handoff", outcome, reason, runId, "system", "stonvik"),
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
    if (receipt.kind === "verification" || receipt.kind === "execution") refs.push(...(receipt.evidence ?? []).flatMap((item) => item.ref ? [item.ref] : []));
    if (receipt.kind === "execution") refs.push(...(receipt.artifacts ?? []));
    for (const ref of refs) {
      if (isExternalUrl(ref)) continue;
      const featureResolved = path.resolve(featurePath, ref);
      const repositoryResolved = path.resolve(this.root, ref);
      const safePath = isSafeRepositoryPath(ref);
      const featureLocal = safePath && isWithin(featurePath, featureResolved) && fssync.existsSync(featureResolved);
      const repositoryLocal = safePath && isWithin(this.root, repositoryResolved) && fssync.existsSync(repositoryResolved);
      if (!featureLocal && !repositoryLocal) throw new InvalidReceiptError(`Invalid local receipt reference: ${ref}`);
    }
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
        notes: (await exists(path.join(featurePath, "notes.md"))) ? path.join(featurePath, "notes.md") : undefined,
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

  async writeInboxItem(item: InboxItem): Promise<void> {
    await this.writeFileAtomic(item.path, this.renderInbox(item));
  }

  private renderInbox(item: InboxItem): string {
    const fm: Record<string, unknown> = { id: item.id, source: item.source, created: item.created, status: item.status };
    if (item.featureRef) fm.featureRef = item.featureRef;
    if (item.clarification) fm.clarification = item.clarification;
    if (item.classification) fm.classification = item.classification;
    if (item.routingDecision) fm.routingDecision = item.routingDecision;
    return `---\n${YAML.stringify(fm)}---\n\n# ${item.title}\n${item.body ? `\n${item.body}\n` : ""}`;
  }

  private async validateDefinitionReferences(definitions: DefinitionRef[] | undefined): Promise<void> {
    const repositoryRoot = await fs.realpath(this.root);
    for (const definition of definitions ?? []) {
      const resolved = path.resolve(this.root, definition.path);
      const relative = path.relative(this.root, resolved);
      if (!isSafeRepositoryPath(definition.path) || !isWithin(this.root, resolved) || relative.startsWith(".stonvik") || relative === "product/inbox" || relative.startsWith(`product${path.sep}inbox${path.sep}`) || relative === "features" || relative.startsWith(`features${path.sep}`)) {
        throw new InvalidManifestError(`Definition path must point to a user-owned repository file: ${definition.path}`);
      }
      const stat = await fs.lstat(resolved).catch(() => undefined);
      if (!stat) throw new InvalidManifestError(`Definition file does not exist: ${definition.path}`);
      if (!stat.isFile() || stat.isSymbolicLink() || !(await this.hasNoSymlinkSegments(resolved))) throw new InvalidManifestError(`Definition file must be a regular file: ${definition.path}`);
      const realPath = await fs.realpath(resolved).catch(() => undefined);
      if (!realPath || !isWithin(repositoryRoot, realPath)) throw new InvalidManifestError(`Definition path must resolve inside the repository: ${definition.path}`);
    }
  }

  private async hasNoSymlinkSegments(filePath: string): Promise<boolean> {
    let current = this.root;
    for (const segment of path.relative(this.root, filePath).split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) return false;
    }
    return true;
  }

  private async ensureGitignoreRuntime(): Promise<void> {
    const gitignore = path.join(this.root, ".gitignore");
    const line = ".stonvik/runtime/";
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

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isExternalUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function isSafeRepositoryPath(value: string): boolean {
  return Boolean(value)
    && !value.includes("\0")
    && !path.isAbsolute(value)
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]/).includes("..");
}

function isLiveClaim(claim: WorkClaim): boolean {
  if (claim.host !== os.hostname()) return false;
  try {
    process.kill(claim.pid, 0);
    return true;
  } catch {
    return false;
  }
}
