# Changelog

## [1.1.0] - 2026-09-13

### Added

- Agent-neutral Work lifecycle with direct and spec-first preparation.
- Actor, routing, handoff, external execution report, claim, and specification contracts.
- CLI commands for `prepare`, `next`, `handoff`, `work start`, `work report`, `work recover`, `verify`, `work review`, and `work create-from-spec`.
- Deterministic verification and independent review gates before `done`.
- Public client documentation and the `stonvik-workflow` Agent Skill.

### Changed

- Core lifecycle services no longer construct Pi or Spec Flow adapters.
- Pi and Spec Flow adapters moved to the optional `src/integrations/pi/` boundary.
- Legacy manifests, receipts, and `run`/`triage`/`implement` commands remain compatible during migration.

### Security

- External report artifacts and local evidence references are validated against repository-safe paths.
- Work claims use atomic creation and require explicit stale-claim recovery.
- Self-review and invalid lifecycle transitions are rejected.
