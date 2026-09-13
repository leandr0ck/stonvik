import { ZodError } from "zod";
import path from "node:path";
import { FilesystemStonvikRepository } from "../repository/filesystem-stonvik-repository.js";
import type { Classification, Feature, FeatureState, InboxItem, RunEvent, WorkReviewDecision } from "../domain/types.js";
import { hasVerificationPlan, isAutomaticClassification, validateClassification } from "./classification.js";
import { classifyDeterministically } from "./deterministic-classifier.js";
import { ExecutionAdapterRegistry } from "../execution/execution-adapter.js";
import type { AdapterProgress, AdapterProgressCallback, WorkReviewAdapter } from "../execution/execution-adapter.js";
import { RunEventSink, type RunEventInput } from "./run-event-sink.js";

export interface AgentLoopOptions {
  dryRun?: boolean;
  nonInteractive?: boolean;
  signal?: AbortSignal;
  classify?: (item: InboxItem, signal?: AbortSignal, onProgress?: AdapterProgressCallback, repairReason?: string) => Promise<unknown>;
  deterministicClassification?: boolean;
  registry?: ExecutionAdapterRegistry;
  reviewer?: WorkReviewAdapter;
  onEvent?: (event: RunEvent) => Promise<void> | void;
}

export interface AgentLoopResult {
  root: string;
  actions: Array<{ kind: "inbox" | "work"; id: string; action: string; nextAction?: string; definitionRef?: string; definitionKind?: "spec" | "adr" }>;
  features: Array<{ id: string; state: FeatureState; action: string }>;
  inboxReview: number;
  stopReason: string;
  nextAction?: string;
}

export class AgentLoop {
  constructor(private readonly repo: FilesystemStonvikRepository) {}

  async run(options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result: AgentLoopResult = { root: this.repo.root, actions: [], features: [], inboxReview: 0, stopReason: "idle" };
    const release = options.dryRun ? async () => undefined : await this.repo.acquireLoopLease(runId);
    const sink = new RunEventSink({
      runId,
      persist: options.dryRun ? undefined : (event) => this.repo.persistEvent(event),
      subscribe: options.onEvent,
    });
    const emit = (event: RunEventInput, emitOptions?: { durable?: boolean }) => sink.emit(event, emitOptions);
    try {
      await emit({ type: "status", kind: "run.started", phase: "preflight", message: "Stonevik run started." });
      const validation = await this.repo.validate();
      await emit({ type: "status", kind: "preflight.finished", phase: "preflight", message: "Validated Stonevik repository." });
      if (!validation.valid) return this.stop(result, "preflight_failed", "Fix validation errors before running.", emit);
      if (options.signal?.aborted) return this.stop(result, "interrupted", "Resume with `stonvik run`.", emit);

      const active = await this.repo.getActiveFeatures();
      const doing = active.filter((feature) => feature.state === "doing");
      if (doing.length > 1) return this.stop(result, "multiple_active_work", `Multiple Work items are active: ${doing.map((feature) => feature.id).join(", ")}.`, emit);
      if (active.length > 1) return this.stop(result, "multiple_active_work", `Multiple Work items are active: ${active.map((feature) => feature.id).join(", ")}.`, emit);

      if (active[0]?.state === "review") {
        const review = await this.review(active[0], options, emit, runId);
        result.features.push({ id: active[0].id, state: review.state, action: review.action });
        if (review.stopReason) return this.stop(result, review.stopReason, review.nextAction, emit);
      } else if (active[0]?.state === "doing") {
        const execution = await this.implement(active[0], options, emit, runId);
        result.features.push({ id: active[0].id, state: execution.feature.state, action: execution.feature.state === "ready" ? "ready_for_implementation" : execution.outcome });
        if (execution.feature.state === "review") {
          const review = await this.review(execution.feature, options, emit, runId);
          result.features.push({ id: execution.feature.id, state: review.state, action: review.action });
          if (review.stopReason) return this.stop(result, review.stopReason, review.nextAction, emit);
        } else return this.stop(result, reasonForExecution(execution.outcome, execution.summary), execution.summary, emit);
      }

      const inbox = await this.repo.listInbox();
      await this.processInbox(inbox, result, options, emit, runId);

      const reviewItems = await this.repo.listReview();
      result.inboxReview = reviewItems.length;

      if (options.dryRun) {
        result.features.push(...(await this.repo.listFeatures("ready")).map((feature) => ({ id: feature.id, state: feature.state, action: "planned" })));
        return this.stop(result, "dry_run", "Run without --dry-run to execute the plan.", emit);
      }

      while (true) {
        if (options.signal?.aborted) return this.stop(result, "interrupted", "Resume with `stonvik run`.", emit);
        const next = await this.repo.getNextReady();
        if (!next) {
          const reviewCount = (await this.repo.listReview()).length;
          const nextAction = reviewCount > 0
            ? `Run \`stonvik review\` to address ${reviewCount} Inbox item(s) needing attention.`
            : "Capture new intent or add ready Work.";
          return this.stop(result, "idle", nextAction, emit);
        }
        await emit({ type: "transition", kind: "work.selected", phase: "execution", workId: next.id, state: "ready", message: `Selected oldest ready Work ${next.id}.` });
        const execution = await this.implement(next, options, emit, runId);
        result.features.push({ id: next.id, state: execution.feature.state, action: execution.feature.state === "ready" ? "ready_for_implementation" : execution.outcome });
        if (execution.feature.state !== "review") return this.stop(result, reasonForExecution(execution.outcome, execution.summary), execution.summary, emit);
        const review = await this.review(execution.feature, options, emit, runId);
        result.features.push({ id: next.id, state: review.state, action: review.action });
        if (review.stopReason) return this.stop(result, review.stopReason, review.nextAction, emit);
      }
    } finally {
      await release();
    }
  }

