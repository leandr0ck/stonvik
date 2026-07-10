# Technical Specification — Loop

**Status:** Draft v0.1  
**Date:** 2026-07-09  
**Target runtime:** Node.js + TypeScript  
**Primary agent runtime:** Pi Coding Agent  
**Existing execution engine integration:** `pi-spec-flow`  
**Working name:** `Loop`

---

## 1. Purpose

Loop is a repository-native operating system for software development agents.

Its purpose is to let a software repository expose a durable, machine-readable queue of product work that agents can:

1. capture from multiple sources,
2. classify,
3. promote into executable Features,
4. execute directly or through a spec-driven engine,
5. review,
6. block and resume,
7. complete,
8. repeat in a loop.

Loop is not intended to replace issue trackers, project-management suites, or `pi-spec-flow`.

Loop sits one level above feature execution.

Its central responsibility is:

> Determine what work exists, what is ready, what should run next, and which execution engine should handle it.

The design assumes that the primary consumer of repository workflow state is an agent, not a human.

Git is the durable storage layer.  
The Loop core is the workflow engine.  
Pi is the primary reasoning and implementation runtime.  
`pi-spec-flow` remains the execution engine for large, spec-driven Features.

---

## 2. Design Principles

### 2.1 Repository as system state

Workflow state must be stored in the repository whenever possible.

Advantages:

- version history,
- auditability,
- resumability,
- branch compatibility,
- portability,
- human inspectability,
- agent-independent persistence.

No database is required for v0.1.

---

### 2.2 Core logic must be deterministic

Operations that can be implemented reliably in normal code must not consume LLM tokens.

Examples:

- creating files,
- validating schemas,
- reading the Inbox,
- enumerating Features,
- moving a Feature between states,
- detecting `spec.md`,
- detecting `tickets/`,
- selecting candidates by deterministic rules,
- validating state transitions,
- generating status summaries.

LLM reasoning is reserved for:

- Inbox triage,
- semantic duplicate detection,
- Feature enrichment,
- implementation,
- review,
- blocker investigation,
- spec generation or execution.

---

### 2.3 Producers are decoupled from consumers

Any producer may write an Inbox item.

Initial producer:

- CLI

Future producers:

- Pi extension,
- GitHub integration,
- WhatsApp,
- mobile capture app,
- webhooks,
- code-review agents,
- security agents,
- monitoring systems,
- CI jobs.

All producers converge on the same Inbox format.

No producer needs to understand Features, Specs, Tickets, or execution state.

---

### 2.4 One executable product entity: Feature

Loop has two product concepts:

1. **Inbox Item** — raw captured intent.
2. **Feature** — approved executable work.

A Feature may be very small or very large.

A Feature is always represented by a directory containing a required `manifest.yaml`.

Optional artifacts may be added as needed:

- `spec.md`
- `tickets/`
- `notes.md`
- `research.md`
- `screenshots/`
- other future artifacts

The Feature remains the same entity regardless of complexity.

---

### 2.5 Structure indicates capabilities

Avoid redundant flags when state can be inferred safely from the repository.

Examples:

- presence of `spec.md` means a spec exists,
- presence of `tickets/` means ticket-based execution artifacts exist,
- Feature location indicates workflow state.

Avoid fields such as:

```yaml
needs_spec: true
execution_mode: spec
tickets_path: ./tickets
```

unless future requirements prove they are necessary.

---

### 2.6 State must have one authoritative representation per level

Feature state is represented by directory location:

```text
features/ready/
features/doing/
features/review/
features/blocked/
features/done/
```

Ticket state inside `pi-spec-flow` remains represented by the ticket metadata already managed by that tool.

Loop must not move individual `pi-spec-flow` tickets between state directories.

The entire Feature directory moves between Feature states.

---

## 3. High-Level Workflow

```text
Capture
   ↓
Inbox
   ↓
Triage
   ↓
Feature Ready
   ↓
Execution
   ↓
Review
   ↓
Done
```

Blocked work branches from execution or review:

```text
doing ──failure/blocker──→ blocked
blocked ──resolved───────→ ready
```

The canonical product lifecycle is:

```text
Inbox Item
   ↓
Feature
   ↓
Done
```

Specs and Tickets are artifacts of a Feature, not separate top-level entities in Loop.

---

## 4. Repository Structure

### 4.1 Minimal project structure

```text
/
├── AGENTS.md
├── README.md
│
├── product/
│   ├── inbox/
│   └── roadmap.md
│
└── features/
    ├── ready/
    ├── doing/
    ├── review/
    ├── blocked/
    └── done/
```

Loop must not require `roadmap.md` for runtime operation. It is optional product context.

---

### 4.2 Small Feature example

```text
features/
└── ready/
    └── add-whatsapp-button/
        └── manifest.yaml
```

---

### 4.3 Large Feature example

```text
features/
└── ready/
    └── progressive-web-app/
        ├── manifest.yaml
        ├── spec.md
        ├── tickets/
        │   ├── 001-create-manifest.md
        │   ├── 002-service-worker.md
        │   ├── 003-install-prompt.md
        │   └── 004-icons.md
        ├── notes.md
        └── research.md
```

