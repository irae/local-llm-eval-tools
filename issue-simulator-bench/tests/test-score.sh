#!/bin/bash
# Tests for isb score: the evidence pack, the objective row, replace-by-branch,
# the judge merge and its refusal, a missing run, and isb judge-pack.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
ISB="$ROOT/isb"
TINY_TASK="$HERE/helpers/tiny-task"
FIXTURES="$HERE/fixtures"
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
# run-pi-rpc.mjs's session copy has real content for score.mjs to read.
healthy_run() {
    cp "$FIXTURES/session-healthy.jsonl" /tmp/fake-pi-session.jsonl
    export FAKE_PI_EVENTS="$FIXTURES/events-healthy.jsonl"
}

has_key() {
    node -e '
        const e = require(process.argv[1]);
        console.log(Object.prototype.hasOwnProperty.call(e, process.argv[2]));
    ' "$1" "$2"
}

row_field() {
    node -e '
        const r = require(process.argv[1]);
        const v = process.argv[2]
            .split(".")
            .reduce((o, k) => (o == null ? undefined : o[k]), r.runs[0]);
        if (v === undefined) { console.log(""); process.exit(0); }
        console.log(typeof v === "object" ? JSON.stringify(v) : v);
    ' "$1" "$2"
}

row_count_for_branch() {
    node -e '
        const r = require(process.argv[1]);
        console.log(r.runs.filter((x) => x.branch === process.argv[2]).length);
    ' "$1" "$2"
}

row_field_by_branch() {
    node -e '
        const r = require(process.argv[1]);
        const row = r.runs.find((x) => x.branch === process.argv[2]);
        if (!row) { console.log(""); process.exit(0); }
        const v = process.argv[3]
            .split(".")
            .reduce((o, k) => (o == null ? undefined : o[k]), row);
        if (v === undefined) { console.log(""); process.exit(0); }
        console.log(typeof v === "object" ? JSON.stringify(v) : v);
    ' "$1" "$2" "$3"
}

# ---- one real run, scored against through the rest of this file -------------

echo "test-score: setup — a real isb run to score against"
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
fslug="some-model-off-default"
results="$WORK/data/results/results-default.json"

echo "test-score: isb score writes the evidence pack, generic and battery keys present"
code=0
"$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" > "$WORK/score1.out" 2>"$WORK/score1.err" || code=$?
assert_eq "isb score exits 0" "$code" "0"
evidence="$WORK/data/evidence/$fslug-evidence.json"
[ -f "$evidence" ] && ok "evidence file exists" || bad "evidence file exists"
for key in commit_craft session_habits runner telemetry tiny_battery; do
    assert_eq "evidence has $key" "$(has_key "$evidence" "$key")" "true"
done

echo "test-score: the objective row lands in results-default.json"
[ -f "$results" ] && ok "results file exists" || bad "results file exists"
assert_eq "scored_by is battery" "$(row_field "$results" scored_by)" "battery"
assert_eq "resolved is true" "$(row_field "$results" resolved)" "true"
assert_eq "files_done is 2" "$(row_field "$results" files_done)" "2"
assert_eq "score_total is 15 (10 + 5)" "$(row_field "$results" score_total)" "15"
assert_eq "score_raw equals score_total on a fresh score" "$(row_field "$results" score_raw)" "15"
assert_eq "reruns is 0 on a fresh row" "$(row_field "$results" reruns)" "0"
assert_eq "resolved_by is lists (the task declares FAIL_TO_PASS/PASS_TO_PASS)" "$(row_field "$results" resolved_by)" "lists"
tool_version="$(row_field "$results" tool_version)"
[ -n "$tool_version" ] && ok "tool_version is present on the row" || bad "tool_version is present on the row"
[ -f "$WORK/data/results/results-default.csv" ] && ok "csv regenerated" || bad "csv regenerated"

echo "test-score: no matching variant refuses before writing the evidence pack"
task_novariant="$WORK/task-novariant"
cp -r "$task" "$task_novariant"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const t = JSON.parse(fs.readFileSync(p, "utf8"));
    t.variants.default.branch_suffix = "-nomatch";
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
' "$task_novariant/task.json"
evidence_before="$(cat "$evidence")"
code=0
err="$("$ISB" --task "$task_novariant" --data-dir "$WORK/data" score "$fslug" 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"no variant"*) ok "stderr names the missing variant match" ;;
    *) bad "stderr names the missing variant match"; echo "        got: $err" ;;
esac
evidence_after="$(cat "$evidence")"
assert_eq "the evidence pack is unchanged after the variant-mismatch refusal" "$evidence_after" "$evidence_before"

