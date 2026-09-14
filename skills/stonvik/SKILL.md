---
name: stonvik
description: Use when an agent must capture, prepare, claim, implement, report, verify, review, recover, or inspect Work through the Stonvik CLI. Not for developing Stonvik itself.
---

# Stonvik

Treat the repository as the durable source of truth. Conversation context does not establish Work state: query Stonvik and read the current handoff before acting.

## Non-negotiable rules

- Use the `stonvik` CLI for claims, transitions, receipts, verification, and review. Never advance workflow state with `mv`, `cp`, direct manifest edits, or direct receipt edits.
- CLI commands remain in English. Use `capture`, not `capturar`; use `prepare`, not `preparar`.
- Preserve captured intent literally. Do not turn “more visual charts” into “pie charts” unless the user chose that solution. Ask for clarification or use `spec-first` when scope is unclear.
- Do not assume that a prompt creates executable Work. Use an explicit Work ID supplied for the target repository or select Work with `stonvik --json next`.
- Claim Work and read its handoff before editing.
- A completed implementation is neither verified nor approved. An implementer must not approve its own work.
- When structured output is available, branch on `error.code` and the exit code; never parse human-readable error messages.

## Resolve the CLI

Run from the target repository. Prefer its local binary so the skill and CLI versions stay aligned:

```bash
if [ -x ./node_modules/.bin/stonvik ]; then
  CLI=./node_modules/.bin/stonvik
elif command -v stonvik >/dev/null 2>&1; then
  CLI=stonvik
else
  echo "Stonvik CLI is not installed in the target repository" >&2
  exit 1
fi
```

Do not use `npx stonvik` or `bunx stonvik` to guess an unavailable package. Do not execute a source checkout's `dist/cli/index.js` directly; if unavoidable, invoke it through Node rather than changing generated-file permissions.

Pass `--root <path>` when the current directory is not the target repository root. Put global options before the command in examples and scripts.

## When the CLI is unclear

Do not guess commands, options, transitions, or recovery steps. Resolve uncertainty in this order:

1. Read `error.code` and the exit code when available.
2. Run `$CLI --help` or `$CLI <command> --help`.
3. Consult `docs/public/cli-reference.md` or `docs/public/contracts.md` from the installed package.
4. If the safe action remains unclear, stop and report `needs_human` when a report is valid for the current Work state.
5. Never compensate for missing knowledge by editing Stonvik state files directly.

CLI help is authoritative for command syntax; public contracts are authoritative for payload shape.

## Operational flow

### 1. Inspect or capture intent

Use the canonical Inbox commands:

```bash
$CLI --json inbox
$CLI --json inbox review
$CLI --json capture "<literal user text>" --source agent:<name>
```

`inbox list` is an explicit compatibility alias. Capture creates an Inbox item, not executable Work.

Prepare an Inbox item only when routing responsibility is assigned:

```bash
$CLI prepare <inbox-id> \
  --route <direct|spec-first> \
  --actor <type:name>
```

Actor identity is declarative provenance, not authentication. Use the same identity consistently.

### 2. Identify, claim, and inspect Work

Use the explicit Work ID supplied for the target repository or select the oldest ready Work:

```bash
$CLI --json next
$CLI work start <work-id> --actor <type:name> --run-id <run-id>
$CLI handoff <work-id> --format json
```

`next` selects without claiming. `work start` claims Work and moves `ready → doing`.

Follow the handoff's goal, acceptance criteria, constraints, allowed paths, and verification policy. Do not fill gaps from conversation context.

If `work start` reports `WORK_CLAIM_CONFLICT`, stop and inspect the claim:

```bash
$CLI --json work claim <work-id>
```

Never delete or overwrite a claim.

### 3. Implement only the requested change

Modify only repository source artifacts required by the handoff. Do not modify workflow state under:

- `product/inbox/`;
- `features/ready/`, `features/doing/`, `features/review/`, `features/blocked/`, or `features/done/`;
- `.stonvik/runtime/`;
- manifests, receipts, claims, leases, or event streams.

Check each acceptance criterion before reporting completion. Keep required verification artifacts at repository-relative paths.

### 4. Report the result

Create a versioned `ExternalExecutionReport`. A minimal valid report is:

```json
{
  "schemaVersion": 1,
  "actor": { "type": "agent", "name": "example", "role": "implementer" },
  "outcome": "completed",
  "summary": "Describe what changed and what remains to verify."
}
```

Import it through the CLI:

```bash
$CLI work report <work-id> --receipt result.json --run-id <run-id>
```

If a claim exists, the report actor and optional run ID must match it. Only list artifacts that exist, using repository-relative paths without `..`. Local evidence references follow the same rule; external URLs are allowed as evidence, not artifacts. Never put secrets in `summary` or `details`.

Choose the outcome honestly:

- `completed`: execution finished; verification and review are still pending;
- `blocked`: a dependency prevents continuation;
- `needs_human`: a human decision or missing information is required;
- `cancelled`: execution stopped before completion.

### 5. Verify and request independent review

When the handoff assigns verification responsibility, run:

```bash
$CLI verify <work-id>
```

Passing verification moves `doing → review`, never directly to `done`.

A different declared actor may then review:

```bash
$CLI work review <work-id> \
  --actor <reviewer-type:name> \
  --decision <approved|changes_requested|blocked|needs_human> \
  --summary "<review summary>"
```

Only independent `approved` review moves `review → done`.

## Failure and recovery

With `--json`, Stonvik writes structured domain errors to stderr. Exit code `2` means invalid input or contract; exit code `3` means missing state or a recoverable workflow conflict. Correct the input or state indicated by `error.code` instead of improvising filesystem changes.

Recover Work only after confirming that the previous claimant process no longer exists:

```bash
$CLI --json work claim <work-id>
$CLI work recover <work-id> --actor <type:name> --run-id <run-id>
```

Use `$CLI work unblock <work-id>` only after resolving the blocker. Preserve existing claims and receipts.

## Final check

Before stopping, confirm that:

- the Work came from repository state or an explicit ID for the target repository;
- it was claimed before source changes;
- only source artifacts allowed by the handoff changed;
- the report actor, run ID, artifacts, and evidence are valid;
- verification ran when assigned;
- review remains with an independent actor.

Use `$CLI --json validate` to check repository contracts and references when required. For complete commands and schemas, read `docs/public/cli-reference.md` and `docs/public/contracts.md` from the installed Stonvik package.