The internal layout of `tickets/` is owned by the `pi-spec-flow` adapter and should preserve compatibility with the existing `pi-spec-flow` ticket format.

---

## 5. Inbox Item Format

### 5.1 Goals

Inbox capture must be:

- fast,
- low-friction,
- source-agnostic,
- minimally structured,
- stable enough for automation,
- easy to generate without an LLM.

The Inbox is not a backlog and not an execution queue.

It is an intake boundary.

---

### 5.2 Filename

Recommended:

```text
product/inbox/20260709T114512-0300-a8f4.md
```

Format:

```text
<timestamp>-<short-random-id>.md
```

Requirements:

- stable,
- collision-resistant,
- not derived from the title,
- sortable approximately by creation time.

The title may change during triage; the filename should not need to change.

---

### 5.3 Inbox schema

```md
---
id: inbox-20260709T114512-0300-a8f4
source: cli
created: 2026-07-09T11:45:12-03:00
status: captured
---

# Add WhatsApp button

Add a floating WhatsApp button to the storefront so customers can contact the store directly.
```

Required fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Stable identifier |
| `source` | string | Producer identifier |
| `created` | ISO-8601 datetime | Creation timestamp |
| `status` | enum | `captured` for v0.1 |

Body requirements:

- one H1 title,
- optional free-form description.

The capture command must not ask for priority, effort, module, acceptance criteria, or implementation approach.

---

### 5.4 Source examples

```yaml
source: cli
```

Future examples:

```yaml
source: pi
source: github
source: whatsapp
source: reviewer-agent
source: security-agent
source: api
```

No strict enum is required initially. The value should be validated as a non-empty slug-like string.

---

## 6. Feature Manifest Format

### 6.1 Purpose

`manifest.yaml` is the contract between Loop and the executing agent.

It describes what the Feature must achieve.

It must not duplicate:

- workflow state already represented by directory location,
- existence of Specs,
- existence of Tickets,
- implementation engine choice if it can be inferred,
- ticket progress.

---

### 6.2 Recommended v0.1 schema

```yaml
schemaVersion: 1

id: feature-add-whatsapp-button
title: Add WhatsApp Button
created: 2026-07-09T12:00:00-03:00
source:
  type: inbox
  ref: inbox-20260709T114512-0300-a8f4

goal: >
  Add a floating WhatsApp button to the storefront so customers can start
  a conversation with the store directly from the storefront.

acceptance:
  - The WhatsApp button is visible on the storefront.
  - The button opens a WhatsApp conversation using the store's configured phone number.
  - The button is hidden when no WhatsApp number is configured.
  - The UI remains consistent with the existing storefront design.

constraints:
  - Do not hardcode tenant-specific phone numbers.
  - Do not render the button in admin screens.
  - Do not modify the checkout flow.
```

---

### 6.3 Required fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | integer | Manifest schema version |
| `id` | string | Stable Feature identifier |
| `title` | string | Human-readable title |
| `created` | ISO-8601 datetime | Creation timestamp |
| `goal` | string | Desired outcome |
| `acceptance` | string[] | Observable completion criteria |

Optional fields:

| Field | Type | Description |
|---|---|---|
| `source` | object | Origin reference |
| `constraints` | string[] | Explicit implementation boundaries |

Do not add fields without a concrete consumer.

---

### 6.4 Large Feature manifest

The manifest schema does not change because the Feature is large.

```yaml
schemaVersion: 1

id: feature-progressive-web-app
title: Progressive Web App
created: 2026-07-09T12:15:00-03:00
source:
  type: inbox
  ref: inbox-20260709T115900-0300-b2c1

goal: >
  Make tenant storefronts installable as Progressive Web Apps while preserving
  tenant-specific branding and the current Cloudflare deployment model.

acceptance:
  - Storefronts expose a valid web app manifest.
  - Tenant-specific name, colors and icons are supported.
  - Supported devices can install the storefront.
  - Offline navigation failure is handled gracefully.
  - Existing storefront routing continues to work.

constraints:
  - Preserve multi-tenant isolation.
  - Do not break server-side rendering.
  - Remain compatible with the current deployment architecture.
```

The execution model is inferred from Feature artifacts.

Example:

```text
manifest.yaml
spec.md
tickets/
```

Loop sees the artifacts and delegates to the Spec Flow execution adapter.

---

## 7. Feature State Model

### 7.1 States

```text
ready
doing
review
blocked
done
```

### 7.2 Allowed transitions

```text
ready   → doing
doing   → review
doing   → blocked
review  → done
review  → doing
review  → blocked
blocked → ready
```

Direct transition:

```text
doing → done
```

may be supported as an explicit configuration option, but should not be the default.

---

### 7.3 Atomic movement

State transitions are implemented by moving the entire Feature directory.

Example:

```text
features/ready/add-whatsapp-button/
```

to:

```text
features/doing/add-whatsapp-button/
```

Requirements:

- fail if destination exists,
- preserve all artifacts,
- use same filesystem rename where possible,
- validate manifest before transition,
- emit clear errors,
- never partially copy state.

