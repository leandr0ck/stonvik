import { ZodError } from "zod";
import { FilesystemForgiumRepository } from "../repository/filesystem-forgium-repository.js";
import type { Classification, Feature, FeatureState, InboxItem, RunEvent, WorkReviewDecision } from "../domain/types.js";
import { clarificationQuestion, hasVerificationPlan, isAutomaticClassification, validateClassification } from "./classification.js";
import { PiClassificationAdapter } from "../execution/pi-classification-adapter.js";
import { ExecutionAdapterRegistry } from "../execution/execution-adapter.js";
import { PiRpcExecutionAdapter } from "../execution/pi-rpc-execution-adapter.js";
import { SpecFlowExecutionAdapter } from "../execution/spec-flow-execution-adapter.js";
import type { WorkReviewAdapter } from "../execution/work-review-adapter.js";
import { PiWorkReviewAdapter } from "../execution/work-review-adapter.js";
import { RunEventSink, type RunEventInput } from "./run-event-sink.js";

export type HumanClassificationChoice = "direct" | "spec" | "adr" | "split" | "defer" | "reject" | "quit";
export interface AgentLoopOptions {
  dryRun?: boolean;
  nonInteractive?: boolean;
  signal?: AbortSignal;
  classify?: (item: InboxItem, signal?: AbortSignal, onProgress?: import("../execution/execution-adapter.js").AdapterProgressCallback, repairReason?: string) => Promise<unknown>;
  chooseClassification?: (item: InboxItem, classification: Classification) => Promise<HumanClassificationChoice>;
  answerClarification?: (item: InboxItem, question: string) => Promise<string | undefined>;
  confirmDefinition?: (item: InboxItem) => Promise<boolean>;
  registry?: ExecutionAdapterRegistry;
  reviewer?: WorkReviewAdapter;
  onEvent?: (event: RunEvent) => Promise<void> | void;
}

export interface AgentLoopResult {
  root: string;
  actions: Array<{ kind: "inbox" | "work"; id: string; action: string; nextAction?: string; definitionRef?: string; definitionKind?: "spec" | "adr" }>;
  features: Array<{ id: string; state: FeatureState; action: string }>;
  stopReason: string;
  nextAction?: string;
}

export class AgentLoop {
  constructor(private readonly repo: FilesystemForgiumRepository) {}

