#!/usr/bin/env bash
set -euo pipefail

# Human owns the routing decision; the implementation can be handled later.
INBOX_ID=$(stonvik --json capture "Add CSV export" --source human:terminal | jq -r .id)
stonvik triage "$INBOX_ID" --route direct --actor human:lean
stonvik define "$INBOX_ID" \
  --goal "Agregar exportación CSV" \
  --acceptance "La exportación CSV está disponible" \
  --verify-command "test -f README.md"
stonvik next --json