---

## 8. Architecture

### 8.1 Recommended monorepo

```text
loop/
├── packages/
│   ├── core/
│   ├── cli/
│   ├── pi-extension/
│   ├── pi-runtime/
│   └── spec-flow-adapter/
│
├── package.json
├── tsconfig.json
└── README.md
```

A single package is acceptable for the earliest prototype, but modules should preserve these boundaries internally.

---

## 9. Package Responsibilities

### 9.1 `@loop/core`

Pure workflow and repository logic.

Must not depend on:

- Pi,
- an LLM provider,
- `pi-spec-flow` internals,
- terminal UI.

Responsibilities:

- repo discovery,
- initialization,
- path conventions,
- Inbox parsing,
- manifest parsing,
- schema validation,
- Feature enumeration,
- Feature state transitions,
- Feature artifact inspection,
- deterministic candidate selection,
- status aggregation,
- filesystem locking or execution lease support,
- domain errors.

Suggested public API:

```ts
export interface LoopRepository {
  init(options?: InitOptions): Promise<void>;

  capture(input: CaptureInput): Promise<InboxItem>;
  listInbox(): Promise<InboxItem[]>;

  createFeature(input: CreateFeatureInput): Promise<Feature>;
  listFeatures(state?: FeatureState): Promise<Feature[]>;
  getFeature(id: string): Promise<Feature | null>;
  getNextReady(options?: NextFeatureOptions): Promise<Feature | null>;

  startFeature(id: string): Promise<Feature>;
  submitForReview(id: string): Promise<Feature>;
  completeFeature(id: string): Promise<Feature>;
  blockFeature(id: string, reason: string): Promise<Feature>;
  unblockFeature(id: string): Promise<Feature>;

  inspectExecutionMode(id: string): Promise<ExecutionProfile>;
  getStatus(): Promise<RepositoryStatus>;
  validate(): Promise<ValidationReport>;
}
```

---

### 9.2 `@loop/cli`

Human-facing deterministic CLI.

Initial commands:

```text
loop init
loop capture
loop inbox
loop status
loop validate
```

Later commands may expose orchestration entrypoints:

```text
loop triage
loop work
loop review
loop run
```

The CLI calls Core APIs. It must not duplicate repository logic.

---

### 9.3 `@loop/pi-extension`

Interactive Pi integration.

Responsibilities:

- register Loop slash commands,
- register optional Loop tools callable by the agent,
- display status,
- trigger triage,
- trigger one Feature execution,
- trigger repository review,
- call Core and Runtime APIs.

Suggested commands:

```text
/loop-status
/loop-triage
/loop-work
/loop-review
```

The extension must stay thin.

It must not own filesystem traversal or state-transition rules.

---

### 9.4 `@loop/pi-runtime`

Agentic reasoning and direct implementation executor.

Responsibilities:

- create or reuse Pi agent sessions,
- run triage prompts,
- produce structured Feature candidates,
- execute direct Features,
- perform Feature review,
- investigate blockers,
- return structured execution results.

The runtime should use Pi's programmatic SDK when embedded in Node/TypeScript.

RPC may be supported later for process isolation or cross-language clients.

---

### 9.5 `@loop/spec-flow-adapter`

Adapter between Loop Feature execution and the existing `pi-spec-flow` workflow.

Responsibilities:

- identify a Feature as spec-driven based on artifacts,
- map the Feature directory to the existing `pi-spec-flow` feature key and ticket path expectations,
- invoke existing Spec Flow commands or programmatic entrypoints,
- observe completion/failure,
- report normalized execution results to Loop,
- avoid duplicating Spec Flow ticket state management.

The adapter must treat `pi-spec-flow` as the owner of:

- implementation planning,
- ticket ordering,
- ticket status,
- checkpoint handoffs,
- checkpoint review behavior.

Loop owns:

- Feature queue selection,
- Feature state,
- delegation,
- final Feature lifecycle.

---

## 10. Execution Profile Detection

Loop needs to determine how to execute a Feature.

### 10.1 Direct Feature

```text
feature/
└── manifest.yaml
```

Execution profile:

```ts
{
  kind: "direct"
}
```

---

### 10.2 Spec-driven Feature

```text
feature/
├── manifest.yaml
├── spec.md
└── tickets/
```

Execution profile:

```ts
{
  kind: "spec-flow",
  specPath: ".../spec.md",
  ticketsPath: ".../tickets"
}
```

---

### 10.3 Planned but not expanded Feature

Possible intermediate state:

```text
feature/
├── manifest.yaml
└── spec.md
```

Execution profile:

```ts
{
  kind: "spec-needs-plan",
  specPath: ".../spec.md"
}
```

Behavior for v0.1 should be explicit:

- either reject execution and require ticket generation,
- or delegate to Spec Flow initialization before implementation.

Recommended behavior:

> The Spec Flow adapter should initialize the plan if `spec.md` exists and `tickets/` does not.

This keeps the Feature artifact model uniform.

---

## 11. Commands

### 11.1 `loop init`

Purpose:

Initialize Loop structures in the current repository.

Behavior:

