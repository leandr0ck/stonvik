# Stonvik

Stonvik is a repository-native workflow engine for software-development
agents. It treats the repository as the durable, reviewable record of product
intent, executable work, evidence, and decisions.

## Philosophy

- **The repository is the source of truth.** No database or hosted control
  plane is required; Git is optional and only helps discover a project root.
- **Intent is not execution.** An Inbox stores raw requests. Only defined Work
  can be selected for implementation.
- **Lifecycle is explicit.** Work moves through triage, definition,
  implementation, verification, review, and shipping. An implementer never
  approves its own work.
- **State and evidence travel together.** Durable artifacts belong in the
  repository; leases and process logs are local runtime details.
- **Automation is bounded.** Deterministic code owns validation, ordering, and
  transitions. Agents contribute judgment where it is needed, under explicit
  gates.

The CLI, TypeScript types, schemas, and tests are the operational
documentation. Run `stonvik --help` for the current interface.

Public client documentation: [docs/public/README.md](docs/public/README.md).
