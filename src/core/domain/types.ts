export type FeatureState = "ready" | "doing" | "review" | "blocked" | "done";

export const FEATURE_STATES: FeatureState[] = ["ready", "doing", "review", "blocked", "done"];

export type InboxStatus = "captured" | "needs_clarification" | "needs_definition" | "needs_review" | "promoted" | "merged" | "deferred" | "rejected";
export type ClarificationField = "output_path" | "verification" | "scope";

export interface InboxClarification {
  field: ClarificationField;
  answer?: string;
}

export interface InboxItem {
  id: string;
  source: string;
  created: string;
  status: InboxStatus;
  title: string;
  body?: string;
  path: string;
  clarification?: InboxClarification;
  definitionRef?: string;
  definitionKind?: "spec" | "adr";
  featureRef?: string;
  classification?: Classification;
}

export type WorkSize = "XS" | "S" | "M" | "L" | "XL";
export type ClassificationRoute = "auto_direct" | "ask_direct" | "ask_spec" | "ask_adr" | "split";
export type ClassificationRisk = "public_api" | "persistence" | "security" | "external_integration" | "multi_package" | "unknown_impact";

export interface Classification {
  route: ClassificationRoute;
  size: WorkSize;
  estimatedTouchedFiles: number;
  complexityScore: number;
  confidence: number;
  risks: ClassificationRisk[];
  rationale: string[];
  proposed: {
    title: string;
    goal: string;
    acceptance: string[];
    verification?: VerificationPolicy;
  };
  clarification?: { field: ClarificationField };
}

export interface FeatureManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  created: string;
  source?: { type: string; ref: string };
  goal: string;
  acceptance: string[];
  constraints?: string[];
  verification: VerificationPolicy;
  classification?: Classification;
}

export interface VerificationCommand {
  name: string;
  run: string;
  timeoutMs?: number;
}

export interface RequiredEvidence {
  criterion: string;
  kind: string;
}

export interface VerificationPolicy {
  commands: VerificationCommand[];
  requiredEvidence?: RequiredEvidence[];
  review?: "required";
}

export type ReceiptKind = "execution" | "verification" | "review" | "handoff";
export type VerificationOutcome = "passed" | "failed" | "manual_required" | "not_configured" | "cancelled";
export type ReviewDecision = "approved" | "changes_requested" | "blocked" | "needs_human";

export interface ReceiptActor { type: string; name: string; version?: string }
export interface ReceiptFeatureRef { id: string; manifestPath: string }
export interface ReceiptBase {
  schemaVersion: 1;
  id: string;
  kind: ReceiptKind;
  created: string;
  feature: ReceiptFeatureRef;
  runId: string;
  actor: ReceiptActor;
  outcome: string;
  summary: string;
}

export interface VerificationCheck {
  name: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  status: "passed" | "failed" | "cancelled";
  outputSummary: string;
}

export interface ReceiptEvidence {
  criterion: string;
  kind: string;
  status: "passed" | "failed" | "pending";
  ref?: string;
}

export interface VerificationReceipt extends ReceiptBase {
  kind: "verification";
  outcome: VerificationOutcome;
  checks: VerificationCheck[];
  evidence?: ReceiptEvidence[];
}

export interface ReviewReceipt extends ReceiptBase {
  kind: "review";
  outcome: ReviewDecision;
  decision: ReviewDecision;
  findings?: string[];
}

export interface HandoffReceipt extends ReceiptBase {
  kind: "handoff";
  outcome: "failed" | "blocked" | "needs_human" | "cancelled";
  reason: string;
  relatedReceipt?: string;
}

export interface ExecutionReceipt extends ReceiptBase {
  kind: "execution";
  outcome: string;
  engine?: string;
  artifacts?: string[];
  details?: Record<string, unknown>;
}

export type Receipt = VerificationReceipt | ReviewReceipt | HandoffReceipt | ExecutionReceipt;

export interface FeatureArtifacts {
  spec?: string;
  ticketsDirectory?: string;
  notes?: string;
  research?: string;
  receiptsDirectory?: string;
}

export interface Feature {
  id: string;
  slug: string;
  state: FeatureState;
  path: string;
  manifest: FeatureManifest;
  artifacts: FeatureArtifacts;
}

export type ExecutionProfile =
  | { kind: "direct" }
  | { kind: "spec-flow"; specPath: string; ticketsPath: string; commands: { implement: string; next: string } }
  | { kind: "spec-needs-plan"; specPath: string; commands: { init: string; implement: string; next: string } };

export interface RepositoryStatus {
  inbox: Record<string, number>;
  features: Record<FeatureState, number>;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface CaptureInput { text: string; source?: string }
export interface CreateFeatureInput {
  id?: string;
  slug?: string;
  title: string;
  goal: string;
  acceptance: string[];
  constraints?: string[];
  verification: VerificationPolicy;
  classification?: Classification;
  source?: { type: string; ref: string };
}

export interface WorkReviewFinding {
  severity: "critical" | "major" | "minor";
  message: string;
  reference?: string;
}

export interface WorkReviewDecision {
  outcome: ReviewDecision;
  summary: string;
  findings: WorkReviewFinding[];
  evidence: string[];
}

export type RunEventPhase = "preflight" | "classification" | "definition" | "execution" | "verification" | "review";
export type RunEventSeverity = "info" | "warning" | "error";

export interface RunEvent {
  schemaVersion?: 2;
  eventId?: string;
  runId?: string;
  sequence?: number;
  at: string;
  type: "status" | "classification" | "transition" | "receipt" | "gate" | "stop";
  kind?: string;
  phase?: RunEventPhase;
  severity?: RunEventSeverity;
  workId?: string;
  inboxId?: string;
  state?: string;
  message: string;
  nextAction?: string;
  stopReason?: string;
  elapsedMs?: number;
}
