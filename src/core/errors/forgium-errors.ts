export class ForgiumError extends Error {
  constructor(message: string, public readonly code: string, public readonly exitCode = 1) {
    super(message);
    this.name = new.target.name;
  }
}
export class ForgiumRepositoryNotFoundError extends ForgiumError { constructor() { super("No Git repository found. Run inside a Git repository or pass an explicit root.", "FORGIUM_REPOSITORY_NOT_FOUND", 3); } }
export class ForgiumNotInitializedError extends ForgiumError { constructor() { super("Forgium is not initialized. Run `forgium init` first.", "FORGIUM_NOT_INITIALIZED", 3); } }
export class InvalidInboxItemError extends ForgiumError { constructor(message: string) { super(message, "INVALID_INBOX_ITEM", 2); } }
export class InvalidDraftError extends ForgiumError { constructor(message: string) { super(message, "INVALID_DRAFT", 2); } }
export class InvalidManifestError extends ForgiumError { constructor(message: string) { super(message, "INVALID_MANIFEST", 2); } }
export class DraftNotFoundError extends ForgiumError { constructor(id: string) { super(`Draft not found: ${id}`, "DRAFT_NOT_FOUND", 3); } }
export class DraftAlreadyExistsError extends ForgiumError { constructor(id: string) { super(`Draft already exists: ${id}`, "DRAFT_ALREADY_EXISTS", 3); } }
export class EditorUnavailableError extends ForgiumError { constructor() { super("No editor configured. Set $VISUAL or $EDITOR.", "EDITOR_UNAVAILABLE", 3); } }
export class ReceiptAlreadyExistsError extends ForgiumError { constructor(id: string) { super(`Receipt already exists: ${id}`, "RECEIPT_ALREADY_EXISTS", 3); } }
export class InvalidReceiptError extends ForgiumError { constructor(message: string) { super(message, "INVALID_RECEIPT", 2); } }
export class ReviewReceiptRequiredError extends ForgiumError { constructor(id: string) { super(`Approved review receipt required before completing Feature: ${id}`, "REVIEW_RECEIPT_REQUIRED", 2); } }
export class RunOptionsInvalidError extends ForgiumError { constructor(message: string) { super(message, "RUN_OPTIONS_INVALID", 2); } }
export class FeatureNotFoundError extends ForgiumError { constructor(id: string) { super(`Feature not found: ${id}`, "FEATURE_NOT_FOUND", 3); } }
export class FeatureAlreadyExistsError extends ForgiumError { constructor(id: string) { super(`Feature already exists: ${id}`, "FEATURE_ALREADY_EXISTS", 3); } }
export class FeatureStateConflictError extends ForgiumError { constructor(message: string) { super(message, "FEATURE_STATE_CONFLICT", 3); } }
export class InvalidStateTransitionError extends ForgiumError { constructor(from: string, to: string) { super(`Invalid Feature transition: ${from} → ${to}`, "INVALID_STATE_TRANSITION", 3); } }
