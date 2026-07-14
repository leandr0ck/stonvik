import { FilesystemForgiumRepository } from "../repository/filesystem-forgium-repository.js";
import type { Classification, Feature, FeatureState, InboxItem, RunEvent, WorkReviewDecision } from "../domain/types.js";
import { isAutomaticClassification, validateClassification } from "./classification.js";
import { PiClassificationAdapter } from "../execution/pi-classification-adapter.js";
import { ExecutionAdapterRegistry } from "../execution/execution-adapter.js";
import { PiRpcExecutionAdapter } from "../execution/pi-rpc-execution-adapter.js";
import { SpecFlowExecutionAdapter } from "../execution/spec-flow-execution-adapter.js";
import type { WorkReviewAdapter } from "../execution/work-review-adapter.js";
import { PiWorkReviewAdapter } from "../execution/work-review-adapter.js";

export type HumanClassificationChoice = "direct" | "spec" | "adr" | "split" | "defer" | "reject" | "quit";
export interface AgentLoopOptions {
  dryRun?: boolean;
  nonInteractive?: boolean;
  signal?: AbortSignal;
  classify?: (item: InboxItem, signal?: AbortSignal) => Promise<Classification>;
  chooseClassification?: (item: InboxItem, classification: Classification) => Promise<HumanClassificationChoice>;
  confirmDefinition?: (item: InboxItem) => Promise<boolean>;
  registry?: ExecutionAdapterRegistry;
  reviewer?: WorkReviewAdapter;
  onEvent?: (event: RunEvent) => Promise<void> | void;
}