echo "test-score: a battery reporting a failed FAIL_TO_PASS test makes resolved false"
task_unresolved="$WORK/task-unresolved"
cp -r "$task" "$task_unresolved"
cat > "$task_unresolved/battery.sh" <<'EOF'
#!/bin/bash
set -u
printf '{"tiny_battery": {"unresolved": true}, "resolved": false, "files_done": 2, "scores": {"completion": 10, "lint": 5}, "tests": {"t_fix": false, "t_keep": true}}\n'
EOF
healthy_run
PATH="$pi_bin:$PATH" "$ISB" --task "$task_unresolved" --data-dir "$WORK/data" --thinking off run some-model-2 --allow-bad-config \
    > "$WORK/run2.log" 2>&1
fslug2="some-model-2-off-default"
"$ISB" --task "$task_unresolved" --data-dir "$WORK/data" score "$fslug2" > /dev/null 2>&1
assert_eq "resolved is false when a FAIL_TO_PASS test is false" \
    "$(row_field_by_branch "$results" "some-model-2-off-tiny" resolved)" "false"
assert_eq "resolved_by is lists" \
    "$(row_field_by_branch "$results" "some-model-2-off-tiny" resolved_by)" "lists"

echo "test-score: a second isb score replaces the row, not duplicates it"
"$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" > /dev/null 2>&1
assert_eq "exactly one row for the branch" "$(row_count_for_branch "$results" some-model-off-tiny)" "1"

echo "test-score: --judge merges a new criterion cleanly"
verdict="$WORK/verdict-new.json"
cat > "$verdict" <<'EOF'
{"judge": "strong-model", "scores": {"craft": 3}, "defects": ["minor nit"], "notes": {"summary": "ok", "what_decided_it": "diff review", "defects": "none major", "anomalies": "none"}}
EOF
code=0
"$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" --judge "$verdict" > /dev/null 2>"$WORK/judge.err" || code=$?
assert_eq "judge merge exits 0" "$code" "0"
assert_eq "score_total is 18 (15 + 3)" "$(row_field "$results" score_total)" "18"
assert_eq "scored_by is judge:strong-model" "$(row_field "$results" scored_by)" "judge:strong-model"
assert_eq "notes.summary landed on the row" "$(row_field "$results" notes.summary)" "ok"
assert_eq "defects landed on the row" "$(row_field "$results" defects)" '["minor nit"]'

echo "test-score: --judge refuses a clash with a battery-computed score"
before="$(cat "$results")"
verdict_clash="$WORK/verdict-clash.json"
cat > "$verdict_clash" <<'EOF'
{"judge": "strong-model", "scores": {"completion": 9}, "defects": [], "notes": {"summary": "x", "what_decided_it": "x", "defects": "x", "anomalies": "x"}}
EOF
code=0
err="$("$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" --judge "$verdict_clash" 2>&1 1>/dev/null)" || code=$?
assert_eq "refusal exit code is 2" "$code" "2"
case "$err" in
    *"completion"*) ok "stderr names the clashing key" ;;
    *) bad "stderr names the clashing key"; echo "        got: $err" ;;
esac
after="$(cat "$results")"
assert_eq "results file is unchanged after the refusal" "$after" "$before"

echo "test-score: --judge with an unparseable verdict file refuses cleanly, writes nothing"
before="$(cat "$results")"
verdict_bad_json="$WORK/verdict-bad-json.json"
printf '{not valid json' > "$verdict_bad_json"
code=0
err="$("$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" --judge "$verdict_bad_json" 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"cannot parse judge file"*) ok "stderr names the parse failure, not a raw stack trace" ;;
    *) bad "stderr names the parse failure, not a raw stack trace"; echo "        got: $err" ;;
esac
after="$(cat "$results")"
assert_eq "results file is unchanged after the parse-error refusal" "$after" "$before"

echo "test-score: --judge with a non-numeric score refuses cleanly, writes nothing"
before="$(cat "$results")"
verdict_bad_score="$WORK/verdict-bad-score.json"
cat > "$verdict_bad_score" <<'EOF'
{"judge": "strong-model", "scores": {"craft": "three"}, "defects": [], "notes": {"summary": "x", "what_decided_it": "x", "defects": "x", "anomalies": "x"}}
EOF
code=0
err="$("$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" --judge "$verdict_bad_score" 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"craft"*"three"*) ok "stderr names the bad key and its value" ;;
    *) bad "stderr names the bad key and its value"; echo "        got: $err" ;;
esac
after="$(cat "$results")"
assert_eq "results file is unchanged after the bad-score refusal" "$after" "$before"

echo "test-score: --judge with no judge name refuses cleanly, writes nothing"
before="$(cat "$results")"
verdict_no_judge="$WORK/verdict-no-judge.json"
cat > "$verdict_no_judge" <<'EOF'
{"scores": {"craft": 3}, "defects": [], "notes": {"summary": "x", "what_decided_it": "x", "defects": "x", "anomalies": "x"}}
EOF
code=0
err="$("$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" --judge "$verdict_no_judge" 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"judge"*) ok "stderr names the missing judge field" ;;
    *) bad "stderr names the missing judge field"; echo "        got: $err" ;;
