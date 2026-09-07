#!/bin/bash
# Tests for isb import-swebench: the generated task folder, its default
# location, the battery it writes, and the strict-argv and missing-field
# refusals.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
ISB="$ROOT/isb"
FIXTURE="$HERE/helpers/swebench-instance.json"
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

WORK="$(mktemp -d)"
new_home "$WORK"

echo "test-import: --to writes the task folder at exactly that path"
out_dir="$WORK/somewhere/task-out"
code=0
out="$("$ISB" import-swebench "$FIXTURE" --to "$out_dir")" || code=$?
assert_eq "exit code is 0" "$code" "0"
assert_eq "stdout is the target dir" "$out" "$out_dir"
[ -f "$out_dir/task.json" ] && ok "task.json written under --to" || bad "task.json written under --to"

echo "test-import: no --to writes ./<instance_id> relative to the cwd"
cwd_test="$WORK/cwd-test"
mkdir -p "$cwd_test"
code=0
(cd "$cwd_test" && "$ISB" import-swebench "$FIXTURE" > /dev/null) || code=$?
assert_eq "exit code is 0" "$code" "0"
[ -d "$cwd_test/tiny__repo-1" ] && ok "task folder written at ./<instance_id>" || bad "task folder written at ./<instance_id>"

echo "test-import: task.json is valid JSON and isb config resolves it"
code=0
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$out_dir/task.json" || code=$?
assert_eq "task.json parses as JSON" "$code" "0"
code=0
resolved="$("$ISB" --task "$out_dir" config 2>"$WORK/config.err")" || code=$?
assert_eq "isb config exits 0" "$code" "0"
case "$resolved" in
    *"task: $out_dir"*) ok "isb config resolves the task dir" ;;
    *) bad "isb config resolves the task dir"; echo "        got: $resolved" ;;
esac

echo "test-import: issue.md holds the problem statement verbatim"
statement="$(node -e '
    console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).problem_statement)
' "$FIXTURE")"
issue_text="$(cat "$out_dir/issue.md")"
assert_eq "issue.md equals the problem statement" "$issue_text" "$statement"

echo "test-import: prompts/default.txt includes the problem statement"
if grep -qF "$statement" "$out_dir/prompts/default.txt"; then
    ok "prompts/default.txt contains the problem statement"
else
    bad "prompts/default.txt contains the problem statement"
fi

echo "test-import: battery.mjs against the unset test_cmd reports both tests false"
mkdir -p "$WORK/nowhere"
battery_out="$(node "$out_dir/battery.mjs" "$WORK/nowhere" fake-branch fake-sha)"
assert_eq "output is valid JSON with a tests key" \
    "$(node -e 'console.log(typeof JSON.parse(process.argv[1]).tests)' "$battery_out")" "object"
assert_eq "t_fix is false" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).tests.t_fix)' "$battery_out")" "false"
assert_eq "t_keep is false" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).tests.t_keep)' "$battery_out")" "false"

echo "test-import: battery.mjs with a real test runner reports the true result"
runner="$WORK/fake-test-runner.sh"
cat > "$runner" <<'EOF'
#!/bin/bash
[ "$1" = "t_keep" ] && exit 0
exit 1
EOF
chmod +x "$runner"
task_copy="$WORK/task-copy"
cp -r "$out_dir" "$task_copy"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.test_cmd = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task_copy/task.json" "bash $runner"
battery_out2="$(node "$task_copy/battery.mjs" "$WORK/nowhere" fake-branch fake-sha)"
assert_eq "t_keep is true" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).tests.t_keep)' "$battery_out2")" "true"
assert_eq "t_fix is false" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).tests.t_fix)' "$battery_out2")" "false"

echo "test-import: a test id with a space and parentheses reaches the underlying command as one argument"
argv_marker="$WORK/argv-marker.txt"
argv_runner="$WORK/argv-runner.sh"
cat > "$argv_runner" <<'EOF'
#!/bin/bash
{
    echo "ARGC=$#"
    for a in "$@"; do echo "ARG=[$a]"; done
} > "$ARGV_MARKER"
exit 0
EOF
chmod +x "$argv_runner"
django_id="test_ordering (queries.tests.Queries1Tests)"
task_quote="$WORK/task-quote"
cp -r "$out_dir" "$task_quote"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.test_cmd = process.argv[2];
    t.FAIL_TO_PASS = [process.argv[3]];
    t.PASS_TO_PASS = [];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task_quote/task.json" "bash $argv_runner" "$django_id"
ARGV_MARKER="$argv_marker" node "$task_quote/battery.mjs" "$WORK/nowhere" fake-branch fake-sha > /dev/null
marker_content="$(cat "$argv_marker" 2>/dev/null || true)"
expected_marker="ARGC=1
ARG=[$django_id]"
assert_eq "the id with a space and parentheses arrives as one unsplit argument" "$marker_content" "$expected_marker"

echo "test-import: a test id with shell metacharacters cannot inject a command"
rm -f "$WORK/PWNED"
task_inject="$WORK/task-inject"
cp -r "$out_dir" "$task_inject"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.test_cmd = "true";
    t.FAIL_TO_PASS = [process.argv[2]];
    t.PASS_TO_PASS = [];
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task_inject/task.json" "x; touch $WORK/PWNED"
node "$task_inject/battery.mjs" "$WORK/nowhere" fake-branch fake-sha > /dev/null
[ -f "$WORK/PWNED" ] && bad "the injected command did not run" || ok "the injected command did not run"

echo "test-import: a missing required field refuses cleanly, writes nothing"
bad_instance="$WORK/bad-instance.json"
node -e '
    const fs = require("fs");
    const i = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    delete i.problem_statement;
    fs.writeFileSync(process.argv[2], JSON.stringify(i, null, 2));
' "$FIXTURE" "$bad_instance"
missing_dir="$WORK/missing-field-out"
code=0
err="$("$ISB" import-swebench "$bad_instance" --to "$missing_dir" 2>&1 1>/dev/null)" || code=$?
if [ "$code" != "0" ]; then ok "exit code is nonzero"; else bad "exit code is nonzero"; fi
case "$err" in
    *"problem_statement"*) ok "stderr names the missing field" ;;
    *) bad "stderr names the missing field"; echo "        got: $err" ;;
esac
[ -d "$missing_dir" ] && bad "no directory written on refusal" || ok "no directory written on refusal"

echo "test-import: an explicit null optional field is omitted from task.json, not written as null"
null_instance="$WORK/null-field-instance.json"
node -e '
    const fs = require("fs");
    const i = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    i.hints_text = null;
    fs.writeFileSync(process.argv[2], JSON.stringify(i, null, 2));
' "$FIXTURE" "$null_instance"
null_out="$WORK/null-field-out"
"$ISB" import-swebench "$null_instance" --to "$null_out" > /dev/null
has_key="$(node -e '
    console.log(Object.prototype.hasOwnProperty.call(
        JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")),
        "hints_text"
    ))
' "$null_out/task.json")"
assert_eq "hints_text key is absent when the source value is null" "$has_key" "false"

echo "test-import: an unrecognized argument is an error"
code=0
err="$("$ISB" import-swebench "$FIXTURE" --bogus-flag 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"--bogus-flag"*) ok "stderr names the unknown argument" ;;
    *) bad "stderr names the unknown argument"; echo "        got: $err" ;;
esac

rm -rf "$WORK"

echo "test-import: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
