#!/bin/bash
# One run of the pi harness on the task isb resolved.
# Usage: run-worker.sh <model> [--keep] [--allow-bad-config]
#        run-worker.sh --cleanup <slug>
# Called by isb (never directly): isb exports ISB_TASK_DIR, ISB_DATA_DIR and
# every ISB_* setting before this script starts. This script reads task.json
# for the manifest fields (repo, base_commit, variants, install, agents_file,
# cleanup, plan_providers) and never re-reads config.json or task defaults.
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOP_CHECK="${LOOP_CHECK:-$BENCH_DIR/loop-check.py}"

# A relative --data-dir must resolve before the script cd's into the
# checkout, or every later path built from it lands inside the checkout.
if [ -n "${ISB_DATA_DIR:-}" ]; then
    mkdir -p "$ISB_DATA_DIR"
    ISB_DATA_DIR="$(cd "$ISB_DATA_DIR" && pwd)"
fi

json_get() {
    local file="$1" key="$2"
    [ -f "$file" ] || return 0
    node -e '
        const fs = require("fs");
        let v;
        try { v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
        catch (e) { process.exit(0); }
        for (const k of process.argv[2].split(".")) {
            if (v == null) break;
            v = v[k];
        }
        if (v != null && typeof v !== "object") console.log(v);
    ' "$file" "$key"
}

variant_names() {
    node -e '
        const fs = require("fs");
        let v = {};
        try { v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).variants || {}; }
        catch (e) {}
        console.log(Object.keys(v).join(", "));
    ' "$1"
}

variant_exists() {
    node -e '
        const fs = require("fs");
        let v = {};
        try { v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).variants || {}; }
        catch (e) {}
        process.exit(Object.prototype.hasOwnProperty.call(v, process.argv[2]) ? 0 : 1);
    ' "$1" "$2"
}