esac
after="$(cat "$results")"
assert_eq "results file is unchanged after the missing-judge-name refusal" "$after" "$before"

echo "test-score: an unrecognized argument to isb score is an error"
code=0
err="$("$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" --bogus-flag 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"--bogus-flag"*) ok "stderr names the unknown argument" ;;
    *) bad "stderr names the unknown argument"; echo "        got: $err" ;;
esac

echo "test-score: --judge with no value at the end of the command line errors, not a silent no-op"
before="$(cat "$results")"
code=0
err="$("$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" --judge 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"--judge"*) ok "stderr names --judge as needing a value" ;;
    *) bad "stderr names --judge as needing a value"; echo "        got: $err" ;;
esac
after="$(cat "$results")"
assert_eq "results file is unchanged (the judge merge was never silently skipped)" "$after" "$before"

echo "test-score: a second bare argument to isb score is an error"
code=0
err="$("$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" extra-arg 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"extra-arg"*) ok "stderr names the extra positional argument" ;;
    *) bad "stderr names the extra positional argument"; echo "        got: $err" ;;
esac

echo "test-score: isb score on a fslug with no run fails with a clear message"
code=0
err="$("$ISB" --task "$task" --data-dir "$WORK/data" score "no-such-run-default" 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is 2" "$code" "2"
case "$err" in
    *"no meta file"*"no-such-run-default"*) ok "stderr names the missing meta file" ;;
    *) bad "stderr names the missing meta file"; echo "        got: $err" ;;
esac

echo "test-score: a re-score carries forward a human-set reruns and applies the retry penalty"
node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const r = JSON.parse(fs.readFileSync(p, "utf8"));
    const row = r.runs.find((x) => x.branch === process.argv[2]);
    row.reruns = 2;
    fs.writeFileSync(p, JSON.stringify(r, null, 2));
' "$results" "some-model-off-tiny"
code=0
"$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" > /dev/null 2>"$WORK/score-rerun.err" || code=$?
assert_eq "rescore exits 0" "$code" "0"
assert_eq "reruns 2 is carried forward onto the rescored row" "$(row_field "$results" reruns)" "2"
assert_eq "score_raw is the fresh unpenalized sum (15)" "$(row_field "$results" score_raw)" "15"
assert_eq "score_total is 0 (15 raw minus a 20-point penalty, floored at 0)" "$(row_field "$results" score_total)" "0"

echo "test-score: a --judge merge on a reruns row keeps reruns and recomputes score_total from the new score_raw"
verdict_rerun="$WORK/verdict-rerun.json"
cat > "$verdict_rerun" <<'EOF'
{"judge": "strong-model", "scores": {"quality": 10}, "defects": [], "notes": {"summary": "x", "what_decided_it": "x", "defects": "x", "anomalies": "x"}}
EOF
code=0
"$ISB" --task "$task" --data-dir "$WORK/data" score "$fslug" --judge "$verdict_rerun" > /dev/null 2>"$WORK/judge-rerun.err" || code=$?
assert_eq "judge merge on a reruns row exits 0" "$code" "0"
assert_eq "reruns is still 2 after the judge merge" "$(row_field "$results" reruns)" "2"
assert_eq "score_raw is 25 (15 battery + 10 judge)" "$(row_field "$results" score_raw)" "25"
assert_eq "score_total is 5 (25 raw minus the same 20-point penalty)" "$(row_field "$results" score_total)" "5"

echo "test-score: isb judge-pack writes the rubric and a valid JSON block"
code=0
pack_file="$("$ISB" --task "$task" --data-dir "$WORK/data" judge-pack "$fslug")" || code=$?
assert_eq "judge-pack exits 0" "$code" "0"
[ -f "$pack_file" ] && ok "judge-pack file exists" || bad "judge-pack file exists"
rubric_first_line="$(head -n1 "$task/rubric.md")"
if grep -qF -- "$rubric_first_line" "$pack_file"; then
    ok "judge-pack contains the rubric text"
else
    bad "judge-pack contains the rubric text"
fi
json_ok="$(node -e '
    const fs = require("fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const m = text.match(/```json\n([\s\S]*?)\n```/);
    if (!m) { console.log("no-block"); process.exit(0); }
    try { JSON.parse(m[1]); console.log("ok"); } catch (e) { console.log("bad: " + e.message); }
' "$pack_file")"
assert_eq "judge-pack has a valid JSON block" "$json_ok" "ok"

rm -rf "$WORK"

echo "test-score: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
