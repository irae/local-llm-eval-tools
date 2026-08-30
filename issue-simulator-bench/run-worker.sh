#!/bin/bash
# Bootstraps one worktree and runs one worker on the issue-13 task.
# Usage: ./run-worker.sh <model> [harness] [bench]
#   harness: pi (default) | claude
#   bench:   guided (default) | blind — see PLAN.md; the two tests keep
#            separate prompts, base commits, branch suffixes, and results files.
# Blocks until the worker finishes. Spawn several in parallel from separate shells.
set -euo pipefail

model="${1:?usage: run-worker.sh <model> [harness] [bench]}"
harness="${2:-pi}"
bench="${3:-guided}"
BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$BENCH_DIR/.." && pwd)"
case "$bench" in
    guided)
        BASE_COMMIT=4679b5a
        PROMPT="$BENCH_DIR/prompt-guided.txt"
        suffix="-issue-13-r2"
        wtprefix="mendel-bench2-"
        ;;
    blind)
        BASE_COMMIT=182b07f
        PROMPT="$BENCH_DIR/prompt-blind.txt"
        suffix="-issue-13"
        wtprefix="mendel-bench-"
        ;;
    *)
        echo "abort: unknown bench $bench" >&2
        exit 1
        ;;
esac
RUNS="$BENCH_DIR/runs"
slug="$(echo "$model" | tr '/:' '--')"
branch="${slug}${suffix}"
wt="$REPO/../${wtprefix}${slug}"
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
            -p "$(cat "$PROMPT")" \
            --output-format json \
            > "$RUNS/$slug-result.json" 2> "$RUNS/$slug-stderr.log"
        ;;
    pi)
        pi --model "$model" -p "$(cat "$PROMPT")" \
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
