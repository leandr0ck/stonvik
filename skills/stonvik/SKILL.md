---
name: stonvik
description: Operate repository tasks directly through the Stonvik CLI. Use for Spanish or English requests to list tasks or Inbox items, capture intent, inspect status, select or execute Work, report results, verify, review, ship, unblock, or recover work. Trigger on phrases such as "listar tareas", "qué sigue", "capturar", "agregar al inbox", "estado del trabajo", "start work", and explicit Stonvik requests. Not for developing Stonvik itself.
---

# Stonvik CLI operator

Execute the Stonvik CLI immediately when the request maps to an operation below. Do not answer from memory, inspect workflow directories, or describe commands instead of running them.

Repository state is authoritative. Conversation history is not.

## 1. Resolve the CLI once

Run commands from the target repository. Resolve the executable at the beginning of the operation:

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

Do not use `npx`, `bunx`, a guessed package path, or a source checkout's generated `dist` file. When operating from another directory, add `--root <target-repository>` before the command.

Use `--json` for every command whose output the agent must interpret. Global options go before the command:

```bash
$CLI --root <target-repository> --json status
```

## 2. Map user intent directly to commands

Do not run extra queries unless they are needed to satisfy the request.

| User intent, in any language | Execute |
| --- | --- |
| list tasks, `listar tareas`, list Work | `$CLI --json work list` |
| list ready tasks, `tareas listas` | `$CLI --json work list --state ready` |
| what is next, `qué sigue`, next task | `$CLI --json next` |
| workflow status, `estado` | `$CLI --json status` |
| list Inbox, `listar inbox`, captured requests | `$CLI --json inbox` |
| list Inbox review items | `$CLI --json inbox review` |
| show a task/Work | `$CLI --json work show <work-id>` |
| show an Inbox item | `$CLI --json inbox show <inbox-id>` |
| capture/add a request | `$CLI --json capture "<literal user text>" --source agent:<name>` |
| answer a pending clarification | `$CLI --json inbox answer <inbox-id> "<literal answer>"` |
| link/associate/attach a Spec to an Inbox item | Follow the Spec-linking procedure below |
| validate Stonvik state | `$CLI --json validate` |

Important distinctions:

- **Inbox is raw intent, not executable Work.** `listar tareas` means `work list`; do not append Inbox results unless the user asks for Inbox or a combined overview.
- `next` selects only the oldest ready Work and does not claim it.
- Capture preserves the user's text literally. Do not summarize, translate, expand, or silently choose a solution.
- A capture request is complete after `capture`; do not triage or define it unless explicitly requested.

## 3. Link a Spec to an Inbox item

When the user says “link”, “associate”, “attach”, “enlaza”, “asocia”, or “vincula” a Spec to an Inbox item:

1. Read the target item through `$CLI --json inbox show <inbox-id>`.
2. Confirm the Spec path is an existing repository-relative file. Do not create or invent a Spec unless the user explicitly asks for that.
3. If the item has no routing decision, run `$CLI --json triage <inbox-id> --route spec --actor <type:name>`.
4. Run `define` with the Spec path and the required goal, acceptance, and verification fields:

```bash
$CLI --json define <inbox-id> \
  --spec <spec-path> \
  --goal "<goal>" \
  --acceptance "<criterion>" \
  --verify-command "<command>"
```

If goal, acceptance, or verification is missing, ask for only the missing values instead of guessing. A successful `define` creates ready Work in `features/ready/`; it does not start implementation.

If the target is already a Work in `ready`, `doing`, `review`, `blocked`, or `done`, stop: the current CLI has no supported Work-definition linking command. Never attach the Spec by editing `manifest.yaml`; report that a CLI capability is required.

After a successful command, summarize the returned JSON concisely. Include IDs and states needed for the next action. Do not expose the executable-resolution shell snippet in the response.

## 4. Triage and define Work only when requested

Record a routing decision:

```bash
$CLI --json triage <inbox-id> \
  --route <direct|spec|adr> \
  --actor <type:name>
```