1. discover Git repository root,
2. create missing directories,
3. create optional `.gitkeep` files only if necessary,
4. never overwrite existing `AGENTS.md`,
5. optionally append a small Loop protocol section to `AGENTS.md` only with explicit user approval,
6. validate created structure.

Creates:

```text
product/inbox/
features/ready/
features/doing/
features/review/
features/blocked/
features/done/
```

Optional:

```text
product/roadmap.md
```

---

### 11.2 `loop capture`

Purpose:

Create an Inbox item with minimal friction.

Examples:

```bash
loop capture "Add WhatsApp button"
```

```bash
loop capture
```

```bash
echo "Add PWA support" | loop capture
```

Input precedence:

1. positional argument,
2. stdin,
3. interactive editor or prompt.

Behavior:

1. generate stable Inbox ID,
2. capture source as `cli`,
3. timestamp in ISO-8601,
4. derive title from first line,
5. preserve optional body,
6. write atomically.

Output:

```text
Captured inbox-20260709T114512-0300-a8f4
product/inbox/20260709T114512-0300-a8f4.md
```

No LLM call.

---

### 11.3 `loop inbox`

Purpose:

Inspect raw Inbox state.

Possible outputs:

```bash
loop inbox
loop inbox --json
```

Default human output may list:

- ID,
- created date,
- source,
- title.

Agents should consume the Core API or JSON output.

---

### 11.4 `loop triage`

Purpose:

Transform Inbox items into executable Feature proposals.

This is agentic.

High-level algorithm:

1. load unprocessed Inbox items,
2. load active and recently completed Feature manifests,
3. provide repository context necessary for classification,
4. ask Pi to classify each item,
5. validate structured output,
6. apply deterministic actions.

Allowed outcomes:

```text
promote
merge
discard
defer
needs-clarification
```

For v0.1, recommended outcomes:

```text
promote
merge
defer
needs-clarification
```

Avoid automatic deletion.

#### Promote

Creates:

```text
features/ready/<feature-slug>/manifest.yaml
```

Then archives or annotates the Inbox source.

Recommended archive mechanism:

```text
product/inbox/.processed/
```

is intentionally not part of the minimal design.

Better initial behavior:

- keep Inbox file,
- update `status: promoted`,
- add `featureRef`.

Example:

```yaml
status: promoted
featureRef: feature-add-whatsapp-button
```

This avoids losing provenance.

A future compaction command may archive processed Inbox items.

---

### 11.5 `loop status`

Purpose:

Provide repository-level operational summary.

Example:

```text
Inbox
  captured: 8
  promoted: 21

Features
  ready: 5
  doing: 1
  review: 2
  blocked: 1
  done: 147
```

Options:

```bash
loop status --json
loop status --verbose
```

No LLM call.

---

### 11.6 `loop work`

Purpose:

Execute one Feature from the ready queue.

Algorithm:

1. call `getNextReady()`,
2. acquire Feature execution lease,
3. move Feature `ready → doing`,
4. inspect execution profile,
5. dispatch to executor,
6. run verification,
7. move `doing → review` on successful implementation,
8. move `doing → blocked` on classified blocker,
9. preserve `doing` on process crash if lease recovery is needed,
10. emit execution summary.

Pseudo-code:

```ts
const feature = await repository.getNextReady();

if (!feature) {
  return { status: "idle" };
}

await repository.startFeature(feature.id);

const profile = await repository.inspectExecutionMode(feature.id);
const executor = executorRegistry.resolve(profile);

const result = await executor.execute(feature);

if (result.status === "success") {
  await repository.submitForReview(feature.id);
} else if (result.status === "blocked") {
  await repository.blockFeature(feature.id, result.reason);
}

return result;
```

---

### 11.7 `loop review`

Two meanings must not be conflated.

#### Feature review

Review one Feature in:

```text
features/review/
```

If successful:

```text
review → done
```

If changes are required:

```text
review → doing
```

#### System review

GTD-inspired repository review.

Recommended separate command:

```bash
loop review-system
```

or:

```bash
loop review --system
```

It examines:

- stale Inbox items,
- duplicate captures,
- stale Ready Features,
- Doing Features with expired leases,
- Blocked Features,
- Review backlog,
- Features with inconsistent artifacts.

For v0.1, implement only deterministic diagnostics.

Agentic recommendations may be added later.

---

### 11.8 `loop run`

Purpose:

Autonomous bounded execution loop.

Do not implement an unbounded infinite loop initially.

Recommended interface:

```bash
loop run --max-features 3
```

or:

```bash
loop run --until-empty
```

Algorithm:

```text
repeat:
  select next ready Feature
  execute
  submit/review depending on configured policy
  stop on:
    - no ready work
    - max feature count reached
    - unrecoverable error
    - user interrupt
    - safety policy requiring approval
```

The default should be bounded.

Recommended default:

```text
--max-features 1
```

The user must opt into longer unattended runs.

---

## 12. Agent Tools

The Pi extension may register tools callable by the model.

Recommended tools:

```text
loop_get_status
loop_list_inbox
loop_get_next_feature
loop_get_feature
loop_start_feature
loop_submit_feature
loop_complete_feature
loop_block_feature
```

