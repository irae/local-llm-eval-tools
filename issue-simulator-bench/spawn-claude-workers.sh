#!/bin/bash
# Spawns one run-worker.sh per model, in parallel.
# Usage: ./spawn-claude-workers.sh [model ...]   (default: haiku sonnet opus)
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ $# -gt 0 ]; then MODELS=("$@"); else MODELS=(haiku sonnet opus); fi

for model in "${MODELS[@]}"; do
    "$BENCH_DIR/run-worker.sh" "$model" claude &
    echo "$model: pid $!" >&2
done
wait
echo "all workers done" >&2