resolve_repo_path() {
    local task_json="$1" task_dir="$2" field
    field="$(json_get "$task_json" repo_path)"
    if [ -n "$field" ]; then
        case "$field" in
            /*) echo "$field" ;;
            *) echo "$task_dir/$field" ;;
        esac
        return
    fi
    git -C "$task_dir" rev-parse --show-toplevel 2>/dev/null || true
}

model=""
keep=0
allow_bad_config=0
cleanup_slug=""
have_model=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --keep)
            keep=1
            ;;
        --allow-bad-config)
            allow_bad_config=1
            ;;
        --cleanup)
            shift
            cleanup_slug="${1:-}"
            ;;
        --*)
            echo "error: unknown argument $1" >&2
            exit 2
            ;;
        *)
            if [ "$have_model" = "1" ]; then
                echo "error: unknown argument $1" >&2
                exit 2
            fi
            model="$1"
            have_model=1
            ;;
    esac
    shift
done

# --- cleanup mode: no model, no thinking level, no variant needed -----------
if [ -n "$cleanup_slug" ]; then
    if [ -z "${ISB_TASK_DIR:-}" ]; then
        echo "error: no task resolved (isb should have caught this)" >&2
        exit 2
    fi
    task_json="$ISB_TASK_DIR/task.json"
    worker_file="$ISB_DATA_DIR/runs/$cleanup_slug-worker.json"
    if [ ! -f "$worker_file" ]; then
        echo "error: no worker file for $cleanup_slug at $worker_file" >&2
        exit 2
    fi
    cmode="$(json_get "$worker_file" mode)"
    checkout="$(json_get "$worker_file" checkout)"
    if [ "$cmode" = "clone" ]; then
        rm -rf "$checkout"
    elif [ "$cmode" = "worktree" ]; then
        repo_path="$(resolve_repo_path "$task_json" "$ISB_TASK_DIR")"
        cleanup_script="$(json_get "$task_json" cleanup)"
        if [ -n "$cleanup_script" ]; then
            bash "$ISB_TASK_DIR/$cleanup_script" "$checkout"
        fi
        pkill -f "$checkout" 2>/dev/null || true
        git -C "$repo_path" worktree remove --force "$checkout"
    fi
    echo "$cleanup_slug: cleaned up" >&2
    exit 0
fi

# --- refuse early ------------------------------------------------------------
if [ -z "$model" ]; then
    echo "usage: run-worker.sh <model> [--keep] [--allow-bad-config]" >&2
    exit 2
fi
if [ -z "${ISB_TASK_DIR:-}" ]; then
    echo "error: no task resolved (isb should have caught this)" >&2
    exit 2
fi
if [ -z "${ISB_THINKING:-}" ]; then
    echo "error: thinking level required (--thinking, task defaults, or config.json)" >&2
    exit 2
fi
task_json="$ISB_TASK_DIR/task.json"
if [ -z "${ISB_VARIANT:-}" ] || ! variant_exists "$task_json" "$ISB_VARIANT"; then
    echo "error: unknown variant '$ISB_VARIANT' (task defines: $(variant_names "$task_json"))" >&2
    exit 2
fi

# --- resolve the variant and the repository ----------------------------------
instance_id="$(json_get "$task_json" instance_id)"
repo="$(json_get "$task_json" repo)"
base_commit="$(json_get "$task_json" base_commit)"
agents_file="$(json_get "$task_json" agents_file)"
install_cmd="$(json_get "$task_json" install)"
cleanup_script="$(json_get "$task_json" cleanup)"

prompt="$(json_get "$task_json" "variants.$ISB_VARIANT.prompt")"
variant_base_commit="$(json_get "$task_json" "variants.$ISB_VARIANT.base_commit")"
branch_suffix="$(json_get "$task_json" "variants.$ISB_VARIANT.branch_suffix")"
worktree_prefix="$(json_get "$task_json" "variants.$ISB_VARIANT.worktree_prefix")"
[ -n "$variant_base_commit" ] && base_commit="$variant_base_commit"

repo_path="$(resolve_repo_path "$task_json" "$ISB_TASK_DIR")"
repo_url="$(json_get "$task_json" repo_url)"
if [ -z "$repo_url" ] && [ -n "$repo" ]; then
    repo_url="https://github.com/${repo}.git"
fi

mode="${ISB_MODE:-}"
if [ -z "$mode" ]; then
    if [ -n "$repo_path" ]; then mode="worktree"; else mode="clone"; fi
fi
case "$mode" in
    worktree)
        if [ -z "$repo_path" ]; then
            echo "error: worktree mode needs repo_path (task.json repo_path, or a task folder inside a checkout)" >&2
            exit 2
        fi
        ;;
    clone)
        if [ -z "$repo_url" ]; then
            echo "error: clone mode needs repo_url or repo" >&2
            exit 2
        fi
        ;;
    *)
        echo "error: unknown mode '$mode' (worktree or clone)" >&2
        exit 2
        ;;
esac

# --- the slug, the branch, the checkout ---------------------------------------
slug="$(echo "$model" | tr '/:' '--')"
[ -n "$ISB_THINKING" ] && slug="${slug}-${ISB_THINKING}"
fslug="${slug}-${ISB_VARIANT}"
branch="${slug}${branch_suffix}"

mkdir -p "$ISB_DATA_DIR/runs"

if [ "$mode" = "worktree" ]; then
    checkout="$(dirname "$repo_path")/${worktree_prefix}${slug}"
    if git -C "$repo_path" show-ref --quiet "refs/heads/$branch"; then
        echo "abort: branch $branch exists" >&2
        exit 1
    fi
    # No stray context files above the checkout: they would leak into the run.
    dir="$(cd "$(dirname "$checkout")" && pwd)"
    while [ "$dir" != "/" ]; do
        for f in AGENTS.md AGENTS.override.md CLAUDE.md; do
            if [ -e "$dir/$f" ]; then
                echo "abort: $dir/$f would leak into the run; move it or run from elsewhere" >&2
                exit 1
            fi
        done
        dir="$(dirname "$dir")"
    done
    rm -rf "$checkout"
    git -C "$repo_path" worktree add -b "$branch" "$checkout" "$base_commit"
else
    checkout="$ISB_DATA_DIR/clones/$fslug"
    mkdir -p "$(dirname "$checkout")"
    rm -rf "$checkout"
    git clone "$repo_url" "$checkout"
    git -C "$checkout" checkout -b "$branch" "$base_commit"
fi
base_commit_short="$(git -C "$checkout" rev-parse --short "$base_commit")"

# --- install -------------------------------------------------------------------
if [ -n "$install_cmd" ]; then
    (cd "$checkout" && bash -c "$install_cmd") > "$ISB_DATA_DIR/runs/$fslug-install.log" 2>&1
fi
echo "$slug: checkout ready at $checkout, starting pi" >&2

# --- plan accounting: probe the subscription windows before and after --------
plan_provider="$(node -e '
    const fs = require("fs");
    let data = {};
    try { data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) {}
    const providers = data.plan_providers || {};
    const model = process.argv[2];
    let found = "none";
    for (const [prefix, name] of Object.entries(providers)) {
        if (model.startsWith(prefix)) { found = name; break; }
    }
    console.log(found);
' "$task_json" "$model")"
if ! node "$BENCH_DIR/probe-plan.mjs" "$plan_provider" --out "$ISB_DATA_DIR/runs/$fslug-plan-before.json" > /dev/null; then
    echo "abort: plan probe failed for $plan_provider — no baseline, the run would not be accountable" >&2
    exit 1
fi

# --- pinned config dir, rebuilt per run under the data directory -------------
agentdir="$ISB_DATA_DIR/runs/.pi-agent-$fslug"
rm -rf "$agentdir" && mkdir -p "$agentdir"
for f in models.json auth.json models-store.json; do
    [ -e "$HOME/.pi/agent/$f" ] && cp "$HOME/.pi/agent/$f" "$agentdir/"
done
if [ -n "${ISB_CONTEXT_WINDOW:-}" ] && [ -f "$agentdir/models.json" ]; then
    node -e '
        const fs = require("fs");
        const path = process.argv[1];
        const model = process.argv[2];
        const cw = Number(process.argv[3]);
        let data;
        try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { process.exit(0); }
        const suffix = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
        let found = null;
        (function walk(node) {
            if (found || node == null || typeof node !== "object") return;
            for (const [k, v] of Object.entries(node)) {
                if (found) return;
                if ((k === model || k === suffix) && v && typeof v === "object" && !Array.isArray(v)) {
                    found = v;
                    return;
                }
                if (v && typeof v === "object") walk(v);
            }
        })(data);
        if (!found) {
            if (!data[model] || typeof data[model] !== "object") data[model] = {};
            found = data[model];
        }
        found.contextWindow = cw;
        fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
    ' "$agentdir/models.json" "$model" "$ISB_CONTEXT_WINDOW"
fi
node -e '
    const fs = require("fs");
    const outFile = process.argv[1];
    const reserve = Number(process.argv[2]);
    const keepRecent = process.argv[3];
    const settings = { compaction: { enabled: true, reserveTokens: reserve }, retry: { enabled: true } };
    if (keepRecent) settings.compaction.keepRecentTokens = Number(keepRecent);
    fs.writeFileSync(outFile, JSON.stringify(settings) + "\n");
' "$agentdir/settings.json" "$ISB_RESERVE_TOKENS" "${ISB_KEEP_RECENT_TOKENS:-}"
cp "$ISB_TASK_DIR/$agents_file" "$agentdir/AGENTS.md"

# --- run the harness -----------------------------------------------------------
rpc_args=(--model "$model" --prompt "$ISB_TASK_DIR/$prompt" \
    --out "$ISB_DATA_DIR/runs/$fslug" --cwd "$checkout" --thinking "$ISB_THINKING" \
    --task "$ISB_TASK_DIR")
[ "$allow_bad_config" = "1" ] && rpc_args+=(--allow-bad-config)
[ -n "${ISB_CONTEXT_WINDOW:-}" ] && rpc_args+=(--context-window "$ISB_CONTEXT_WINDOW")
rpc_args+=(--reserve-tokens "$ISB_RESERVE_TOKENS")
[ -n "${ISB_KEEP_RECENT_TOKENS:-}" ] && rpc_args+=(--keep-recent-tokens "$ISB_KEEP_RECENT_TOKENS")
[ -n "${ISB_MAX_TOOLING:-}" ] && rpc_args+=(--max-tooling "$ISB_MAX_TOOLING")
[ -n "${ISB_MAX_MODEL:-}" ] && rpc_args+=(--max-model "$ISB_MAX_MODEL")
[ -n "${ISB_STALL_MIN:-}" ] && rpc_args+=(--stall-min "$ISB_STALL_MIN")
[ -n "${ISB_WALL_MIN:-}" ] && rpc_args+=(--wall-min "$ISB_WALL_MIN")
[ -n "${ISB_TURN_MIN:-}" ] && rpc_args+=(--turn-min "$ISB_TURN_MIN")

# The server log offset is read before the runner log file exists, so no
# later step can change the file's size between this read and the run's own
# start. A missing or unreadable path only warns; a log that shrank (rotated
# or truncated) falls back to the whole file, silently.
server_log_offset=""
server_log_warning=""
if [ -n "${ISB_SERVER_LOG:-}" ]; then
    if [ -r "$ISB_SERVER_LOG" ]; then
        server_log_offset="$(wc -c < "$ISB_SERVER_LOG" | tr -d ' ')"
    else
        server_log_warning="warning: --server-log path $ISB_SERVER_LOG is missing or unreadable; the run continues with no capture"
    fi
fi

runner_log="$ISB_DATA_DIR/runs/$fslug-runner.log"
: > "$runner_log"
[ -n "$server_log_warning" ] && echo "$server_log_warning" >> "$runner_log"

cd "$checkout"
start=$(date -u +%FT%TZ)
PI_CODING_AGENT_DIR="$agentdir" \
node "$BENCH_DIR/run-pi-rpc.mjs" "${rpc_args[@]}" \
    2>> "$runner_log"
end=$(date -u +%FT%TZ)

server_log_rel=""
if [ -n "$server_log_offset" ] && [ -r "$ISB_SERVER_LOG" ]; then
    server_log_dest="$ISB_DATA_DIR/runs/$fslug-server.log"
    server_log_size="$(wc -c < "$ISB_SERVER_LOG" | tr -d ' ')"
    if [ "$server_log_size" -lt "$server_log_offset" ]; then
        cp "$ISB_SERVER_LOG" "$server_log_dest"
    else
        tail -c "+$((server_log_offset + 1))" "$ISB_SERVER_LOG" > "$server_log_dest"
    fi
    server_log_rel="runs/$fslug-server.log"
fi

# --- repetition-loop verdict at run close: a flag beside the row, never a stop
loop_verdict="unchecked"
loop_ratio=""
loop_kind=""
run_loop_check() {
    local log="$ISB_DATA_DIR/runs/$fslug-session.jsonl"
    if [ ! -e "$LOOP_CHECK" ]; then
        echo "warning: no loop-check.py at $LOOP_CHECK; set LOOP_CHECK" >&2
        return
    fi
    if [ ! -e "$log" ]; then
        echo "warning: no session log at $log; loop verdict skipped" >&2
        return
    fi
    python3 "$LOOP_CHECK" "$log" > "$ISB_DATA_DIR/runs/$fslug-loop.txt" 2>&1 || true
    read -r loop_kind loop_ratio loop_verdict <<< "$(awk '
        /distinct-shape ratio=/ {
            for (i = 1; i <= NF; i++)
                if ($i ~ /^ratio=/) r = substr($i, 7)
            if (best == "" || r + 0 < best + 0) { best = r; k = $1; v = $NF }
        }
        END { if (best != "") print k, best, v }
    ' "$ISB_DATA_DIR/runs/$fslug-loop.txt")"
    case "$loop_kind" in
        thinking_delta) loop_kind=thinking ;;
        text_delta) loop_kind=text ;;
        toolcall_delta) loop_kind="tool call" ;;
    esac
    if [ -z "$loop_verdict" ]; then
        loop_verdict="unreadable"
    fi
    echo "$slug: loop verdict $loop_verdict, worst ratio ${loop_ratio:-none} on ${loop_kind:-none}" >&2
}
run_loop_check

node "$BENCH_DIR/probe-plan.mjs" "$plan_provider" --out "$ISB_DATA_DIR/runs/$fslug-plan-after.json" > /dev/null \
    || echo "warning: plan probe after the run failed; record the plan share by hand" >&2
pkill -f "$checkout" 2>/dev/null || true
rm -rf "$agentdir"

# --- the artifact pack ---------------------------------------------------------
artifacts_dir="$ISB_DATA_DIR/artifacts/$fslug"
mkdir -p "$artifacts_dir/patches"
git -C "$checkout" format-patch "$base_commit"..HEAD -o "$artifacts_dir/patches" > /dev/null
if [ "$(git -C "$checkout" rev-list --count "$base_commit"..HEAD)" != "0" ]; then
    git -C "$checkout" bundle create "$artifacts_dir/$slug.bundle" "$base_commit..HEAD" > /dev/null
fi
git -C "$checkout" diff > "$artifacts_dir/diff.patch"
git -C "$checkout" status > "$artifacts_dir/status.txt"
git -C "$checkout" log --oneline "$base_commit..HEAD" > "$artifacts_dir/log.txt"
node -e '
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const [checkout, base, instanceId, model, outFile] = process.argv.slice(1);
    const opts = { encoding: "utf8", maxBuffer: 1024 * 1024 * 200 };
    const committed = execFileSync("git", ["-C", checkout, "diff", `${base}..HEAD`], opts);
    const uncommitted = execFileSync("git", ["-C", checkout, "diff"], opts);
    const obj = {
        instance_id: instanceId,
        model_name_or_path: model,
        model_patch: `${committed}\n${uncommitted}`,
    };
    fs.writeFileSync(outFile, JSON.stringify(obj) + "\n");
' "$checkout" "$base_commit" "$instance_id" "$model" "$artifacts_dir/predictions.jsonl"

# --- the worker file -------------------------------------------------------------
pinned_env="$(basename "$agents_file") ($instance_id)"
node -e '
    const fs = require("fs");
    const [model, harness, bench, thinking, plan_provider, branch, base_commit,
        start, end, pinned_env, loop_flag, loop_ratio, loop_kind, task, mode,
        checkout, artifacts, tool_version, server_log, outFile] = process.argv.slice(1);
    const obj = {
        model, harness, bench, thinking, plan_provider, branch, base_commit,
        start, end, pinned_env, loop_flag, loop_ratio, loop_kind, task, mode,
        checkout, artifacts, tool_version, server_log: server_log || null,
    };
    fs.writeFileSync(outFile, JSON.stringify(obj, null, 2) + "\n");
' "$model" pi "$ISB_VARIANT" "$ISB_THINKING" "$plan_provider" "$branch" \
    "$base_commit_short" "$start" "$end" "$pinned_env" "$loop_verdict" \
    "$loop_ratio" "$loop_kind" "$ISB_TASK_DIR" "$mode" "$checkout" \
    "$artifacts_dir" "$ISB_TOOL_VERSION" "$server_log_rel" "$ISB_DATA_DIR/runs/$fslug-worker.json"

if [ "$mode" = "clone" ] && [ "$keep" != "1" ]; then
    rm -rf "$checkout"
fi
echo "$slug: done" >&2