### Important rule

The agent should not perform raw shell `mv` operations to manipulate workflow state.

It should call Loop tools so transitions remain validated and observable.

---

## 13. Executor Architecture

Define a common executor interface.

```ts
export interface FeatureExecutor {
  readonly kind: string;

  canHandle(profile: ExecutionProfile): boolean;

  execute(
    feature: Feature,
    context: ExecutionContext
  ): Promise<ExecutionResult>;
}
```

Result:

```ts
type ExecutionResult =
  | {
      status: "success";
      summary: string;
      evidence?: VerificationEvidence[];
    }
  | {
      status: "blocked";
      reason: string;
      recoverable: boolean;
    }
  | {
      status: "failed";
      error: string;
    };
```

Initial executors:

```text
DirectFeatureExecutor
SpecFlowFeatureExecutor
```

Future:

```text
ResearchFeatureExecutor
MigrationFeatureExecutor
BugFixExecutor
SecurityRemediationExecutor
```

The orchestrator must not contain executor-specific implementation logic.

---

## 14. Direct Feature Execution

For a direct Feature:

```text
features/doing/add-whatsapp-button/
└── manifest.yaml
```

The Pi runtime creates an implementation session with:

1. project instructions,
2. Feature manifest,
3. repository path,
4. constraints,
5. required verification instructions.

Suggested prompt contract:

```text
You are implementing one Loop Feature.

Read:
- AGENTS.md
- <feature-dir>/manifest.yaml

Implement the Feature completely.

Requirements:
- satisfy every acceptance criterion,
- respect all constraints,
- inspect the existing architecture before editing,
- run relevant tests and validation,
- do not change Loop workflow state directly,
- return a structured completion report with:
  - summary,
  - files changed,
  - verification executed,
  - unresolved issues,
  - blocker classification if incomplete.
```

Loop, not the agent, performs final state transition.

---

## 15. Spec Flow Execution

For a spec-driven Feature:

```text
features/doing/progressive-web-app/
├── manifest.yaml
├── spec.md
└── tickets/
```

Loop delegates execution to the Spec Flow adapter.

The adapter should preserve the existing workflow semantics of `pi-spec-flow`, including:

- sequenced implementation plans,
- focused coding blocks,
- ticket status updates,
- handoffs,
- feature scoping,
- optional checkpoint reviews.

Loop should only treat the Feature as complete when the adapter reports that all required implementation tickets are complete and Spec Flow's completion criteria are satisfied.

The Feature directory then moves:

```text
features/doing/progressive-web-app/
```

to:

```text
features/review/progressive-web-app/
```

Review completion moves it to:

```text
features/done/progressive-web-app/
```

---

## 16. Triage Architecture

Triage converts raw capture into executable intent.

### 16.1 Input

- one or more Inbox items,
- active Feature manifests,
- optionally relevant repository context,
- optional roadmap context.

### 16.2 Output contract

Use structured output validated by Zod.

Example:

```ts
const TriageDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("promote"),
    inboxId: z.string(),
    feature: FeatureDraftSchema,
  }),

  z.object({
    action: z.literal("merge"),
    inboxId: z.string(),
    targetFeatureId: z.string(),
    note: z.string(),
  }),

  z.object({
    action: z.literal("defer"),
    inboxId: z.string(),
    reason: z.string(),
  }),

  z.object({
    action: z.literal("needs-clarification"),
    inboxId: z.string(),
    questions: z.array(z.string()).min(1),
  }),
]);
```

### 16.3 Promotion output

A promoted Feature draft contains:

```ts
interface FeatureDraft {
  id: string;
  slug: string;
  title: string;
  goal: string;
  acceptance: string[];
  constraints?: string[];
}
```

The deterministic Core writes `manifest.yaml`.

The LLM must not choose filesystem paths directly.

---

## 17. Feature Selection

For v0.1, selection should be deterministic.

Recommended default:

1. oldest ready Feature first,
2. tie-break by Feature ID.

Do not ask the LLM which Feature to execute in v0.1.

Later optional selectors:

- explicit priority metadata,
- dependency-aware ordering,
- roadmap phase,
- estimated cost,
- agent specialization,
- user-defined policy.

Selection strategy interface:

```ts
export interface FeatureSelector {
  select(features: Feature[]): Promise<Feature | null>;
}
```

Initial implementation:

```text
OldestFirstFeatureSelector
```

---

## 18. Concurrency and Locking

Even if v0.1 runs one Feature at a time, the data model should avoid obvious concurrency hazards.

### 18.1 Execution lease

When a Feature moves to `doing`, create:

```text
.loop-lock.json
```

inside the Feature directory.

Example:

```json
{
  "runId": "run-20260709T130000Z-d7e1",
  "startedAt": "2026-07-09T10:00:00-03:00",
  "host": "leandro-macbook",
  "pid": 48211
}
```

This file is operational and may be gitignored.

Alternative:

Store runtime leases under:

```text
.loop/runtime/
```

Recommended for v0.1:

```text
.loop/runtime/runs/
```

so runtime locks do not pollute Feature history.

