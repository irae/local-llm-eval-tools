#!/bin/bash
# Tests for isb: task resolution (--task, .issue-simulator-bench/ in a git
# repository, config.json), the unresolved-task error, isb version, the
# three-level settings precedence, isb config's full output, and no-args /
# --help usage.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
ISB="$ROOT/isb"
TINY_TASK="$HERE/helpers/tiny-task"
PASS=0
FAIL=0

ok() {
    PASS=$(( PASS + 1 ))
    echo "  ok   $1"
}

bad() {
    FAIL=$(( FAIL + 1 ))
    echo "  FAIL $1"
}

assert_eq() {
    if [ "$2" = "$3" ]; then
        ok "$1"
    else
        bad "$1"
        echo "        wanted: $3"
        echo "        got: $2"
    fi
}

new_home() {
    local base="$1"
    mkdir -p "$base/home/.config" "$base/home/.local/share"
    export HOME="$base/home"
    export XDG_CONFIG_HOME="$base/home/.config"
    export XDG_DATA_HOME="$base/home/.local/share"
}

echo "test-isb-run: task found via --task"
WORK="$(mktemp -d)"
new_home "$WORK"
out="$("$ISB" --task "$TINY_TASK" config)"
assert_eq "task line names the given dir" "$(echo "$out" | grep '^task: ')" "task: $TINY_TASK"
rm -rf "$WORK"

echo "test-isb-run: task found from .issue-simulator-bench/ in a git repository"
WORK="$(mktemp -d)"
new_home "$WORK"
repo="$WORK/repo"
mkdir -p "$repo/.issue-simulator-bench" "$repo/sub"
git -C "$repo" init -q
printf '{"instance_id": "repo-task"}\n' > "$repo/.issue-simulator-bench/task.json"
out="$(cd "$repo/sub" && "$ISB" config)"
case "$(echo "$out" | grep '^data_dir: ')" in
    *repo-task*) ok "data_dir uses instance_id, not the basename" ;;
    *) bad "data_dir uses instance_id, not the basename"; echo "        got: $(echo "$out" | grep '^data_dir: ')" ;;
esac
case "$(echo "$out" | grep '^task: ')" in
    *.issue-simulator-bench) ok "task line ends in .issue-simulator-bench" ;;
    *) bad "task line ends in .issue-simulator-bench"; echo "        got: $(echo "$out" | grep '^task: ')" ;;
esac
rm -rf "$WORK"

echo "test-isb-run: task found from config.json"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$XDG_CONFIG_HOME/issue-simulator-bench"
printf '{"task": "%s"}\n' "$TINY_TASK" > "$XDG_CONFIG_HOME/issue-simulator-bench/config.json"
outside="$WORK/outside"
mkdir -p "$outside"
out="$(cd "$outside" && "$ISB" config)"
assert_eq "task line names the config.json path" "$(echo "$out" | grep '^task: ')" "task: $TINY_TASK"
rm -rf "$WORK"

echo "test-isb-run: unresolved task names all three sources and exits 2"
WORK="$(mktemp -d)"
new_home "$WORK"
outside="$WORK/outside"
mkdir -p "$outside"
err="$(cd "$outside" && "$ISB" config 2>&1 1>/dev/null)"
code=0
(cd "$outside" && "$ISB" config >/dev/null 2>/dev/null) || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"--task"*".issue-simulator-bench"*"config.json"*) ok "stderr names --task, .issue-simulator-bench and config.json" ;;
    *) bad "stderr names --task, .issue-simulator-bench and config.json"; echo "        got: $err" ;;
esac
rm -rf "$WORK"

echo "test-isb-run: isb version prints a non-empty string and exits 0"
WORK="$(mktemp -d)"
new_home "$WORK"
code=0
out="$("$ISB" version)" || code=$?
assert_eq "exit code is 0" "$code" "0"
[ -n "$out" ] && ok "version output is non-empty" || bad "version output is non-empty"
rm -rf "$WORK"

echo "test-isb-run: three-level precedence, task beats config, cli beats task"
WORK="$(mktemp -d)"
new_home "$WORK"
task="$WORK/precedence-task"
mkdir -p "$task"
printf '{"instance_id": "precedence-task", "defaults": {"variant": "from-task"}}\n' > "$task/task.json"
mkdir -p "$XDG_CONFIG_HOME/issue-simulator-bench"
printf '{"variant": "from-config"}\n' > "$XDG_CONFIG_HOME/issue-simulator-bench/config.json"
out="$("$ISB" --task "$task" config)"
assert_eq "task defaults beat config.json" "$(echo "$out" | grep '^variant: ')" "variant: from-task"
out="$("$ISB" --task "$task" --set variant=from-cli config)"
assert_eq "--set beats task defaults" "$(echo "$out" | grep '^variant: ')" "variant: from-cli"
rm -rf "$WORK"