Use `direct` only when the intent is sufficiently defined. Use `spec` or `adr` only when the corresponding user-owned document will be provided. Never invent a document merely to advance state.

Create executable Work from an Inbox item:

```bash
$CLI --json define <inbox-id> \
  --goal "<goal>" \
  --acceptance "<criterion>" \
  --verify-command "<command>"
```

Optional repeatable options include `--acceptance`, `--constraint`, `--spec`, `--adr`, `--verify-command`, and `--manual-evidence`. Read `$CLI define --help` before using an option not shown here.

To create Work without Inbox provenance:

```bash
$CLI --json work create \
  --title "<title>" \
  --goal "<goal>" \
  --acceptance "<criterion>" \
  --verify-command "<command>"
```

Do not infer acceptance criteria, verification, scope, or architecture when the user has not supplied enough information. Ask only for the missing decision.

## 5. Execute Work through the lifecycle

When the user asks to implement the next or a specified Work:

```bash
$CLI --json next
$CLI --json work start <work-id> --actor agent:<name> --run-id <run-id>
$CLI --json work handoff <work-id> --format json
```

If the user supplied a Work ID, skip `next`. After `work start`, read the handoff before editing source files. Follow its goal, acceptance criteria, constraints, definitions, allowed paths, and verification policy.

Never change workflow state by editing or moving:

- `product/inbox/`;
- `features/ready/`, `features/doing/`, `features/review/`, `features/blocked/`, or `features/done/`;
- `.stonvik/runtime/`;
- manifests, receipts, claims, leases, or event streams.

Use the CLI for every transition. Modify only product/source artifacts required by the handoff.

## 6. Report, verify, review, and ship

Create a repository-local JSON or YAML execution report and import it with the same actor and run ID used to claim Work:

```json
{
  "schemaVersion": 1,
  "actor": { "type": "agent", "name": "pi", "role": "implementer" },
  "outcome": "completed",
  "summary": "Concise, verifiable implementation result."
}
```

```bash
$CLI --json work report <work-id> --receipt <report-path> --run-id <run-id>
```

Valid outcomes are `completed`, `blocked`, `needs_human`, and `cancelled`. Report honestly. `completed` means implementation ended; it does not mean verified, reviewed, or done.

When the handoff assigns verification responsibility:

```bash
$CLI --json verify <work-id>
```

Passing verification moves Work from `doing` to `review`. A different actor must review:

```bash
$CLI --json work review <work-id> \
  --actor <reviewer-type:name> \
  --decision <approved|changes_requested|blocked|needs_human> \
  --summary "<review summary>"
```

An implementer must never approve its own execution. After an independent approval:

```bash
$CLI --json ship <work-id>
```

## 7. Handle errors without improvising

With `--json`, branch on `error.code` and the process exit code. Never parse human-readable error prose.

- Exit `2`: invalid input, option, contract, configuration, or validation.
- Exit `3`: missing state or recoverable workflow conflict.
- Exit `1`: unexpected failure.

If syntax is unclear, inspect only the relevant help:

```bash
$CLI <command> --help
```

Do not run broad discovery before canonical commands already listed in this skill.

For `WORK_CLAIM_CONFLICT`, stop and inspect the claim:

```bash
$CLI --json work claim <work-id>
```

Recover only after confirming the previous actor process no longer exists:

```bash
$CLI --json work recover <work-id> --actor agent:<name> --run-id <new-run-id>
```

Return blocked Work to ready only after its blocker is resolved:

```bash
$CLI --json work unblock <work-id>
```

Never delete claims or repair state files manually.

## Final discipline

Before stopping, verify that:

- the requested operation was actually executed through the CLI;
- no unrelated Inbox or Work query was added;
- captured text remained literal;
- Work was claimed and its handoff read before source edits;
- actor and run ID stayed consistent;
- implementation, verification, review, and shipping remained separate gates;
- the final response reports actual CLI output, not assumed state.
