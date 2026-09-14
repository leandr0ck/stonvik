# ADR 0001: Agent-neutral workflow core

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

Stonvik must coordinate durable Work without requiring a particular agent runtime. Previous loop code could construct Pi processes, load Pi configuration, and infer execution lifecycle from that integration. That coupled domain state transitions to one execution engine and made external actors unable to participate through stable contracts.

## Decision

Keep the core responsible for domain contracts, routing policy, filesystem state, claims, deterministic verification, review gates, receipts, and handoffs. The core accepts classification, execution, and review through injected interfaces or structured external reports. It never creates an agent process or reads agent-specific runtime configuration.

Pi remains an optional adapter under `src/integrations/pi/`; no document filename or content selects an adapter. There are no compatibility shims or runtime-specific CLI paths. The CLI exposes only the neutral workflow and stops at the external handoff boundary: the selected actor owns implementation and submits a structured execution report.

## Alternatives rejected

- **Keep Pi as the default executor:** rejected because it makes a tool-specific runtime part of the domain lifecycle and prevents clean external ownership.
- **Rewrite the repository around a remote orchestration service:** rejected for the first release; the repository-native durable state and local atomic writes already provide the required boundary.
- **Treat actor names as authentication:** rejected because `--actor` is provenance, not proof of identity.

## Consequences

- Work can be claimed and advanced by humans, agents, CI, or processes using the same JSON/YAML contracts.
- State transitions and audit evidence remain deterministic and testable without an LLM.
- Pi-specific dependencies and configuration are isolated at the integration boundary.
- The workflow is explicit and minimal: `capture`, `triage`, `define`, `next`, `work start/report/review`, `verify`, and `ship`. User-owned specs and ADRs are referenced from the manifest without an imposed editorial format.
- Integrations must not write Work state directly; they return execution/review data to the repository API.