echo "test-isb-run: server_log resolves from the command line then config.json, never the task's defaults"
WORK="$(mktemp -d)"
new_home "$WORK"
task="$WORK/server-log-task"
mkdir -p "$task"
printf '{"instance_id": "server-log-task", "defaults": {"server_log": "/from-task-defaults.log"}}\n' > "$task/task.json"
mkdir -p "$XDG_CONFIG_HOME/issue-simulator-bench"
printf '{"server_log": "/from-config.log"}\n' > "$XDG_CONFIG_HOME/issue-simulator-bench/config.json"
out="$("$ISB" --task "$task" config)"
assert_eq "config.json wins over the task's defaults for server_log" \
    "$(echo "$out" | grep '^server_log: ')" "server_log: /from-config.log"
out="$("$ISB" --task "$task" --server-log /from-cli.log config)"
assert_eq "--server-log wins over config.json" "$(echo "$out" | grep '^server_log: ')" "server_log: /from-cli.log"
rm -rf "$WORK"

echo "test-isb-run: reserve_tokens falls back to the built-in default of 8192"
WORK="$(mktemp -d)"
new_home "$WORK"
out="$("$ISB" --task "$TINY_TASK" config)"
assert_eq "reserve_tokens defaults to 8192" "$(echo "$out" | grep '^reserve_tokens: ')" "reserve_tokens: 8192"
rm -rf "$WORK"

echo "test-isb-run: isb config prints all 16 required lines"
WORK="$(mktemp -d)"
new_home "$WORK"
out="$("$ISB" --task "$TINY_TASK" config)"
for key in task data_dir tool_version variant mode thinking max_tooling max_model \
    stall_min wall_min turn_min context_window reserve_tokens keep_recent_tokens server_log; do
    if echo "$out" | grep -q "^$key: "; then
        ok "config prints $key"
    else
        bad "config prints $key"
    fi
done
rm -rf "$WORK"

echo "test-isb-run: no arguments and --help print usage first and exit 2"
WORK="$(mktemp -d)"
new_home "$WORK"
code=0
out="$("$ISB")" || code=$?
assert_eq "no-args exit code is 2" "$code" "2"
first_line="$(echo "$out" | head -n1)"
case "$first_line" in
    usage:*) ok "no-args first line is usage" ;;
    *) bad "no-args first line is usage"; echo "        got: $first_line" ;;
esac
code=0
out="$("$ISB" --help)" || code=$?
assert_eq "--help exit code is 2" "$code" "2"
first_line="$(echo "$out" | head -n1)"
case "$first_line" in
    usage:*) ok "--help first line is usage" ;;
    *) bad "--help first line is usage"; echo "        got: $first_line" ;;
esac
rm -rf "$WORK"

# ---- isb run: task folder, worktree/clone modes, artifact pack -------------
# A real local git repository stands in for the target: git init, one
# commit, tag base. No test ever points repo_url or repo_path outside a
# mktemp -d directory.

FIXTURES="$HERE/fixtures"

json_field() {
    node -e "const m=require(process.argv[1]); console.log(process.argv[2].split('.').reduce((o,k)=>o==null?'':o[k],m) ?? '')" "$1" "$2"
}

setup_fake_pi() {
    local base="$1"
    mkdir -p "$base/bin"
    ln -s "$HERE/helpers/fake-pi" "$base/bin/pi"
    echo "$base/bin"
}

make_target_repo() {
    local dir="$1"
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" config user.email a@test
    git -C "$dir" config user.name test
    echo hi > "$dir/file.txt"
    git -C "$dir" add -A
    git -C "$dir" commit -qm init
    git -C "$dir" tag base
}

# fake-pi's session file path is fixed; the healthy fixture goes there so
# run-pi-rpc.mjs's session copy, and so the loop check, has real content.
healthy_run() {
    cp "$FIXTURES/session-healthy.jsonl" /tmp/fake-pi-session.jsonl
    export FAKE_PI_EVENTS="$FIXTURES/events-healthy.jsonl"
}

