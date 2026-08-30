#!/bin/bash
# Bootstraps one worktree and runs one worker on the issue-13 task.
# Usage: ./run-worker.sh <model> [harness]
#   harness: pi (default) | claude
# Blocks until the worker finishes. Spawn several in parallel from separate shells.
set -euo pipefail

model="${1:?usage: run-worker.sh <model> [harness]}"
harness="${2:-pi}"
BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$BENCH_DIR/.." && pwd)"
BASE_COMMIT=4679b5a
RUNS="$BENCH_DIR/runs"
slug="$(echo "$model" | tr '/:' '--')"
branch="${slug}-issue-13-r2"
wt="$REPO/../mendel-bench2-$slug"
mkdir -p "$RUNS"

if git -C "$REPO" show-ref --quiet "refs/heads/$branch"; then
    echo "abort: branch $branch exists" >&2
    exit 1
fi

rm -rf "$wt"
git -C "$REPO" worktree add -b "$branch" "$wt" "$BASE_COMMIT"
(cd "$wt" && pnpm install > "$RUNS/$slug-install.log" 2>&1)
echo "$slug: worktree ready at $wt, starting $harness" >&2

cd "$wt"
start=$(date -u +%FT%TZ)
case "$harness" in
    claude)
        claude --model "$model" \
            --dangerously-skip-permissions \
            -p "$(cat "$BENCH_DIR/prompt.txt")" \
            --output-format json \
            > "$RUNS/$slug-result.json" 2> "$RUNS/$slug-stderr.log"
        ;;
    pi)
        pi --model "$model" -p "$(cat "$BENCH_DIR/prompt.txt")" \
            > "$RUNS/$slug-result.txt" 2> "$RUNS/$slug-stderr.log"
        ;;
    *)
        echo "abort: unknown harness $harness" >&2
        exit 1
        ;;
esac
end=$(date -u +%FT%TZ)
pkill -f "$wt" 2>/dev/null || true
printf '{"model":"%s","harness":"%s","branch":"%s","base_commit":"%s","start":"%s","end":"%s"}\n' \
    "$model" "$harness" "$branch" "$BASE_COMMIT" "$start" "$end" > "$RUNS/$slug-meta.json"
echo "$slug: done" >&2