Repository-persistent state remains in Git; ephemeral process state lives in `.loop/runtime/`.

Suggested `.gitignore`:

```gitignore
.loop/runtime/
```

---

## 19. Configuration

Optional project configuration:

```text
loop.config.json
```

Initial schema:

```json
{
  "$schema": "./loop.schema.json",
  "paths": {
    "inbox": "./product/inbox",
    "features": "./features"
  },
  "execution": {
    "defaultMaxFeatures": 1,
    "reviewRequired": true
  },
  "specFlow": {
    "enabled": true
  }
}
```

Defaults should work without config.

Avoid exposing settings that have no proven use case.

---

## 20. Domain Types

Suggested types:

```ts
export type FeatureState =
  | "ready"
  | "doing"
  | "review"
  | "blocked"
  | "done";

export interface InboxItem {
  id: string;
  source: string;
  created: string;
  status: "captured" | "promoted" | "merged" | "deferred";
  title: string;
  body?: string;
  path: string;
  featureRef?: string;
}

export interface FeatureManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  created: string;
  source?: {
    type: string;
    ref: string;
  };
  goal: string;
  acceptance: string[];
  constraints?: string[];
}

export interface Feature {
  id: string;
  slug: string;
  state: FeatureState;
  path: string;
  manifest: FeatureManifest;
  artifacts: FeatureArtifacts;
}

export interface FeatureArtifacts {
  spec?: string;
  ticketsDirectory?: string;
  notes?: string;
  research?: string;
}
```

---

## 21. Error Model

Use typed domain errors.

Examples:

```text
LoopRepositoryNotFoundError
LoopNotInitializedError
InvalidInboxItemError
InvalidManifestError
FeatureNotFoundError
FeatureStateConflictError
InvalidStateTransitionError
FeatureAlreadyExistsError
FeatureExecutionLeaseError
ExecutorNotFoundError
SpecFlowAdapterError
```

CLI exit codes:

```text
0  success
1  generic failure
2  invalid input or schema
3  invalid workflow state
4  execution failure
5  blocked work
```

Exact codes may change before public release, but errors must be machine-readable in `--json` mode.

---

## 22. Logging and Observability

Every orchestration run should have a stable `runId`.

Structured events:

```text
run.started
feature.selected
feature.started
executor.resolved
execution.started
execution.completed
execution.blocked
review.started
feature.completed
run.completed
run.failed
```

For v0.1:

- console output for humans,
- JSON Lines optional for automation.

Example:

```bash
loop work --json
```

Output:

```json
{"event":"feature.selected","featureId":"feature-add-whatsapp-button"}
{"event":"feature.started","featureId":"feature-add-whatsapp-button"}
{"event":"execution.completed","featureId":"feature-add-whatsapp-button"}
{"event":"feature.submitted_for_review","featureId":"feature-add-whatsapp-button"}
```

---

## 23. Security and Safety

### 23.1 Repository boundary

Core must discover and enforce the repository root.

Reject path traversal outside it unless explicitly configured.

### 23.2 State transitions

Agents must not be asked to move workflow directories directly.

Use registered tools or Core APIs.

### 23.3 Autonomous run limits

Default `loop run` to one Feature.

Longer loops require explicit configuration or flag.

### 23.4 Dangerous commands

Execution remains subject to Pi's normal tool permissions and project instructions.

Loop should not bypass Pi safety mechanisms.

### 23.5 Secrets

Inbox items and manifests must not intentionally store secrets.

Future producers such as WhatsApp or webhooks must sanitize sensitive values before writing captures.

---

## 24. Testing Strategy

### 24.1 Core unit tests

Test:

- ID generation,
- timestamp handling,
- Inbox parser,
- manifest parser,
- schema validation,
- Feature enumeration,
- allowed transitions,
- invalid transitions,
- atomic moves,
- duplicate IDs,
- artifact detection,
- next Feature selection,
- status aggregation.

### 24.2 Filesystem integration tests

Use temporary Git-like fixtures.

Scenarios:

- empty repo,
- initialized repo,
- small Feature,
- large Feature,
- blocked Feature,
- malformed manifest,
- destination conflict,
- crash recovery,
- concurrent start attempt.

### 24.3 CLI tests

Test:

```text
loop init
loop capture
loop inbox
loop status
loop validate
```

Include:

- plain output,
- JSON output,
- stdin input,
- argument input.

### 24.4 Agentic contract tests

Do not test exact natural language.

Test that:

- triage output validates against schema,
- malformed LLM output is rejected or retried,
- direct execution result matches `ExecutionResult`,
- blocker response maps correctly,
- review result maps correctly.

### 24.5 Spec Flow adapter tests

Use fixtures reflecting the actual `pi-spec-flow` feature/ticket format.

Test:

- spec without tickets,
- tickets partially complete,
- all tickets complete,
- blocked ticket,
- adapter invocation failure,
- completion reporting.

---

## 25. Implementation Phases

### Phase 1 — Repository Core

Deliver:

- `loop init`
- `loop capture`
- `loop inbox`
- `loop status`
- `loop validate`
- schemas,
- repository abstraction,
- state transitions,
- tests.

