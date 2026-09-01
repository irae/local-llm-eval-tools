#!/bin/bash
# Bootstraps one worktree and runs one worker on the issue-13 task.
# Usage: ./run-worker.sh <model> [harness] [bench] [thinking]
#   harness:  pi (the only harness; claude was retired 2026-09-01 — existing
#             claude-code rows stay in the results until replaced)
#   bench:    guided (default) | blind — see PLAN.md; the two tests keep
#             separate prompts, base commits, branch suffixes, and results files.
#   thinking: pi thinking level (off, minimal, low, medium, high, xhigh, max);
#             MANDATORY for pi runs (a level inherited from operator settings is
#             not comparable); appended to the slug so one model can have one
#             row per level.
# Every run gets a pinned environment: a benchmark-owned config dir with the
# frozen agents-global.md as the only global context file, no operator
# extensions/skills/plugins/hooks, and a check that no stray AGENTS.md or
# CLAUDE.md sits in a parent directory of the worktree.
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
        suffix="-guided-v3-issue-13"
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
if [ "$harness" = "pi" ] && [ -z "$thinking" ]; then
    echo "abort: pi runs need an explicit thinking level (off|minimal|low|medium|high|xhigh|max)" >&2
    exit 1
fi
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

# No stray context files above the worktree: they would layer into the run.
dir="$(cd "$(dirname "$wt")" && pwd)"
while [ "$dir" != "/" ]; do
    for f in AGENTS.md AGENTS.override.md CLAUDE.md; do
        if [ -e "$dir/$f" ]; then
            echo "abort: $dir/$f would leak into the run; move it or run from elsewhere" >&2
            exit 1
        fi
    done
    dir="$(dirname "$dir")"
done

rm -rf "$wt"
git -C "$REPO" worktree add -b "$branch" "$wt" "$BASE_COMMIT"
(cd "$wt" && pnpm install > "$RUNS/$slug-install.log" 2>&1)
echo "$slug: worktree ready at $wt, starting $harness" >&2

# Plan accounting: probe the subscription windows before and after (see PLAN.md).
case "$harness:$model" in
    pi:openai-codex/*) plan_provider=openai-codex ;;
    pi:xai/*) plan_provider=xai ;;
    *) plan_provider=none ;;
esac
if ! node "$BENCH_DIR/probe-plan.mjs" "$plan_provider" --out "$RUNS/$slug-plan-before.json" > /dev/null; then
    echo "abort: plan probe failed for $plan_provider — no baseline, the run would not be accountable" >&2
    exit 1
fi

# Pinned config dir, rebuilt per run: only credentials, model config, and the
# frozen global instructions get in. Never versioned (see .gitignore).
build_pi_agent_dir() {
    local d="$BENCH_DIR/.pi-agent"
    rm -rf "$d" && mkdir -p "$d"
    for f in models.json auth.json models-store.json; do
        [ -e "$HOME/.pi/agent/$f" ] && cp "$HOME/.pi/agent/$f" "$d/"
    done
    printf '{"compaction":{"enabled":true},"retry":{"enabled":true}}\n' > "$d/settings.json"
    cp "$BENCH_DIR/agents-global.md" "$d/AGENTS.md"
    echo "$d"
}

cd "$wt"
start=$(date -u +%FT%TZ)
case "$harness" in
    claude)
        echo "abort: the claude harness is retired (2026-09-01); run models through pi" >&2
        exit 1
        ;;
    pi)
        agentdir="$(build_pi_agent_dir)"
        PI_CODING_AGENT_DIR="$agentdir" \
        node "$BENCH_DIR/run-pi-rpc.mjs" --model "$model" --prompt "$PROMPT" \
            --out "$RUNS/$slug" --cwd "$wt" --thinking "$thinking" \
            2> "$RUNS/$slug-runner.log"
        ;;
    *)
        echo "abort: unknown harness $harness" >&2
        exit 1
        ;;
esac
end=$(date -u +%FT%TZ)
node "$BENCH_DIR/probe-plan.mjs" "$plan_provider" --out "$RUNS/$slug-plan-after.json" > /dev/null \
    || echo "warning: plan probe after the run failed; record the plan share by hand" >&2
pkill -f "$wt" 2>/dev/null || true
printf '{"model":"%s","harness":"%s","bench":"%s","thinking":"%s","plan_provider":"%s","branch":"%s","base_commit":"%s","start":"%s","end":"%s","pinned_env":"agents-global v1.0"}\n' \
    "$model" "$harness" "$bench" "$thinking" "$plan_provider" "$branch" "$(git -C "$REPO" rev-parse --short "$BASE_COMMIT")" "$start" "$end" > "$RUNS/$slug-worker.json"
echo "$slug: done" >&2
