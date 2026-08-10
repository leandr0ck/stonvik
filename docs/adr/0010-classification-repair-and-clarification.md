# ADR 0010: Repair and clarification for Inbox classification

**Status:** Accepted
**Date:** 2026-07-16
**Deciders:** Forgium maintainers

## Context

An Inbox stores raw intent, while every ready Work must contain a complete
verification policy. The classifier previously required every proposed
classification to contain that policy, even when the route required a human
decision. When Pi omitted verification for an otherwise small request,
Forgium stopped and incorrectly directed the person to supply verification in
manual triage.

That mixes the Inbox contract with the Work contract. It also makes an
incomplete classifier response look like missing human input.

## Decision

### Classification repair

Forgium validates a classifier response before persisting it. If its JSON or
classification contract is invalid, Forgium makes exactly one repair attempt.
The repair prompt contains only a deterministic validation summary and the
original Inbox intent; it does not replay raw model output.

No durable state changes during the repair attempt. If it fails, Forgium emits
`classification_failed`, leaves the Inbox captured, and explains that manual
Work creation through `forgium triage` is a recovery path. This narrowly
supersedes ADR 0008's no-retry rule for classifier-contract repair only; it
does not retry execution, verification, review, checkpoints, or a persisted
Work state.

### Route-dependent proposed Work contract

- `auto_direct` must include a non-empty `proposed.verification`, because it
  immediately creates ready Work.
- `ask_direct` must contain a typed clarification field and may omit
  verification, because Work cannot yet be created.
- `ask_spec`, `ask_adr`, and `split` may omit verification. The human
  definition must supply it before Forgium creates ready Work.

Ready Work always requires verification. Inbox never does.

### Structured clarification

`ask_direct` carries one enum field: `output_path`, `verification`, or
`scope`. Forgium renders a deterministic question for the field, so it never
persists or displays arbitrary free-form model questions.

A pending answer is durable Inbox metadata with status `needs_clarification`.
In an interactive `forgium run`, Forgium asks the question and reclassifies in
the same pass. Non-interactive users answer with:

```bash
forgium inbox answer <inbox-id> <answer>
forgium run
```

The original Inbox title and body remain unchanged.

## Consequences

- Small, verifiable requests can recover from one malformed classifier result
  without human triage.
- Humans are asked only for a specific missing decision, not to reconstruct a
  classifier-generated Work contract.
- Classification receipts may record incomplete proposals for human-routed
  Work; no ready Work is created without verification.
- CLI and integrations can distinguish `classification_failed` from
  `human_input_required`.