No LLM.

Success criterion:

A user can initialize a repository, capture multiple Inbox items, manually create Feature manifests, and inspect/transition Feature state programmatically.

---

### Phase 2 — Pi Triage

Deliver:

- Pi SDK integration,
- triage prompt,
- structured output,
- Feature promotion,
- duplicate/merge proposal,
- `/loop-triage` Pi command.

Success criterion:

Raw Inbox items can be converted into valid Features without manually writing `manifest.yaml`.

---

### Phase 3 — Direct Execution

Deliver:

- `DirectFeatureExecutor`,
- `loop work`,
- `/loop-work`,
- Feature lease,
- structured execution result,
- doing/review/blocked transitions.

Success criterion:

A small Feature containing only `manifest.yaml` can be implemented by Pi end to end and moved to review.

---

### Phase 4 — Spec Flow Adapter

Deliver:

- execution-profile detection,
- `SpecFlowFeatureExecutor`,
- integration with existing `pi-spec-flow`,
- completion reporting.

Success criterion:

A Feature with Spec Flow artifacts can be selected by Loop, delegated to Spec Flow, completed ticket by ticket under Spec Flow's existing model, and returned to Loop for Feature-level review.

---

### Phase 5 — Review

Deliver:

- direct Feature review,
- spec-driven Feature review adapter behavior,
- review → done,
- review → doing,
- review → blocked.

Success criterion:

Feature completion is separated from implementation success.

---

### Phase 6 — Bounded Autonomous Loop

Deliver:

```bash
loop run --max-features N
loop run --until-empty
```

Include:

- Ctrl+C handling,
- bounded default,
- run summaries,
- failure isolation,
- lease recovery.

Success criterion:

The system can process multiple ready Features sequentially without manual selection.

---

### Phase 7 — Additional Producers

Candidates:

- Pi capture tool,
- GitHub Issue producer,
- GitHub review finding producer,
- WhatsApp capture gateway,
- mobile shortcut,
- HTTP API.

All producers must write the canonical Inbox format or call `capture()`.

---

## 26. MVP Scope

The recommended MVP is deliberately smaller than the full vision.

### MVP commands

```text
loop init
loop capture
loop inbox
loop status
loop validate
loop triage
loop work
```

### MVP executors

```text
DirectFeatureExecutor
SpecFlowFeatureExecutor
```

### MVP storage

```text
Git repository files only
```

### MVP producer

```text
CLI only
```

### MVP agent runtime

```text
Pi SDK
```

### MVP integration

```text
existing pi-spec-flow
```

Do not build initially:

- daemon,
- web dashboard,
- database,
- distributed queue,
- multi-agent parallel scheduler,
- WhatsApp integration,
- GitHub App,
- mobile app,
- semantic vector database,
- priority engine,
- dependency DAG,
- automatic infinite loop.

---

## 27. Non-Goals

Loop v0.1 is not:

- Jira,
- Linear,
- GitHub Projects,
- a generic Kanban board,
- a replacement for `pi-spec-flow`,
- a replacement for Git,
- a parallel distributed scheduler,
- an LLM provider abstraction layer,
- an issue tracker optimized primarily for humans.

---

## 28. Recommended Technology Stack

```text
Language:
TypeScript

Runtime:
Node.js

Package management:
npm or pnpm

CLI:
citty, cac, or commander

Schema validation:
Zod

YAML:
yaml

Agent runtime:
Pi SDK

Interactive agent integration:
Pi Extension

Large Feature engine:
pi-spec-flow

Storage:
Git repository + Markdown + YAML

Testing:
Vitest
```

Final CLI library selection should be made during implementation based on desired ESM support, command nesting, typed parsing ergonomics, and dependency footprint.

---

## 29. Suggested Internal Module Layout

```text
packages/core/src/
├── domain/
│   ├── inbox-item.ts
│   ├── feature.ts
│   ├── feature-state.ts
│   └── execution-profile.ts
│
├── schemas/
│   ├── inbox.schema.ts
│   ├── manifest.schema.ts
│   └── config.schema.ts
│
├── repository/
│   ├── loop-repository.ts
│   ├── filesystem-loop-repository.ts
│   ├── repo-discovery.ts
│   └── paths.ts
│
├── services/
│   ├── capture-service.ts
│   ├── feature-service.ts
│   ├── status-service.ts
│   ├── validation-service.ts
│   └── selector-service.ts
│
├── transitions/
│   ├── transition-rules.ts
│   └── transition-service.ts
│
└── errors/
    └── loop-errors.ts
```

Pi runtime:

```text
packages/pi-runtime/src/
├── session/
│   └── pi-session-factory.ts
├── triage/
│   ├── triage-agent.ts
│   ├── triage-prompt.ts
│   └── triage-schema.ts
├── execution/
│   ├── direct-feature-executor.ts
│   └── execution-result.ts
└── review/
    └── feature-reviewer.ts
```

Adapter:

```text
packages/spec-flow-adapter/src/
├── spec-flow-executor.ts
├── spec-flow-inspector.ts
└── spec-flow-result-mapper.ts
```

---

