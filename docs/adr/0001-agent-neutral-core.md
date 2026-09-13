# ADR 0001: Agent-neutral workflow core

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

Stonvik must coordinate durable Work without requiring a particular agent runtime. Previous loop code could construct Pi processes, load Pi configuration, and infer execution lifecycle from that integration. That coupled domain state transitions to one execution engine and made external actors unable to participate through stable contracts.

## Decision

Keep the core responsible for domain contracts, routing policy, filesystem state, claims, deterministic verification, review gates, receipts, and handoffs. The core accepts classification, execution, and review through injected interfaces or structured external reports. It never creates an agent process or reads agent-specific runtime configuration.

Pi and Spec Flow remain optional adapters under `src/integrations/pi/`. The old `src/core/execution` exports remain compatibility shims for existing consumers; new code must import the integration directly. The CLI is the compatibility integration that wires those adapters when Pi is explicitly configured or requested. With no Pi request, the CLI uses deterministic classification and stops at the neutral handoff boundary when external execution is unavailable.

## Alternatives rejected

- **Keep Pi as the default executor:** rejected because it makes a tool-specific runtime part of the domain lifecycle and prevents clean external ownership.
- **Rewrite the repository around a remote orchestration service:** rejected for the first release; the repository-native durable state and local atomic writes already provide the required boundary.
- **Treat actor names as authentication:** rejected because `--actor` is provenance, not proof of identity.

## Consequences

- Work can be claimed and advanced by humans, agents, CI, or processes using the same JSON/YAML contracts.
- State transitions and audit evidence remain deterministic and testable without an LLM.
- Pi-specific dependencies and configuration are isolated at the integration boundary.
- Existing `run`, `triage`, and `implement` commands remain available during migration, but direct Work commands (`prepare`, `next`, `work start/report/review`, `verify`, and `handoff`) are the stable agent-neutral interface.
- Integrations must not write Work state directly; they return execution/review data to the repository API.