echo "test-isb-run: isb run without a thinking level anywhere refuses"
WORK="$(mktemp -d)"
new_home "$WORK"
code=0
err="$("$ISB" --task "$TINY_TASK" --data-dir "$WORK/data" run some-model 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *thinking*) ok "stderr names the thinking requirement" ;;
    *) bad "stderr names the thinking requirement"; echo "        got: $err" ;;
esac
rm -rf "$WORK"

echo "test-isb-run: isb run refuses when a parent directory carries an AGENTS.md"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/parent/target"
make_target_repo "$WORK/parent/target"
cp -r "$TINY_TASK" "$WORK/parent/target/.isb-task"
echo "leak" > "$WORK/parent/AGENTS.md"
code=0
err="$("$ISB" --task "$WORK/parent/target/.isb-task" --data-dir "$WORK/data" --thinking off --mode worktree run some-model --allow-bad-config 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 1" "$code" "1"
case "$err" in
    *"AGENTS.md"*"leak"*) ok "stderr names the leaking file" ;;
    *) bad "stderr names the leaking file"; echo "        got: $err" ;;
esac
rm -rf "$WORK"

echo "test-isb-run: clone mode with the healthy fixture writes the worker file, the meta and the artifact pack"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
code=0
PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model --allow-bad-config \
    > "$WORK/run.log" 2>&1 || code=$?
assert_eq "isb run exits 0" "$code" "0"
worker_file="$WORK/data/runs/some-model-off-default-worker.json"
meta_file="$WORK/data/runs/some-model-off-default-meta.json"
[ -f "$worker_file" ] && ok "worker file exists" || bad "worker file exists"
assert_eq "worker file records clone mode" "$(json_field "$worker_file" mode)" "clone"
assert_eq "meta end_reason is complete" "$(json_field "$meta_file" end_reason)" "complete"
artifacts="$WORK/data/artifacts/some-model-off-default"
assert_eq "the checkout in the worker file is keyed by fslug, not just the slug" \
    "$(basename "$(json_field "$worker_file" checkout)")" "some-model-off-default"
for f in log.txt patches status.txt diff.patch predictions.jsonl; do
    [ -e "$artifacts/$f" ] && ok "artifact pack has $f" || bad "artifact pack has $f"
done
assert_eq "server_log is empty when no --server-log is given" "$(json_field "$worker_file" server_log)" ""
[ -f "$WORK/data/runs/some-model-off-default-server.log" ] \
    && bad "no server log capture file when no --server-log is given" \
    || ok "no server log capture file when no --server-log is given"
pred_keys="$(node -e '
    const fs = require("fs");
    const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(Object.keys(o).sort().join(","));
' "$artifacts/predictions.jsonl")"
assert_eq "predictions.jsonl has exactly the three keys" "$pred_keys" "instance_id,model_name_or_path,model_patch"
pred_patch_type="$(node -e '
    const fs = require("fs");
    const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(typeof o.model_patch);
' "$artifacts/predictions.jsonl")"
assert_eq "model_patch is a string" "$pred_patch_type" "string"
[ -d "$WORK/data/clones/some-model-off-default" ] && bad "clone directory removed after the run" || ok "clone directory removed after the run"
rm -rf "$WORK"

echo "test-isb-run: --keep keeps the clone directory"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model --allow-bad-config --keep \
    > "$WORK/run.log" 2>&1
[ -d "$WORK/data/clones/some-model-off-default" ] && ok "clone directory kept with --keep" || bad "clone directory kept with --keep"
rm -rf "$WORK"

echo "test-isb-run: worktree mode creates the branch and the sibling worktree, and refuses a second run"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/parent/target"
make_target_repo "$WORK/parent/target"
cp -r "$TINY_TASK" "$WORK/parent/target/.isb-task"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
PATH="$pi_bin:$PATH" "$ISB" --task "$WORK/parent/target/.isb-task" --data-dir "$WORK/data" --thinking off --mode worktree run some-model --allow-bad-config \
    > "$WORK/run.log" 2>&1
case "$(git -C "$WORK/parent/target" branch --list some-model-off-tiny)" in
    *some-model-off-tiny*) ok "branch was created in the target repository" ;;
    *) bad "branch was created in the target repository" ;;