## 30. Example End-to-End Flow

### Step 1: Capture

```bash
loop capture "Agregar un botón flotante de WhatsApp en la tienda"
```

Creates:

```text
product/inbox/20260709T140000-0300-a8f4.md
```

---

### Step 2: Triage

```bash
loop triage
```

Pi returns a validated promotion decision.

Core creates:

```text
features/ready/add-whatsapp-button/
└── manifest.yaml
```

The Inbox item is updated:

```yaml
status: promoted
featureRef: feature-add-whatsapp-button
```

---

### Step 3: Work

```bash
loop work
```

Core:

1. selects Feature,
2. moves it to `doing`,
3. sees only `manifest.yaml`,
4. resolves `DirectFeatureExecutor`.

Pi implements the Feature and returns verification evidence.

Loop moves the Feature to:

```text
features/review/add-whatsapp-button/
```

---

### Step 4: Review

```bash
loop review
```

Review passes.

Loop moves:

```text
features/review/add-whatsapp-button/
```

to:

```text
features/done/add-whatsapp-button/
```

---

## 31. Example Large Feature Flow

### Capture

```bash
loop capture "Convertir las tiendas en PWAs instalables"
```

### Triage

Creates:

```text
features/ready/progressive-web-app/
└── manifest.yaml
```

### Spec creation

The Feature is enriched with:

```text
spec.md
```

### Spec Flow planning

`pi-spec-flow` generates its ticket plan:

```text
tickets/
```

### Work

```bash
loop work
```

Core:

1. selects Feature,
2. moves to `doing`,
3. detects Spec Flow artifacts,
4. resolves `SpecFlowFeatureExecutor`,
5. delegates implementation to existing Spec Flow lifecycle,
6. waits for normalized completion status,
7. moves Feature to review.

Loop does not move individual tickets.

---

## 32. Open Design Questions

These should not block Phase 1.

### 32.1 Inbox history

Options:

- update Inbox status in place,
- move processed items to an archive,
- keep append-only Inbox plus external index.

Recommendation for v0.1:

Update metadata in place and keep provenance.

---

### 32.2 Feature priority

Not required for v0.1.

Start with oldest-ready-first.

Add explicit priority only when real usage requires it.

---

### 32.3 Review policy

Options:

- always review,
- skip review for small direct Features,
- configurable by project,
- agent decides.

Recommendation for v0.1:

Always use review state. Simpler semantics and better auditability.

---

### 32.4 Spec Flow invocation boundary

Best long-term option:

Expose programmatic execution APIs from `pi-spec-flow` if they do not already exist.

Fallback:

Invoke existing Pi commands through a Pi session.

Avoid shell parsing of human-formatted command output when a structured adapter is possible.

---

### 32.5 Name

Working name:

```text
Loop
```

Potential package names:

```text
pi-loop
loop-agent
agent-loop
```

Naming should be finalized only after package and npm availability checks.

---

## 33. Final Architectural Decision

The system should be built around this boundary:

```text
PRODUCERS
   ↓
INBOX
   ↓
TRIAGE
   ↓
FEATURE QUEUE
   ↓
EXECUTOR REGISTRY
   ├── DIRECT PI EXECUTOR
   └── SPEC FLOW EXECUTOR
   ↓
REVIEW
   ↓
DONE
```

The central architectural rule is:

> Loop is a deterministic workflow engine with agentic decision and execution points, not an agent that happens to manipulate folders.

This keeps the repository portable, the workflow auditable, Pi replaceable at the integration boundary, and `pi-spec-flow` reusable as a specialized execution engine.

---

## 34. External Technical References

The implementation should verify compatibility against the current official/project documentation at development time:

- Pi Coding Agent repository and documentation:
  - Pi supports TypeScript extensions, custom tools, commands, lifecycle hooks, SDK embedding, and RPC mode.
- Pi SDK documentation:
  - programmatic `AgentSession` creation and automated agent pipelines.
- Pi Extensions documentation:
  - extension commands, agent tools, UI integration, and lifecycle hooks.
- `pi-spec-flow` repository:
  - current commands, generated ticket location model, feature scoping, ticket progression, handoff behavior, and checkpoint review behavior.

The adapter must follow the installed `pi-spec-flow` version's actual public API and file format rather than duplicating assumptions from this draft.

---

# Acceptance Criteria for Loop v0.1

The first releasable version is complete when all of the following are true:

1. A repository can be initialized with Loop.
2. A user can capture an Inbox item from the terminal without an LLM call.
3. Inbox items and Feature manifests are schema-validated.
4. Pi can triage an Inbox item into a valid Feature.
5. A Feature can move safely through valid lifecycle states.
6. `loop work` can execute a direct Feature through Pi.
7. `loop work` can delegate a spec-driven Feature to the `pi-spec-flow` adapter.
8. Individual Spec Flow tickets remain owned by `pi-spec-flow`.
9. Loop can submit a Feature for review and mark it done after successful review.
10. `loop status` reports repository workflow state without an LLM call.
11. The Core package can be tested without Pi or network access.
12. The default autonomous behavior is bounded and does not start an infinite execution loop.
