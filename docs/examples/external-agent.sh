#!/usr/bin/env bash
set -euo pipefail

WORK_ID="${1:?pass a Work ID from stonvik next --json}"
RUN_ID="agent-$(date +%s)"
stonvik work start "$WORK_ID" --actor agent:codex --run-id "$RUN_ID"
stonvik work handoff "$WORK_ID" --format json > handoff.json

# The agent edits only paths required by the handoff and never edits manifests,
# receipts, claims, or other Stonevik metadata. It writes this neutral report
# when its work is complete.
cat > result.json <<EOF
{
  "schemaVersion": 1,
  "actor": { "type": "agent", "name": "codex", "role": "implementer" },
  "outcome": "completed",
  "summary": "Implemented the requested change.",
  "artifacts": [],
  "evidence": []
}
EOF
stonvik work report "$WORK_ID" --receipt result.json
