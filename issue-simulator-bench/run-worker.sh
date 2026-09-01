#!/bin/bash
# Bootstraps one worktree and runs one worker on the issue-13 task.
# Usage: ./run-worker.sh <model> [harness] [bench] [thinking]
#   harness:  pi (default) | claude
#   bench:    guided (default) | blind — see PLAN.md; the two tests keep
#             separate prompts, base commits, branch suffixes, and results files.
#   thinking: pi thinking level (off, minimal, low, medium, high, xhigh, max);
#             appended to the slug so one model can have one row per level.
# pi runs go through run-pi-rpc.mjs (stateful RPC session with the fixed nudge
# policy, see PLAN.md); never through `pi -p`.
# Blocks until the worker finishes. Spawn several in parallel from separate shells.
set -euo pipefail

model="${1:?usage: run-worker.sh <model> [harness] [bench]}"
harness="${2:-pi}"
bench="${3:-guided}"
thinking="${4:-}"
BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$BENCH_DIR/.." && pwd)"
case "$bench" in
    guided)
        BASE_COMMIT=guided-v3-base
        PROMPT="$BENCH_DIR/prompt-guided.txt"
        suffix="-guided-issue-13"
        wtprefix="mendel-bench-guided-"
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
[ -n "$thinking" ] && slug="${slug}-${thinking}"
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
        node "$BENCH_DIR/run-pi-rpc.mjs" --model "$model" --prompt "$PROMPT" \
            --out "$RUNS/$slug" --cwd "$wt" ${thinking:+--thinking "$thinking"} \
            2> "$RUNS/$slug-runner.log"
        ;;
    *)
        echo "abort: unknown harness $harness" >&2
        exit 1
        ;;
esac
end=$(date -u +%FT%TZ)
pkill -f "$wt" 2>/dev/null || true
printf '{"model":"%s","harness":"%s","bench":"%s","thinking":"%s","branch":"%s","base_commit":"%s","start":"%s","end":"%s"}\n' \
    "$model" "$harness" "$bench" "$thinking" "$branch" "$(git -C "$REPO" rev-parse --short "$BASE_COMMIT")" "$start" "$end" > "$RUNS/$slug-worker.json"
echo "$slug: done" >&2
