#!/usr/bin/env bash
set -euo pipefail

WORK_ID="${1:?pass a Work ID}"
# CI validates the durable Work contract; it does not move state directories or
# rewrite receipts directly.
stonvik --json verify "$WORK_ID" > verification.json
