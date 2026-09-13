# Agent-agnostic workflow

Stonvik stores durable Work and evidence in the repository. Any actor can use the same lifecycle; an actor integration must not edit feature directories to change state.

## Lifecycle

```text
capture → prepare (direct | spec-first) → ready
ready → work start → doing → work report → verify → review → done
```

A completed external report does not finish Work. `stonvik verify` runs the manifest's deterministic checks, and `stonvik work review --decision approved` is the independent gate that moves Work to `done`. Failed verification or requested changes keep Work in `doing`; blocked and human-required outcomes create an explicit handoff.

## External actor contract

1. Select work with `stonvik --root . --json next`.
2. Claim it: `stonvik --root . work start <id> --actor agent:codex --run-id <run>`.
3. Execute outside Stonvik and write a JSON/YAML report containing `schemaVersion`, `actor`, `outcome`, `summary`, and optional repository-relative `artifacts`/`evidence`.
4. Import it with `stonvik work report <id> --receipt path/to/report.json`.
5. Run `stonvik verify <id>` and hand the Work to a different actor for review.
6. Generate a neutral handoff at any point with `stonvik handoff <id> --format markdown`.

Claims live under `.stonvik/runtime/` and are ephemeral. Durable receipts, verification evidence, and routing decisions live with the Work; handoffs are generated views and do not mutate state.

## Routing

`stonvik prepare <inbox-id> --route direct|spec-first --actor human:lean` validates deterministic size, touched-file, and risk policy before creating Work. Direct Work is intentionally limited by policy; high-risk, ambiguous, or oversized intent must use spec-first unless the actor has the configured authority role (by default `product-owner`) and explicitly records that decision in `decidedBy`. A custom policy can be provided under the core-owned `routing` section of `stonvik.json`.

## Pi migration

Pi is optional. The CLI wires `src/integrations/pi/` only when `STONVIK_PI_COMMAND`, `config.pi.command`, or `STONVIK_DETERMINISTIC_CLASSIFIER=0` explicitly requests it. Existing `run`, `triage`, and `implement` commands remain compatibility paths. New integrations should implement the neutral interfaces in `src/core/execution/execution-adapter.ts` and submit structured reports rather than importing Pi-specific code into core services.