esac
[ -d "$WORK/parent/tiny-bench-some-model-off" ] && ok "sibling worktree exists" || bad "sibling worktree exists"
code=0
err="$(PATH="$pi_bin:$PATH" "$ISB" --task "$WORK/parent/target/.isb-task" --data-dir "$WORK/data" --thinking off --mode worktree run some-model --allow-bad-config 2>&1 1>/dev/null)" || code=$?
assert_eq "second run refuses" "$code" "1"
case "$err" in
    *"branch"*"exists"*) ok "stderr names the existing branch" ;;
    *) bad "stderr names the existing branch"; echo "        got: $err" ;;
esac
rm -rf "$WORK"

echo "test-isb-run: the loop verdict from the session lands in the worker file"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model --allow-bad-config \
    > "$WORK/run.log" 2>&1
worker_file="$WORK/data/runs/some-model-off-default-worker.json"
assert_eq "loop_flag reflects the healthy session" "$(json_field "$worker_file" loop_flag)" "ok"
rm -rf "$WORK"

echo "test-isb-run: the pinned pi config directory is gone once the run returns"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model --allow-bad-config \
    > "$WORK/run.log" 2>&1
shopt -s nullglob
pinned=("$WORK/data/runs/.pi-agent-"*)
shopt -u nullglob
[ "${#pinned[@]}" = "0" ] && ok "pinned pi config directory is gone" || bad "pinned pi config directory is gone"
rm -rf "$WORK"

echo "test-isb-run: --context-window and --reserve-tokens land in meta.harness_window"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model --allow-bad-config \
    --context-window 40000 --reserve-tokens 4096 > "$WORK/run.log" 2>&1
meta_file="$WORK/data/runs/some-model-off-default-meta.json"
assert_eq "harness_window.context_window" "$(json_field "$meta_file" harness_window.context_window)" "40000"
assert_eq "harness_window.reserve_tokens" "$(json_field "$meta_file" harness_window.reserve_tokens)" "4096"
rm -rf "$WORK"

echo "test-isb-run: isb run --cleanup removes a worktree, the branch stays"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/parent/target"
make_target_repo "$WORK/parent/target"
cp -r "$TINY_TASK" "$WORK/parent/target/.isb-task"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
PATH="$pi_bin:$PATH" "$ISB" --task "$WORK/parent/target/.isb-task" --data-dir "$WORK/data" --thinking off --mode worktree run some-model --allow-bad-config \
    > "$WORK/run.log" 2>&1
"$ISB" --task "$WORK/parent/target/.isb-task" --data-dir "$WORK/data" run --cleanup some-model-off-default > "$WORK/cleanup.log" 2>&1
[ -d "$WORK/parent/tiny-bench-some-model-off" ] && bad "worktree removed by --cleanup" || ok "worktree removed by --cleanup"
case "$(git -C "$WORK/parent/target" branch --list some-model-off-tiny)" in
    *some-model-off-tiny*) ok "branch stays after --cleanup" ;;
    *) bad "branch stays after --cleanup" ;;
esac
rm -rf "$WORK"

echo "test-isb-run: install runs before the harness and leaves a log"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    t.install = "touch INSTALLED_MARKER";
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model --allow-bad-config --keep \
    > "$WORK/run.log" 2>&1
[ -e "$WORK/data/clones/some-model-off-default/INSTALLED_MARKER" ] && ok "install command ran in the checkout" || bad "install command ran in the checkout"
[ -e "$WORK/data/runs/some-model-off-default-install.log" ] && ok "install log exists" || bad "install log exists"
rm -rf "$WORK"

echo "test-isb-run: an unknown flag to isb run exits 2 and names the flag"
WORK="$(mktemp -d)"
new_home "$WORK"
code=0
err="$("$ISB" --task "$TINY_TASK" --data-dir "$WORK/data" --thinking off run some-model --bogus-flag x 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"--bogus-flag"*) ok "stderr names --bogus-flag" ;;
    *) bad "stderr names --bogus-flag"; echo "        got: $err" ;;
esac
rm -rf "$WORK"

echo "test-isb-run: a relative --data-dir resolves before the checkout cd, not inside it"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target" "$WORK/cwd"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
(cd "$WORK/cwd" && PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir ./relative-data-dir --thinking off run some-model --allow-bad-config --keep \
    > "$WORK/run.log" 2>&1)
[ -f "$WORK/cwd/relative-data-dir/runs/some-model-off-default-worker.json" ] \
    && ok "the worker file lands under the resolved data directory" \
    || bad "the worker file lands under the resolved data directory"