export interface AgentLoopResult {
  root: string;
  actions: Array<{ kind: "inbox" | "work"; id: string; action: string; nextAction?: string }>;
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
    const emit = async (event: Omit<RunEvent, "at">) => {
      const full = { at: new Date().toISOString(), ...event } as RunEvent;
      if (!options.dryRun) await this.repo.persistEvent(full);
      await options.onEvent?.(full);
    };
    try {
      const validation = await this.repo.validate();
      await emit({ type: "status", message: "Validated Forgium repository." });
      if (!validation.valid) return this.stop(result, "preflight_failed", "Fix validation errors before running.", emit);
      if (options.signal?.aborted) return this.stop(result, "interrupted", "Resume with `forgium run`.", emit);

      const active = await this.repo.getActiveFeatures();
      const doing = active.filter((feature) => feature.state === "doing");
      if (doing.length > 1) return this.stop(result, "multiple_active_work", `Multiple Work items are active: ${doing.map((feature) => feature.id).join(", ")}.`, emit);
      if (active.length > 1) return this.stop(result, "multiple_active_work", `Multiple Work items are active: ${active.map((feature) => feature.id).join(", ")}.`, emit);

      if (active[0]?.state === "review") {
        const review = await this.review(active[0], options, emit);
        result.features.push({ id: active[0].id, state: review.state, action: review.action });
        if (review.stopReason) return this.stop(result, review.stopReason, review.nextAction, emit);
      } else if (active[0]?.state === "doing") {
        const execution = await this.implement(active[0], options, emit);
        result.features.push({ id: active[0].id, state: execution.feature.state, action: execution.feature.state === "ready" ? "ready_for_implementation" : execution.outcome });
        if (execution.feature.state === "review") {
          const review = await this.review(execution.feature, options, emit);
          result.features.push({ id: execution.feature.id, state: review.state, action: review.action });
          if (review.stopReason) return this.stop(result, review.stopReason, review.nextAction, emit);
        } else return this.stop(result, reasonForExecution(execution.outcome, execution.summary), execution.summary, emit);
      }

      const definitionStop = await this.processDefinitions(result, options, emit);
      if (definitionStop) return this.stop(result, definitionStop.reason, definitionStop.nextAction, emit);

      const classificationStop = await this.processInbox(result, options, emit);
      if (classificationStop) return this.stop(result, classificationStop.reason, classificationStop.nextAction, emit);

      if (options.dryRun) {
        result.features.push(...(await this.repo.listFeatures("ready")).map((feature) => ({ id: feature.id, state: feature.state, action: "planned" })));
        return this.stop(result, "dry_run", "Run without --dry-run to execute the plan.", emit);
      }

      while (true) {
        if (options.signal?.aborted) return this.stop(result, "interrupted", "Resume with `forgium run`.", emit);
        const next = await this.repo.getNextReady();
        if (!next) return this.stop(result, "idle", "Capture new intent or add ready Work.", emit);
        await emit({ type: "transition", workId: next.id, state: "ready", message: `Selected oldest ready Work ${next.id}.` });
        const execution = await this.implement(next, options, emit);
        result.features.push({ id: next.id, state: execution.feature.state, action: execution.feature.state === "ready" ? "ready_for_implementation" : execution.outcome });
        if (execution.feature.state !== "review") return this.stop(result, reasonForExecution(execution.outcome, execution.summary), execution.summary, emit);
        const review = await this.review(execution.feature, options, emit);
        result.features.push({ id: next.id, state: review.state, action: review.action });
        if (review.stopReason) return this.stop(result, review.stopReason, review.nextAction, emit);
      }
    } finally {
      await release();
    }
  }

  private async processDefinitions(result: AgentLoopResult, options: AgentLoopOptions, emit: (event: Omit<RunEvent, "at">) => Promise<void>): Promise<{ reason: string; nextAction: string } | null> {
    for (const item of (await this.repo.listInbox()).filter((candidate) => candidate.status === "needs_definition")) {
      if (options.dryRun) { result.actions.push({ kind: "inbox", id: item.id, action: "definition_confirmation_planned", nextAction: `Complete and confirm ${item.definitionRef}.` }); return { reason: "dry_run", nextAction: `Complete and confirm ${item.definitionRef}.` }; }
      if (options.nonInteractive || !options.confirmDefinition) return { reason: "human_definition_required", nextAction: `Complete and confirm ${item.definitionRef}.` };
      if (await options.confirmDefinition(item)) {
        try {
          const feature = await this.repo.confirmDefinitionForInbox(item.id);
          result.actions.push({ kind: "inbox", id: item.id, action: `definition_confirmed:${feature.id}` });
          await emit({ type: "transition", inboxId: item.id, workId: feature.id, state: "ready", message: `Confirmed definition and created ready Work ${feature.id}.` });
        } catch (error) {
          await emit({ type: "gate", inboxId: item.id, message: `Definition is invalid: ${String((error as Error).message)}`, nextAction: `Complete ${item.definitionRef} and run again.` });
          return { reason: "definition_invalid", nextAction: `Complete ${item.definitionRef} and run again.` };
        }
      } else return { reason: "human_definition_required", nextAction: `Confirm the completed definition at ${item.definitionRef}.` };
    }
    return null;
  }

  private async processInbox(result: AgentLoopResult, options: AgentLoopOptions, emit: (event: Omit<RunEvent, "at">) => Promise<void>): Promise<{ reason: string; nextAction: string } | null> {
    const classifier = options.classify ?? (async (item: InboxItem, signal?: AbortSignal) => {
      return new PiClassificationAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi").classify(item, signal);
    });
    for (const item of (await this.repo.listInbox()).filter((candidate) => candidate.status === "captured")) {
      let classification: Classification;
      try {
        if (options.dryRun) { result.actions.push({ kind: "inbox", id: item.id, action: "classification_planned", nextAction: `Classify Inbox item ${item.id}.` }); continue; }
        if (options.nonInteractive) return { reason: "human_input_required", nextAction: `Classify Inbox item ${item.id}.` };
        classification = await classifier(item, options.signal);
        const parsed = validateClassification(classification);
        await this.repo.recordClassification(item, parsed, `run-${Date.now()}`);
      } catch (error) {
        result.actions.push({ kind: "inbox", id: item.id, action: "classification_invalid", nextAction: `Review and classify Inbox item ${item.id}.` });
        await this.repo.persistEvent({ at: new Date().toISOString(), type: "gate", inboxId: item.id, message: `Classification needs human attention: ${String((error as Error).message)}`, nextAction: `Review and classify Inbox item ${item.id}.` });
        return { reason: "human_input_required", nextAction: `Review and classify Inbox item ${item.id}.` };
      }
      await emit({ type: "classification", inboxId: item.id, message: `Classified ${item.id} as ${classification.route}/${classification.size}.` });
      const automatic = isAutomaticClassification(classification);
      let choice: HumanClassificationChoice = automatic ? "direct" : "quit";
      if (!automatic) {
        choice = options.chooseClassification && !options.nonInteractive ? await options.chooseClassification(item, classification) : "quit";
        if (choice === "quit") return { reason: classification.route === "split" ? "split_required" : "human_input_required", nextAction: `Choose direct, Spec, ADR, split, defer, or reject for ${item.id}.` };
      }
      if (options.dryRun) continue;
      if (choice === "direct") {
        const feature = await this.repo.createFeatureFromInbox(item.id, { ...classification.proposed, classification });
        result.actions.push({ kind: "inbox", id: item.id, action: `created:${feature.id}` });
        await emit({ type: "transition", inboxId: item.id, workId: feature.id, state: "ready", message: `Promoted ${item.id} to ready Work ${feature.id}.` });
      } else if (choice === "spec" || choice === "adr") {
        const updated = await this.repo.requireDefinitionForInbox(item.id, choice);
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition", nextAction: `Complete ${updated.definitionRef}.` });
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

  private async implement(feature: Feature, options: AgentLoopOptions, emit: (event: Omit<RunEvent, "at">) => Promise<void>) {
    const registry = options.registry ?? new ExecutionAdapterRegistry([new PiRpcExecutionAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi"), new SpecFlowExecutionAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi")]);
    const receipts = await this.repo.listReceipts(feature.id);
    const lastExecution = [...receipts].reverse().find((receipt) => receipt.kind === "execution");
    const lastHandoff = [...receipts].reverse().find((receipt) => receipt.kind === "handoff");
    const fingerprint = await this.repo.durableFeatureFingerprint(feature.id);
    if (lastHandoff?.kind === "handoff" && lastHandoff.outcome !== "blocked" && lastExecution?.kind === "execution" && lastExecution.details?.featureFingerprint === fingerprint) {
      return { outcome: "needs_human" as const, feature, summary: "No durable change has occurred since the last implementation gate.", adapterId: lastExecution.engine };
    }
    const execution = await this.repo.executeFeature(feature.id, registry, options.signal);
    await emit({ type: "receipt", workId: feature.id, state: execution.feature.state, message: `Implementation outcome for ${feature.id}: ${execution.outcome}.` });
    return execution;
  }

  private async review(feature: Feature, options: AgentLoopOptions, emit: (event: Omit<RunEvent, "at">) => Promise<void>): Promise<{ state: FeatureState; action: string; stopReason?: string; nextAction: string }> {
    const priorReceipts = await this.repo.listReceipts(feature.id);
    const priorReview = [...priorReceipts].reverse().find((receipt) => receipt.kind === "review");
    if (priorReview?.kind === "review" && priorReview.decision === "needs_human") {
      const fingerprint = await this.repo.durableFeatureFingerprint(feature.id);
      const execution = [...priorReceipts].reverse().find((receipt) => receipt.kind === "execution");
      if (execution?.kind === "execution" && execution.details?.featureFingerprint === fingerprint) return { state: feature.state, action: "needs_human", stopReason: "review_needs_human", nextAction: "Record a human review decision or change the Work before retrying." };
    }
    const reviewer = options.reviewer ?? new PiWorkReviewAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi");
    if (!reviewer) {
      const updated = await this.repo.reviewFeature(feature.id, "needs_human", "No independent reviewer is configured.", "pi-review");
      await emit({ type: "gate", workId: feature.id, state: updated.state, message: "Independent review needs human attention.", nextAction: "Configure Pi or record an explicit review decision." });
      return { state: updated.state, action: "needs_human", stopReason: "review_needs_human", nextAction: "Configure Pi or record an explicit review decision." };
    }
    let decision: WorkReviewDecision;
    const beforeReview = await this.repo.durableFeatureFingerprint(feature.id);
    try {
      decision = await reviewer.review({ root: this.repo.root, feature, runId: `review-${Date.now()}`, receipts: await this.repo.listReceipts(feature.id), verification: await this.repo.listReceipts(feature.id) });
    } catch (error) {
      const updated = await this.repo.reviewFeature(feature.id, "needs_human", String((error as Error).message), reviewer.id);
      await emit({ type: "gate", workId: feature.id, state: updated.state, message: "Independent review needs human attention.", nextAction: "Review the Work and record an explicit decision." });
      return { state: updated.state, action: "needs_human", stopReason: "review_needs_human", nextAction: "Review the Work and record an explicit decision." };
    }
    const afterReview = await this.repo.durableFeatureFingerprint(feature.id);
    if (afterReview !== beforeReview) {
      decision = { outcome: "needs_human", summary: "The reviewer modified repository content and lost its independence.", findings: [{ severity: "critical", message: "Reviewer was not read-only." }], evidence: [] };
    }
    const updated = await this.repo.reviewFeature(feature.id, decision.outcome, decision.summary, reviewer.id, decision.findings.map((finding) => `${finding.severity}: ${finding.message}${finding.reference ? ` (${finding.reference})` : ""}`));
    await emit({ type: "receipt", workId: feature.id, state: updated.state, message: `Independent review outcome: ${decision.outcome}.` });
    if (decision.outcome === "approved") return { state: updated.state, action: "approved", nextAction: "Continue with the next ready Work." };
    if (decision.outcome === "changes_requested") return { state: updated.state, action: "changes_requested", stopReason: "changes_requested", nextAction: `Reimplement ${feature.id}; it has priority over other Work.` };
    if (decision.outcome === "blocked") return { state: updated.state, action: "blocked", stopReason: "feature_blocked", nextAction: `Resolve the blocker for ${feature.id}.` };
    return { state: updated.state, action: "needs_human", stopReason: "review_needs_human", nextAction: "Record a human review decision." };
  }

  private async stop(result: AgentLoopResult, reason: string, nextAction: string, emit: (event: Omit<RunEvent, "at">) => Promise<void>): Promise<AgentLoopResult> {
    result.stopReason = reason;
    result.nextAction = nextAction;
    await emit({ type: reason === "idle" ? "status" : "stop", message: `Loop stopped: ${reason}.`, nextAction });
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
