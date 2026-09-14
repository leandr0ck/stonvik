export class StonvikError extends Error {
  constructor(message: string, public readonly code: string, public readonly exitCode = 1) {
    super(message);
    this.name = new.target.name;
  }
}
export class StonvikRepositoryNotFoundError extends StonvikError { constructor() { super("No Git repository found. Run inside a Git repository or pass an explicit root.", "STONVIK_REPOSITORY_NOT_FOUND", 3); } }
export class StonvikNotInitializedError extends StonvikError { constructor() { super("Stonevik is not initialized. Run `stonvik init` first.", "STONVIK_NOT_INITIALIZED", 3); } }
export class ConfigInvalidError extends StonvikError { constructor(message: string) { super(`Invalid Stonvik configuration: ${message}`, "CONFIG_INVALID", 2); } }
export class InvalidInboxItemError extends StonvikError { constructor(message: string) { super(message, "INVALID_INBOX_ITEM", 2); } }
export class InvalidManifestError extends StonvikError { constructor(message: string) { super(message, "INVALID_MANIFEST", 2); } }
export class ReceiptAlreadyExistsError extends StonvikError { constructor(id: string) { super(`Receipt already exists: ${id}`, "RECEIPT_ALREADY_EXISTS", 3); } }
export class InvalidReceiptError extends StonvikError { constructor(message: string) { super(message, "INVALID_RECEIPT", 2); } }
export class ReviewReceiptRequiredError extends StonvikError { constructor(id: string) { super(`Approved review receipt required before completing Feature: ${id}`, "REVIEW_RECEIPT_REQUIRED", 2); } }
export class RunOptionsInvalidError extends StonvikError { constructor(message: string) { super(message, "RUN_OPTIONS_INVALID", 2); } }
export class FeatureNotFoundError extends StonvikError { constructor(id: string) { super(`Feature not found: ${id}`, "FEATURE_NOT_FOUND", 3); } }
export class FeatureAlreadyExistsError extends StonvikError { constructor(id: string) { super(`Feature already exists: ${id}`, "FEATURE_ALREADY_EXISTS", 3); } }
export class FeatureStateConflictError extends StonvikError { constructor(message: string) { super(message, "FEATURE_STATE_CONFLICT", 3); } }
export class InvalidStateTransitionError extends StonvikError { constructor(from: string, to: string) { super(`Invalid Feature transition: ${from} → ${to}`, "INVALID_STATE_TRANSITION", 3); } }
export class LoopAlreadyRunningError extends StonvikError { constructor() { super("Another Stonevik run loop already owns the repository lease.", "LOOP_ALREADY_RUNNING", 3); } }
export class ClassificationInvalidError extends StonvikError { constructor(message: string) { super(message, "CLASSIFICATION_INVALID", 2); } }
export class RoutingPolicyViolationError extends StonvikError { constructor(message: string) { super(message, "ROUTING_POLICY_VIOLATION", 2); } }
export class ActorInvalidError extends StonvikError { constructor(message: string) { super(message, "ACTOR_INVALID", 2); } }
export class WorkReportInvalidError extends StonvikError { constructor(message: string) { super(message, "WORK_REPORT_INVALID", 2); } }
export class WorkClaimConflictError extends StonvikError { constructor(message: string) { super(message, "WORK_CLAIM_CONFLICT", 3); } }
export class ReviewActorInvalidError extends StonvikError { constructor(message: string) { super(message, "REVIEW_ACTOR_INVALID", 2); } }
export class ReviewSelfApprovalError extends StonvikError { constructor(message: string) { super(message, "REVIEW_SELF_APPROVAL", 2); } }
