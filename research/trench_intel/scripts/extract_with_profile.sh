#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/extract_with_profile.sh operator 20
#   ./scripts/extract_with_profile.sh mimo 50
#
# The profile must already exist and be authenticated/configured.
# Output is appended to extracted/claims.jsonl.raw for review before normalization.

PROFILE="${1:-operator}"
LIMIT="${2:-20}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BATCH="/tmp/charon_trench_batch_$$.md"
OUT="$ROOT/extracted/claims.jsonl.raw"

mkdir -p "$ROOT/extracted"
python "$ROOT/scripts/make_batch.py" --include-prompt --limit "$LIMIT" > "$BATCH"

hermes --profile "$PROFILE" chat --quiet -q "$(cat "$BATCH")" | tee -a "$OUT"

echo "\nSaved raw extraction output to: $OUT" >&2