checkout="$WORK/cwd/relative-data-dir/clones/some-model-off-default"
[ -d "$checkout" ] && ok "the checkout itself lands under the resolved data directory" || bad "the checkout itself lands under the resolved data directory"
[ -e "$checkout/relative-data-dir" ] \
    && bad "no path resolved relative to the checkout instead of the launch directory" \
    || ok "no path resolved relative to the checkout instead of the launch directory"
rm -rf "$WORK"

# ---- --server-log: capture, missing path, rotation fallback -----------------
# The offset is recorded right before the fake pi starts, and the slice is
# written right after it ends; both happen fast, so each block backgrounds
# the run and waits for the runner log file to appear (the offset is always
# recorded before that file exists) before touching the server log file.

wait_for_runner_log() {
    local log="$1" i
    for i in $(seq 1 250); do
        [ -f "$log" ] && return 0
        sleep 0.02
    done
    return 1
}

echo "test-isb-run: --server-log captures only the lines written during the run"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
server_log="$WORK/server.log"
printf 'line-before-the-run\n' > "$server_log"
runner_log="$WORK/data/runs/some-model-off-default-runner.log"
(
    PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model \
        --allow-bad-config --server-log "$server_log" > "$WORK/run.log" 2>&1
) &
run_pid=$!
wait_for_runner_log "$runner_log" && printf 'line-during-the-run\n' >> "$server_log"
code=0
wait "$run_pid" || code=$?
assert_eq "run with --server-log exits 0" "$code" "0"
capture="$WORK/data/runs/some-model-off-default-server.log"
[ -f "$capture" ] && ok "server log capture file exists" || bad "server log capture file exists"
grep -qF "line-during-the-run" "$capture" && ok "capture holds the line written during the run" || bad "capture holds the line written during the run"
if grep -qF "line-before-the-run" "$capture"; then
    bad "capture excludes the line written before the run"
else
    ok "capture excludes the line written before the run"
fi
worker_file="$WORK/data/runs/some-model-off-default-worker.json"
assert_eq "worker file names the server log capture, relative to the data directory" \
    "$(json_field "$worker_file" server_log)" "runs/some-model-off-default-server.log"
rm -rf "$WORK"

echo "test-isb-run: a --server-log path that does not exist warns and does not fail the run"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
code=0
PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model \
    --allow-bad-config --server-log "$WORK/no-such-server.log" > "$WORK/run.log" 2>&1 || code=$?
assert_eq "run with a missing --server-log path still exits 0" "$code" "0"
runner_log="$WORK/data/runs/some-model-off-default-runner.log"
grep -qi "no capture" "$runner_log" && ok "runner log names the missing path as a warning" || bad "runner log names the missing path as a warning"
worker_file="$WORK/data/runs/some-model-off-default-worker.json"
assert_eq "server_log is empty when the path could not be read" "$(json_field "$worker_file" server_log)" ""
[ -f "$WORK/data/runs/some-model-off-default-server.log" ] \
    && bad "no server log capture file when the path could not be read" \
    || ok "no server log capture file when the path could not be read"
rm -rf "$WORK"

echo "test-isb-run: a server log truncated during the run falls back to the whole file, silently"
WORK="$(mktemp -d)"
new_home "$WORK"
mkdir -p "$WORK/target"
make_target_repo "$WORK/target"
task="$WORK/task"
cp -r "$TINY_TASK" "$task"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.repo_url = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task/task.json" "$WORK/target"
pi_bin="$(setup_fake_pi "$WORK")"
healthy_run
server_log="$WORK/server.log"
printf 'a-long-line-before-the-run-that-is-much-longer-than-the-rotated-file\n' > "$server_log"
runner_log="$WORK/data/runs/some-model-off-default-runner.log"
(
    PATH="$pi_bin:$PATH" "$ISB" --task "$task" --data-dir "$WORK/data" --thinking off run some-model \
        --allow-bad-config --server-log "$server_log" > "$WORK/run.log" 2>&1
) &
run_pid=$!
if wait_for_runner_log "$runner_log"; then
    : > "$server_log"
    printf 'rotated\n' >> "$server_log"
fi
code=0
wait "$run_pid" || code=$?
assert_eq "run with a rotated server log still exits 0" "$code" "0"
capture="$WORK/data/runs/some-model-off-default-server.log"
assert_eq "the whole rotated file is copied as the fallback" "$(cat "$capture" 2>/dev/null)" "rotated"
if grep -qi "no capture" "$runner_log"; then
    bad "the rotation fallback is silent, no warning line"
else
    ok "the rotation fallback is silent, no warning line"
fi
rm -rf "$WORK"

echo "test-isb-run: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