  async run(options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result: AgentLoopResult = { root: this.repo.root, actions: [], features: [], stopReason: "idle" };
    const release = options.dryRun ? async () => undefined : await this.repo.acquireLoopLease(runId);
    const sink = new RunEventSink({
      runId,
      persist: options.dryRun ? undefined : (event) => this.repo.persistEvent(event),
      subscribe: options.onEvent,
    });
    const emit = (event: RunEventInput, emitOptions?: { durable?: boolean }) => sink.emit(event, emitOptions);
    try {
      await emit({ type: "status", kind: "run.started", phase: "preflight", message: "Forgium run started." });
      const validation = await this.repo.validate();
      await emit({ type: "status", kind: "preflight.finished", phase: "preflight", message: "Validated Forgium repository." });
      if (!validation.valid) return this.stop(result, "preflight_failed", "Fix validation errors before running.", emit);
      if (options.signal?.aborted) return this.stop(result, "interrupted", "Resume with `forgium run`.", emit);

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

      const definitionStop = await this.processDefinitions(result, options, emit);
      if (definitionStop) return this.stop(result, definitionStop.reason, definitionStop.nextAction, emit);

      const clarificationStop = await this.processClarifications(result, options, emit);
      if (clarificationStop) return this.stop(result, clarificationStop.reason, clarificationStop.nextAction, emit);

      const classificationStop = await this.processInbox(result, options, emit, runId);
      if (classificationStop) return this.stop(result, classificationStop.reason, classificationStop.nextAction, emit);

      if (options.dryRun) {
        result.features.push(...(await this.repo.listFeatures("ready")).map((feature) => ({ id: feature.id, state: feature.state, action: "planned" })));
        return this.stop(result, "dry_run", "Run without --dry-run to execute the plan.", emit);
      }

      while (true) {
        if (options.signal?.aborted) return this.stop(result, "interrupted", "Resume with `forgium run`.", emit);
        const next = await this.repo.getNextReady();
        if (!next) return this.stop(result, "idle", "Capture new intent or add ready Work.", emit);
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

  private async processDefinitions(result: AgentLoopResult, options: AgentLoopOptions, emit: (event: RunEventInput, options?: { durable?: boolean }) => Promise<RunEvent>): Promise<{ reason: string; nextAction: string } | null> {
    for (const item of (await this.repo.listInbox()).filter((candidate) => candidate.status === "needs_definition")) {
      if (options.dryRun) { result.actions.push({ kind: "inbox", id: item.id, action: "definition_confirmation_planned", nextAction: `Complete and confirm ${item.definitionRef}.`, definitionRef: item.definitionRef, definitionKind: item.definitionKind }); return { reason: "dry_run", nextAction: `Complete and confirm ${item.definitionRef}.` }; }
      if (options.nonInteractive || !options.confirmDefinition) {
        await emit({ type: "gate", kind: "definition.awaiting_confirmation", phase: "definition", inboxId: item.id, severity: "warning", message: `Definition confirmation is required for ${item.id}.`, nextAction: `Complete and confirm ${item.definitionRef}.` });
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition_confirmation", nextAction: `Complete and confirm ${item.definitionRef}.`, definitionRef: item.definitionRef, definitionKind: item.definitionKind });
        return { reason: "human_definition_required", nextAction: `Complete and confirm ${item.definitionRef}.` };
      }
      if (await options.confirmDefinition(item)) {
        try {
          const feature = await this.repo.confirmDefinitionForInbox(item.id);
          result.actions.push({ kind: "inbox", id: item.id, action: `definition_confirmed:${feature.id}` });
          await emit({ type: "transition", kind: "work.transitioned", phase: "definition", inboxId: item.id, workId: feature.id, state: "ready", message: `Confirmed definition and created ready Work ${feature.id}.` });
        } catch (error) {
          await emit({ type: "gate", kind: "gate.reached", phase: "definition", inboxId: item.id, severity: "error", message: `Definition is invalid: ${String((error as Error).message)}`, nextAction: `Complete ${item.definitionRef} and run again.` });
          return { reason: "definition_invalid", nextAction: `Complete ${item.definitionRef} and run again.` };
        }
      } else {
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition_confirmation", nextAction: `Confirm the completed definition at ${item.definitionRef}.`, definitionRef: item.definitionRef, definitionKind: item.definitionKind });
        return { reason: "human_definition_required", nextAction: `Confirm the completed definition at ${item.definitionRef}.` };
      }
    }
    return null;
  }

  private async processClarifications(result: AgentLoopResult, options: AgentLoopOptions, emit: (event: RunEventInput, options?: { durable?: boolean }) => Promise<RunEvent>): Promise<{ reason: string; nextAction: string } | null> {
    for (const item of (await this.repo.listInbox()).filter((candidate) => candidate.status === "needs_clarification" && candidate.clarification)) {
      const question = clarificationQuestion(item.clarification!.field);
      const nextAction = `Answer with \`forgium inbox answer ${item.id} <answer>\`, then run \`forgium run\` again.`;
      if (options.dryRun) {
        result.actions.push({ kind: "inbox", id: item.id, action: "clarification_planned", nextAction });
        return { reason: "dry_run", nextAction };
      }
      if (options.nonInteractive || !options.answerClarification) {
        await emit({ type: "gate", kind: "clarification.awaiting_answer", phase: "classification", inboxId: item.id, severity: "warning", message: `One answer is needed before Work can be created: ${question}`, nextAction });
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_clarification", nextAction });
        return { reason: "human_input_required", nextAction };
      }
      const answer = (await options.answerClarification(item, question))?.trim();
      if (!answer) {
        await emit({ type: "gate", kind: "clarification.awaiting_answer", phase: "classification", inboxId: item.id, severity: "warning", message: `One answer is needed before Work can be created: ${question}`, nextAction });
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_clarification", nextAction });
        return { reason: "human_input_required", nextAction };
      }
      await this.repo.answerInboxClarification(item.id, answer);
      await emit({ type: "classification", kind: "clarification.answered", phase: "classification", inboxId: item.id, message: `Received the clarification needed for ${item.id}.` });
    }
    return null;
  }

  private async processInbox(result: AgentLoopResult, options: AgentLoopOptions, emit: (event: RunEventInput, options?: { durable?: boolean }) => Promise<RunEvent>, runId: string, answeredClarifications = new Set<string>()): Promise<{ reason: string; nextAction: string } | null> {
    const classifier = options.classify ?? (async (item: InboxItem, signal?: AbortSignal, onProgress?: import("../execution/execution-adapter.js").AdapterProgressCallback, repairReason?: string) => {
      return new PiClassificationAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi").classify(item, signal, onProgress, repairReason);
    });
    for (const item of (await this.repo.listInbox()).filter((candidate) => candidate.status === "captured")) {
      let classification: Classification;
      let repaired = false;
      try {
        if (options.dryRun) { result.actions.push({ kind: "inbox", id: item.id, action: "classification_planned", nextAction: `Classify Inbox item ${item.id}.` }); continue; }
        if (options.nonInteractive) return { reason: "human_input_required", nextAction: `Classify Inbox item ${item.id}.` };
        await emit({ type: "classification", kind: "classification.started", phase: "classification", inboxId: item.id, message: `Classifying ${item.id}.` });
        const onProgress = async (progress: import("../execution/execution-adapter.js").AdapterProgress) => { await emit({ type: "status", kind: progress.kind, phase: progress.phase, severity: progress.severity, inboxId: item.id, message: progress.message, elapsedMs: progress.elapsedMs }, { durable: progress.durable === true }); };
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
        return { reason: "classification_failed", nextAction };
      }
      await emit({ type: "classification", kind: "classification.finished", phase: "classification", inboxId: item.id, message: `Classified ${item.id} as ${classification.route}/${classification.size}.` });

      if (classification.route === "ask_direct") {
        const field = classification.clarification!.field;
        const question = clarificationQuestion(field);
        const nextAction = `Answer with \`forgium inbox answer ${item.id} <answer>\`, then run \`forgium run\` again.`;
        if (answeredClarifications.has(item.id) || options.nonInteractive || !options.answerClarification) {
          await this.repo.requestInboxClarification(item.id, field);
          await emit({ type: "gate", kind: "clarification.awaiting_answer", phase: "classification", inboxId: item.id, severity: "warning", message: `One answer is needed before Work can be created: ${question}`, nextAction });
          result.actions.push({ kind: "inbox", id: item.id, action: "needs_clarification", nextAction });
          return { reason: "human_input_required", nextAction };
        }
        const answer = (await options.answerClarification(item, question))?.trim();
        if (!answer) {
          await this.repo.requestInboxClarification(item.id, field);
          await emit({ type: "gate", kind: "clarification.awaiting_answer", phase: "classification", inboxId: item.id, severity: "warning", message: `One answer is needed before Work can be created: ${question}`, nextAction });
          result.actions.push({ kind: "inbox", id: item.id, action: "needs_clarification", nextAction });
          return { reason: "human_input_required", nextAction };
        }
        answeredClarifications.add(item.id);
        await this.repo.requestInboxClarification(item.id, field);
        await this.repo.answerInboxClarification(item.id, answer);
        await emit({ type: "classification", kind: "clarification.answered", phase: "classification", inboxId: item.id, message: `Received the clarification needed for ${item.id}.` });
        return this.processInbox(result, options, emit, runId, answeredClarifications);
      }

      const automatic = isAutomaticClassification(classification);
      let choice: HumanClassificationChoice = automatic ? "direct" : "quit";
      if (!automatic) {
        choice = options.chooseClassification && !options.nonInteractive ? await options.chooseClassification(item, classification) : "quit";
        if (choice === "quit") return { reason: classification.route === "split" ? "split_required" : "human_input_required", nextAction: `Choose direct, Spec, ADR, split, defer, or reject for ${item.id}.` };
      }
      if (options.dryRun) continue;
      if (choice === "direct") {
        if (!hasVerificationPlan(classification)) throw new Error("Direct Work creation requires a verification plan.");
        const feature = await this.repo.createFeatureFromInbox(item.id, { ...classification.proposed, verification: classification.proposed.verification, classification });
        result.actions.push({ kind: "inbox", id: item.id, action: `created:${feature.id}` });
        await emit({ type: "transition", kind: "work.transitioned", phase: "classification", inboxId: item.id, workId: feature.id, state: "ready", message: `Promoted ${item.id} to ready Work ${feature.id}.` });
      } else if (choice === "spec" || choice === "adr") {
        const updated = await this.repo.requireDefinitionForInbox(item.id, choice);
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition", nextAction: `Complete ${updated.definitionRef}.`, definitionRef: updated.definitionRef, definitionKind: updated.definitionKind });
        return { reason: "human_definition_required", nextAction: `Complete ${updated.definitionRef} and run again.` };
      } else if (choice === "defer") {
        await this.repo.deferInbox(item.id);
        result.actions.push({ kind: "inbox", id: item.id, action: "deferred" });
      } else if (choice === "reject") {
        await this.repo.rejectInbox(item.id);
        result.actions.push({ kind: "inbox", id: item.id, action: "rejected" });
      } else {
        return { reason: "split_required", nextAction: `Split ${item.id} into smaller Work items and confirm the proposal.` };
      }
    }
    return null;
  }

  private async implement(feature: Feature, options: AgentLoopOptions, emit: (event: RunEventInput, options?: { durable?: boolean }) => Promise<RunEvent>, runId: string) {
    const registry = options.registry ?? new ExecutionAdapterRegistry([new PiRpcExecutionAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi"), new SpecFlowExecutionAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi")]);
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
    const reviewer = options.reviewer ?? new PiWorkReviewAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi");
    if (!reviewer) {
      const updated = await this.repo.reviewFeature(feature.id, "needs_human", "No independent reviewer is configured.", "pi-review", undefined, runId);
      await emit({ type: "gate", kind: "review.finished", phase: "review", workId: feature.id, state: updated.state, severity: "warning", message: "Independent review needs human attention.", nextAction: "Configure Pi or record an explicit review decision." });
      return { state: updated.state, action: "needs_human", stopReason: "review_needs_human", nextAction: "Configure Pi or record an explicit review decision." };
    }
    let decision: WorkReviewDecision;
    const beforeReview = await this.repo.durableFeatureFingerprint(feature.id);
    await emit({ type: "status", kind: "review.started", phase: "review", workId: feature.id, message: `Independent review started for ${feature.id}.` });
    try {
      decision = await reviewer.review({ root: this.repo.root, feature, runId, receipts: await this.repo.listReceipts(feature.id), verification: await this.repo.listReceipts(feature.id), onProgress: async (progress) => { await emit({ type: "status", kind: progress.kind, phase: progress.phase, severity: progress.severity, workId: feature.id, message: progress.message, elapsedMs: progress.elapsedMs }, { durable: progress.durable === true }); } });
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
  return `Forgium could not create a complete Work proposal${repair}. Your Inbox is unchanged. ${classificationErrorSummary(error)}`;
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
  return "Run `forgium triage` to create the Work manually. Your Inbox has not been changed.";
}
