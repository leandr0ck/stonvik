# Changelog

## [1.1.6] - 2026-09-15

### Changed

- Added explicit Agent Skill and integration guidance for linking existing Specs to Inbox items, including missing-field handling and Work-state boundaries.

## [1.1.5] - 2026-09-15

### Changed

- Reworked the Agent Skill for direct multilingual intent-to-CLI routing, minimal command execution, accurate lifecycle commands, and explicit Inbox-versus-Work semantics.

## [1.1.4] - 2026-09-13

### Changed

- The Agent Skill now includes a compact CLI API reference with canonical commands and lifecycle effects.

## [1.1.3] - 2026-09-13

### Added

- Added the explicit `stonvik inbox list` alias for agents and operators who prefer a verb-noun listing command.

### Fixed

- The Agent Skill now triggers for Inbox listing requests and identifies `stonvik --json inbox` as the canonical command.

## [1.1.2] - 2026-09-13

### Fixed

- The Agent Skill now triggers explicitly for capture and prepare requests, including Spanish forms such as `captura` and `prepara`.

## [1.1.1] - 2026-09-13

### Fixed

- The CLI suggests the canonical English command when an unknown translated command such as `capturar` is entered.
- The Agent Skill now requires the installed local binary, preserves user intent literally, and avoids modifying generated `dist` files.
- Public agent integration guidance now documents the same invocation and intent-preservation rules.

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
