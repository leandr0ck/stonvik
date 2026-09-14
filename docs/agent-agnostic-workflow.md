# Agent-agnostic workflow

Stonvik stores durable Work and evidence in the repository. Any actor can use the same lifecycle; an integration must not edit Feature directories to change workflow state.

## Lifecycle

```text
capture → triage → define → ready
ready → work start → doing → work report → verify → review → ship → done
```

The phases are deliberately independent:

- **Triage** records a route: `direct`, `spec` or `adr`.
- **Define** creates the executable `manifest.yaml`.
- **Implement** is external. The team or agent chooses its own tools, prompts, specs and ADR format.
- **Verify** runs deterministic checks from the manifest.
- **Review** records an independent decision.
- **Ship** is the final transition to `done`.

An external report with outcome `completed` does not finish Work. Verification and review remain separate gates.

## User-owned documents

A Work may include `definitions` references:

```yaml
definitions:
  - kind: spec
    path: docs/product/notifications.md
  - kind: adr
    path: architecture/notifications.md
```

The files are created and structured by the team. Stonvik does not generate them, parse their frontmatter, infer an execution method from their names, or require a location such as `docs/specs/` or `docs/adr/`. It only validates that the references are existing, repository-relative files outside `.stonvik/`, `product/inbox/` and `features/`.

## External actor contract

1. Select Work with `stonvik --root . --json next`.
2. Claim it with `work start --actor <type:name>`.
3. Read `work handoff <id> --format json`.
4. Execute the team's own process and modify product files.
5. Submit a structured `work report`.
6. Run `verify` and ask a different actor to review.
7. Run `ship` only after the review is approved.

Claims are ephemeral under `.stonvik/runtime/`. Durable manifests, receipts, provenance and events are versionable repository evidence.

## Invariants

- Inbox is raw intent, never an executable queue.
- Only `features/ready/` Work is selectable.
- State transitions move the complete Work directory.
- A Work cannot move directly from `doing` to `done`.
- A reviewer cannot be the actor of the completed execution report.
- A passing, current verification and independent approval are required before Ship.

Pi and other runtimes are optional integrations. They are not part of the core workflow and no document filename selects one automatically.
