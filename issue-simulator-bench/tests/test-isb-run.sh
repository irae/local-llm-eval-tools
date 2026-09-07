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

echo "test-isb-run: reserve_tokens falls back to the built-in default of 8192"
WORK="$(mktemp -d)"
new_home "$WORK"
out="$("$ISB" --task "$TINY_TASK" config)"
assert_eq "reserve_tokens defaults to 8192" "$(echo "$out" | grep '^reserve_tokens: ')" "reserve_tokens: 8192"
rm -rf "$WORK"

echo "test-isb-run: isb config prints all 15 required lines"
WORK="$(mktemp -d)"
new_home "$WORK"
out="$("$ISB" --task "$TINY_TASK" config)"
for key in task data_dir tool_version variant mode thinking max_tooling max_model \
    stall_min wall_min turn_min context_window reserve_tokens keep_recent_tokens; do
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

echo "test-isb-run: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
