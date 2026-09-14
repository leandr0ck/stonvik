---
name: stonvik-workflow
description: Use when an agent works in a Stonvik repository or a user asks it to capture/capturar intent, prepare/preparar Work, select or implement a Work item, create a handoff, report external execution, or coordinate verification and review through the Stonvik CLI. Do not use for unrelated repositories or for changing Stonvik itself.
---

# Stonvik workflow

Use Stonvik as the source of truth for work state. Conversation context is not durable state: query the repository and read the current handoff before acting.

CLI command names are exact and intentionally remain in English: use `capture`, not a translated variant such as `capturar`; use `prepare`, not `preparar`. If a command fails, read the error and correct the command instead of improvising filesystem operations.

## Core rule

Participate through the `stonvik` CLI. Prefer the installed package binary (`stonvik` or `./node_modules/.bin/stonvik`). Do not invoke a source checkout's `dist/cli/index.js` directly; if that is unavoidable, invoke it through Node rather than changing permissions on generated files. Do not use `npx stonvik` or `bunx stonvik` when the package is not published to the registry; use the local binary or the explicitly installed tarball.

Do not edit Stonvik state files to advance a workflow. The CLI owns claims, transitions, receipts, verification, and review gates.

Do not assume a Work is available because someone mentioned it in a prompt. Select it with `stonvik next --json` or use the explicit Work ID supplied by the repository.

## Before editing

1. Confirm the repository root. Run commands from the target repository, not from the repository that contains the Stonvik source. Pass `--root <path>` when the current directory is not the repository root.
2. Identify your declared actor identity and role. Use the exact `type:name` value consistently; identity is provenance, not authentication.
3. Preserve the user's intent literally. Do not turn a broad request such as “more visual charts” into a specific solution such as “pie charts” unless the user said so. If scope is unclear, capture the original wording and choose `spec-first` or ask for clarification.
4. When an agent captures intent, identify the producer accurately, for example `--source agent:pi`; do not invent a more specific product requirement while capturing.
5. For selected Work, claim it before editing:

   ```bash
   stonvik work start <work-id> --actor <type:name> --run-id <run-id>
   ```

6. Read the neutral handoff:

   ```bash
   stonvik handoff <work-id> --format json
   ```

7. Follow the goal, acceptance criteria, constraints, allowed paths, and verification policy in the handoff. Do not invent missing requirements from conversation context.

If `work start` reports a claim conflict, stop. Inspect `stonvik work claim <work-id>`; never delete or overwrite the claim. Use `work recover` only after confirming that the previous process is gone.

## While editing

Modify only repository source artifacts required by the Work. Do not modify these to change workflow state:

- `product/inbox/`;
- `features/ready/`, `features/doing/`, `features/review/`, `features/blocked/` or `features/done/`;
- Work manifests, receipts, claims, leases, or event streams.

Do not make a successful-looking change without checking the acceptance criteria. Keep verification artifacts in repository-relative paths when the handoff requires them.

## Report the result

Write a versioned `ExternalExecutionReport` and import it through the CLI. A minimal report is:

```json
{
  "schemaVersion": 1,
  "actor": { "type": "agent", "name": "example", "role": "implementer" },
  "outcome": "completed",
  "summary": "Describe what changed and what remains to verify."
}
```

Import it with:

```bash
stonvik work report <work-id> --receipt result.json
```

Use outcomes honestly:

- `completed`: the external actor finished its work; this does not mean verified or approved;
- `blocked`: a dependency prevents continuation;
- `needs_human`: a human decision or missing information is required;
- `cancelled`: execution stopped before completion.

Only list artifacts that exist and use repository-relative paths. Local evidence references follow the same rule; external URLs are allowed only when they are evidence, not artifacts. Do not put secrets in `summary` or `details`.

## Verification and review

After a `completed` report, run the configured deterministic checks when the handoff assigns that responsibility:

```bash
stonvik verify <work-id>
```

Do not approve your own execution. Leave `work review` to a different declared actor. If you are the reviewer, confirm that the latest execution is complete, verification passed, and your actor identity differs from the executor before recording the decision:

```bash
stonvik work review <work-id> \
  --actor <reviewer-type:name> \
  --decision <approved|changes_requested|blocked|needs_human> \
  --summary "..."
```

A `completed` report, a passing command, or a local code diff alone never moves Work to `done`.

## Failure and recovery

When the task cannot continue, report `blocked`, `needs_human`, or `cancelled` instead of fabricating completion. Include the concrete reason and the next useful action.

If the process is interrupted:

```bash
stonvik work claim <work-id>
stonvik work recover <work-id> --actor <type:name>
```

Run recovery only after the old process is no longer live. Preserve existing receipts and claims; use the CLI rather than filesystem commands.

## Final checklist

- The Work was selected from repository state.
- The Work was claimed before editing.
- Only product files required by the handoff were changed.
- The external report uses `schemaVersion: 1` and the correct actor.
- Artifacts and local evidence references are valid repository paths.
- Verification was run when required.
- An independent actor owns the review.
