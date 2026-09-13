#!/usr/bin/env bash
set -euo pipefail

# Human owns the routing decision; the implementation can be handled later.
INBOX_ID=$(stonvik --json capture "Add CSV export" --source human:terminal | jq -r .id)
stonvik prepare "$INBOX_ID" --route direct --actor human:lean
stonvik next --json