  private async processInbox(inbox: InboxItem[], result: AgentLoopResult, options: AgentLoopOptions, emit: (event: RunEventInput, options?: { durable?: boolean }) => Promise<RunEvent>, runId: string): Promise<void> {
    // AgentLoop is retained as a compatibility orchestration loop, but the
    // core never constructs or discovers an agent. Integrations inject the
    // classifier explicitly through AgentLoopOptions.
    const classifier = options.classify;
    const useDeterministic = !classifier && options.deterministicClassification !== false;
    for (const item of inbox.filter((c) => c.status === "captured" || c.status === "needs_definition" || c.status === "needs_clarification")) {
        if (options.dryRun) {
          result.actions.push({ kind: "inbox", id: item.id, action: "classification_planned", nextAction: `Classify Inbox item ${item.id}.` });
          continue;
        }

        // If the item already has a definitionKind from a previous run and
        // has inline spec content, try to extract and promote directly.
        if (item.definitionKind) {
          const inlineSpec = this.repo.extractInlineSpec(item);
          if (inlineSpec) {
            try {
              const specDoc = this.repo.renderSpecDocument(item, inlineSpec);
              const feature = await this.repo.promoteInlineDefinition(item, specDoc);
              result.actions.push({ kind: "inbox", id: item.id, action: `created:${feature.id}` });
              await emit({ type: "transition", kind: "work.transitioned", phase: "definition", inboxId: item.id, workId: feature.id, state: "ready", message: `Extracted inline ${item.definitionKind} and created ready Work ${feature.id}.` });
            } catch (error) {
              result.actions.push({ kind: "inbox", id: item.id, action: "definition_invalid", nextAction: `Fix the inline ${item.definitionKind} and move back to inbox.` });
              await emit({ type: "gate", kind: "gate.reached", phase: "definition", inboxId: item.id, severity: "error", message: `Extracted ${item.definitionKind} is invalid: ${String((error as Error).message).slice(0, 200)}`, nextAction: `Fix the inline ${item.definitionKind} and move back to inbox.` });
            }
            continue;
          }
          // Inline spec is incomplete — move back to review
          const questions = [
            `The inline ${item.definitionKind} is still incomplete.`,
            `Fill in the template sections (replace _TBD_ placeholders), then move this file back to product/inbox/.`,
          ].join("\n");
          await this.repo.moveToReview(item, questions);
          result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review" });
          await emit({ type: "gate", kind: "definition.awaiting_confirmation", phase: "definition", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: inline ${item.definitionKind} is incomplete.` });
          continue;
        }

        // If the item has an existing definitionRef, try to confirm it.
        if (item.definitionRef) {
          const specPath = path.resolve(this.repo.root, item.definitionRef);
          try {
            const fsMod = await import("node:fs/promises");
            await fsMod.access(specPath);
            const feature = await this.repo.confirmDefinitionForInboxItem(item);
            result.actions.push({ kind: "inbox", id: item.id, action: `definition_confirmed:${feature.id}` });
            await emit({ type: "transition", kind: "work.transitioned", phase: "definition", inboxId: item.id, workId: feature.id, state: "ready", message: `Confirmed definition and created ready Work ${feature.id}.` });
            continue;
          } catch {
            // Definition file doesn't exist or is invalid — move to review
            const questions = [
              `Definition \`${item.definitionRef}\` is missing or invalid.`,
              `Create the definition file, then move this file back to product/inbox/.`,
            ].join("\n");
            await this.repo.moveToReview(item, questions);
            result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review" });
            await emit({ type: "gate", kind: "definition.awaiting_confirmation", phase: "definition", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: definition file missing.` });
            continue;
          }
        }

        // If the item has an answered clarification, use it.
        if (item.clarification?.answer) {
          // Already answered — proceed to classification
        } else if (item.clarification && !item.clarification.answer) {
          // Has a pending clarification that wasn't answered — move to review
          const { clarificationQuestion } = await import("./classification.js");
          const question = clarificationQuestion(item.clarification.field);
          const questions = [
            `Before this Work can be created, one answer is needed:`,
            question,
            `Edit the answer below the H1 title, then move this file back to product/inbox/.`,
          ].join("\n");
          await this.repo.moveToReview(item, questions);
          result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review" });
          await emit({ type: "gate", kind: "clarification.awaiting_answer", phase: "classification", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: ${question}` });
          continue;
        }

        // Classify the item
        let classification: Classification;
        let repaired = false;
        // Fast path: deterministic classifier (no LLM, ~0ms)
        // Only used when no custom classifier is provided (i.e., production).
        const deterministic = useDeterministic ? classifyDeterministically(item.title, item.body) : undefined;
        if (deterministic) {
          classification = validateClassification(deterministic);
          await emit({ type: "classification", kind: "classification.started", phase: "classification", inboxId: item.id, message: `Classifying ${item.id} (deterministic).` });
          await this.repo.recordClassification(item, classification, runId);
          await emit({ type: "classification", kind: "classification.finished", phase: "classification", inboxId: item.id, message: `Classified ${item.id} as ${classification.route}/${classification.size} (deterministic).` });
        } else if (!classifier) {
          const nextAction = "Provide an external classifier or run `stonvik prepare` manually.";
          result.actions.push({ kind: "inbox", id: item.id, action: "classification_unavailable", nextAction });
          await emit({ type: "gate", kind: "gate.reached", phase: "classification", inboxId: item.id, severity: "warning", message: `No external classifier is configured for ${item.id}.`, nextAction });
          continue;
        } else {
        try {
          await emit({ type: "classification", kind: "classification.started", phase: "classification", inboxId: item.id, message: `Classifying ${item.id}.` });
          const onProgress = async (progress: AdapterProgress) => { await emit({ type: "status", kind: progress.kind, phase: progress.phase, severity: progress.severity, inboxId: item.id, message: progress.message, elapsedMs: progress.elapsedMs }, { durable: progress.durable === true }); };
          try {
            classification = validateClassification(await classifier(item, options.signal, onProgress));
          } catch (error) {
            if (!canRepairClassification(error)) throw error;
            repaired = true;
            await emit({ type: "status", kind: "classification.repairing", phase: "classification", inboxId: item.id, severity: "warning", message: "The classifier returned an incomplete proposal; retrying once with the missing contract details." });
            classification = validateClassification(await classifier(item, options.signal, onProgress, classificationErrorSummary(error)));
          }
          await this.repo.recordClassification(item, classification, runId);
        } catch (error) {
          const nextAction = classificationRecoveryAction();
          result.actions.push({ kind: "inbox", id: item.id, action: "classification_invalid", nextAction });
          await emit({ type: "gate", kind: "gate.reached", phase: "classification", inboxId: item.id, severity: "error", message: formatClassificationError(error, repaired), nextAction });
          continue;
        }
        await emit({ type: "classification", kind: "classification.finished", phase: "classification", inboxId: item.id, message: `Classified ${item.id} as ${classification.route}/${classification.size}.` });
        }

        // Handle ask_direct — needs clarification
        if (classification.route === "ask_direct") {
          const { clarificationQuestion } = await import("./classification.js");
          const field = classification.clarification!.field;
          const question = clarificationQuestion(field);
          const questions = [
            `Classification: ${classification.route}/${classification.size}.`,
            ...classification.rationale,
            "",
            `Before Work can be created, one answer is needed:`,
            question,
            `Edit the answer below the H1 title, then move this file back to product/inbox/.`,
          ].join("\n");
          const pending = await this.repo.requestInboxClarificationItem(item, field);
          const itemWithClassification = { ...pending, classification };
          await this.repo.moveToReview(itemWithClassification, questions);
          result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review" });
          await emit({ type: "gate", kind: "clarification.awaiting_answer", phase: "classification", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: ${question}` });
          continue;
        }

        // Handle auto_direct — create Work directly if possible
        const automatic = isAutomaticClassification(classification);
        if (automatic) {
          if (!hasVerificationPlan(classification)) {
            const questions = [
              `Classification: ${classification.route}/${classification.size} (auto).`,
              ...classification.rationale,
              "",
              "Auto-classification needs a verification plan but none was provided.",
              "Add verification commands, then move this file back to product/inbox/.",
            ].join("\n");
            const itemWithClassification = { ...item, classification };
            await this.repo.moveToReview(itemWithClassification, questions);
            result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review" });
            await emit({ type: "gate", kind: "gate.reached", phase: "classification", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: needs verification plan.` });
            continue;
          }
          try {
            const feature = await this.repo.createFeatureFromInboxItem(item, { ...classification.proposed, verification: classification.proposed.verification, classification });
            result.actions.push({ kind: "inbox", id: item.id, action: `created:${feature.id}` });
            await emit({ type: "transition", kind: "work.transitioned", phase: "classification", inboxId: item.id, workId: feature.id, state: "ready", message: `Promoted ${item.id} to ready Work ${feature.id}.` });
          } catch (error) {
            const questions = [
              `Classification: ${classification.route}/${classification.size} (auto).`,
              `Work creation failed: ${String((error as Error).message).slice(0, 200)}`,
              "Review and fix, then move this file back to product/inbox/.",
            ].join("\n");
            const itemWithClassification = { ...item, classification };
            await this.repo.moveToReview(itemWithClassification, questions);
            result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review" });
            await emit({ type: "gate", kind: "gate.reached", phase: "classification", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: Work creation failed.` });
          }
          continue;
        }

        // Handle ask_spec / ask_adr — needs definition
        if (classification.route === "ask_spec" || classification.route === "ask_adr") {
          const kind = classification.route === "ask_spec" ? "spec" : "adr";
          const questions = [
            `Classification: ${classification.route}/${classification.size}.`,
            ...classification.rationale,
            "",
            `This Work needs a ${kind.toUpperCase()} definition.`,
            `Fill in the template sections below (replace _TBD_ placeholders),`,
            `then move this file back to product/inbox/ and run \`stonvik run\`.`,
          ].join("\n");
          const itemWithClassification = { ...item, classification, definitionKind: kind as "spec" | "adr" };
          await this.repo.moveToReview(itemWithClassification, questions, kind as "spec" | "adr");
          result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review", definitionKind: kind as "spec" | "adr" });
          await emit({ type: "gate", kind: "definition.awaiting_confirmation", phase: "classification", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: needs ${kind}.` });
          continue;
        }

        // Handle split
        if (classification.route === "split") {
          const questions = [
            `Classification: ${classification.route}/${classification.size}.`,
            ...classification.rationale,
            "",
            "This item should be split into smaller Work items.",
            "Split manually, then move this file back to product/inbox/.",
          ].join("\n");
          const itemWithClassification = { ...item, classification };
          await this.repo.moveToReview(itemWithClassification, questions);
          result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review" });
          await emit({ type: "gate", kind: "gate.reached", phase: "classification", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: needs to be split.` });
          continue;
        }

        // Fallback — non-automatic classification needs human decision
        const questions = [
          `Classification: ${classification.route}/${classification.size}.`,
          ...classification.rationale,
          "",
          "This classification requires human review.",
          "Create Work manually or adjust the classification, then move back to inbox.",
        ].join("\n");
        const itemWithClassification = { ...item, classification };
        await this.repo.moveToReview(itemWithClassification, questions);
        result.actions.push({ kind: "inbox", id: item.id, action: "moved_to_review" });
        await emit({ type: "gate", kind: "gate.reached", phase: "classification", inboxId: item.id, severity: "warning", message: `Moved ${item.id} to review: needs human decision.` });
      }
  }

  private async implement(feature: Feature, options: AgentLoopOptions, emit: (event: RunEventInput, options?: { durable?: boolean }) => Promise<RunEvent>, runId: string) {
    const registry = options.registry;
    if (!registry) return { outcome: "needs_human" as const, feature, summary: "No external execution adapter is configured." };
    const receipts = await this.repo.listReceipts(feature.id);
    const lastExecution = [...receipts].reverse().find((receipt) => receipt.kind === "execution");
    const lastHandoff = [...receipts].reverse().find((receipt) => receipt.kind === "handoff");
    const fingerprint = await this.repo.durableFeatureFingerprint(feature.id);
    if (lastHandoff?.kind === "handoff" && lastHandoff.outcome !== "blocked" && lastExecution?.kind === "execution" && lastExecution.details?.featureFingerprint === fingerprint) {
      return { outcome: "needs_human" as const, feature, summary: "No durable change has occurred since the last implementation gate.", adapterId: lastExecution.engine };
    }
    await emit({ type: "status", kind: "execution.started", phase: "execution", workId: feature.id, state: "doing", message: `Execution started for ${feature.id}.` });
    const execution = await this.repo.executeFeature(feature.id, registry, options.signal, {
      runId,
      onEvent: async (event, eventOptions) => { await emit(event, eventOptions); },
    });
    await emit({ type: "receipt", kind: "execution.finished", phase: "execution", workId: feature.id, state: execution.feature.state, message: `Implementation outcome for ${feature.id}: ${execution.outcome}.` });
    if (execution.feature.state !== feature.state) await emit({ type: "transition", kind: "work.transitioned", phase: "execution", workId: feature.id, state: execution.feature.state, message: `Work ${feature.id} transitioned to ${execution.feature.state}.` });
    return execution;
  }

  private async review(feature: Feature, options: AgentLoopOptions, emit: (event: RunEventInput, options?: { durable?: boolean }) => Promise<RunEvent>, runId: string): Promise<{ state: FeatureState; action: string; stopReason?: string; nextAction: string }> {
    const priorReceipts = await this.repo.listReceipts(feature.id);
    const priorReview = [...priorReceipts].reverse().find((receipt) => receipt.kind === "review");
    if (priorReview?.kind === "review" && priorReview.decision === "needs_human") {
      const fingerprint = await this.repo.durableFeatureFingerprint(feature.id);
      const execution = [...priorReceipts].reverse().find((receipt) => receipt.kind === "execution");
      if (execution?.kind === "execution" && execution.details?.featureFingerprint === fingerprint) return { state: feature.state, action: "needs_human", stopReason: "review_needs_human", nextAction: "Record a human review decision or change the Work before retrying." };
    }
    const reviewer = options.reviewer;
    if (!reviewer) {
      const nextAction = "Record an explicit independent review decision.";
      const updated = await this.repo.reviewFeature(feature.id, "needs_human", "No independent reviewer is configured.", "external-review", undefined, runId);
      await emit({ type: "gate", kind: "review.finished", phase: "review", workId: feature.id, state: updated.state, severity: "warning", message: "Independent review needs human attention.", nextAction });
      return { state: updated.state, action: "needs_human", stopReason: "review_needs_human", nextAction };
    }
    let decision: WorkReviewDecision;
    const beforeReview = await this.repo.durableFeatureFingerprint(feature.id);
    await emit({ type: "status", kind: "review.started", phase: "review", workId: feature.id, message: `Independent review started for ${feature.id}.` });
    try {
      const receipts = await this.repo.listReceipts(feature.id);
      decision = await reviewer.review({ root: this.repo.root, feature, runId, receipts, verification: receipts.filter((receipt) => receipt.kind === "verification"), onProgress: async (progress) => { await emit({ type: "status", kind: progress.kind, phase: progress.phase, severity: progress.severity, workId: feature.id, message: progress.message, elapsedMs: progress.elapsedMs }, { durable: progress.durable === true }); } });
    } catch (error) {
      const updated = await this.repo.reviewFeature(feature.id, "needs_human", String((error as Error).message), reviewer.id, undefined, runId);
      await emit({ type: "gate", kind: "review.finished", phase: "review", workId: feature.id, state: updated.state, severity: "warning", message: "Independent review needs human attention.", nextAction: "Review the Work and record an explicit decision." });
      return { state: updated.state, action: "needs_human", stopReason: "review_needs_human", nextAction: "Review the Work and record an explicit decision." };
    }
    const afterReview = await this.repo.durableFeatureFingerprint(feature.id);
    if (afterReview !== beforeReview) {
      decision = { outcome: "needs_human", summary: "The reviewer modified repository content and lost its independence.", findings: [{ severity: "critical", message: "Reviewer was not read-only." }], evidence: [] };
    }
    const updated = await this.repo.reviewFeature(feature.id, decision.outcome, decision.summary, reviewer.id, decision.findings.map((finding) => `${finding.severity}: ${finding.message}${finding.reference ? ` (${finding.reference})` : ""}`), runId);
    await emit({ type: "receipt", kind: "review.finished", phase: "review", workId: feature.id, state: updated.state, message: `Independent review outcome: ${decision.outcome}.` });
    if (updated.state !== feature.state) await emit({ type: "transition", kind: "work.transitioned", phase: "review", workId: feature.id, state: updated.state, message: `Work ${feature.id} transitioned to ${updated.state}.` });
    if (decision.outcome === "approved") return { state: updated.state, action: "approved", nextAction: "Continue with the next ready Work." };
    if (decision.outcome === "changes_requested") return { state: updated.state, action: "changes_requested", stopReason: "changes_requested", nextAction: `Reimplement ${feature.id}; it has priority over other Work.` };
    if (decision.outcome === "blocked") return { state: updated.state, action: "blocked", stopReason: "feature_blocked", nextAction: `Resolve the blocker for ${feature.id}.` };
    return { state: updated.state, action: "needs_human", stopReason: "review_needs_human", nextAction: "Record a human review decision." };
  }

  private async stop(result: AgentLoopResult, reason: string, nextAction: string, emit: (event: RunEventInput, options?: { durable?: boolean }) => Promise<RunEvent>): Promise<AgentLoopResult> {
    result.stopReason = reason;
    result.nextAction = nextAction;
    await emit({ type: "stop", kind: "run.stopped", severity: reason === "idle" ? "info" : "warning", message: `Loop stopped: ${reason}.`, stopReason: reason, nextAction });
    return result;
  }
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function reasonForExecution(outcome: string, summary?: string): string {
  if (outcome === "needs_human" && summary?.startsWith("No execution adapter")) return "ready_for_implementation";
  if (outcome === "needs_human") return "human_input_required";
  if (outcome === "blocked") return "feature_blocked";
  if (outcome === "verification_failed") return "verification_failed";
  if (outcome === "cancelled") return "interrupted";
  return "execution_gate";
}

function formatClassificationError(error: unknown, repaired: boolean): string {
  const repair = repaired ? " after one automatic repair attempt" : "";
  return `Stonevik could not create a complete Work proposal${repair}. Your Inbox is unchanged. ${classificationErrorSummary(error)}`;
}

function classificationErrorSummary(error: unknown): string {
  if (error instanceof ZodError) return summarizeZodIssues(error);
  return String((error as Error).message ?? error).slice(0, 240);
}

function summarizeZodIssues(error: ZodError): string {
  const visible = error.issues.slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
    .join("; ");
  const omitted = error.issues.length - 3;
  return `${visible.slice(0, 240)}${omitted > 0 ? `; +${omitted} more issue(s)` : ""}`;
}

function canRepairClassification(error: unknown): boolean {
  return error instanceof ZodError
    || error instanceof SyntaxError
    || (error instanceof Error && /Classification (complexityScore|size)|work must be routed|XL work must/.test(error.message));
}

function classificationRecoveryAction(): string {
  return "Run `stonvik triage` to create the Work manually. Your Inbox has not been changed.";
}
