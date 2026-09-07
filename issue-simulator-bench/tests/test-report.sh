#!/bin/bash
# Tests for isb report: the report model, its json/csv/md/html renderers,
# --scan, --all, and the two refusals (score sum, retry-penalty formula).

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
ISB="$ROOT/isb"
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

row_by_model() {
    # row_by_model <report.json> <model> <dotted.key> -> the row's value
    node -e '
        const r = require(process.argv[1]);
        const rows = r.tasks[0].rows.flatMap((g) => g.rows);
        const row = rows.find((x) => x.model === process.argv[2]);
        if (!row) { console.log(""); process.exit(0); }
        const v = process.argv[3]
            .split(".")
            .reduce((o, k) => (o == null ? undefined : o[k]), row);
        if (v === undefined) { console.log(""); process.exit(0); }
        console.log(typeof v === "object" ? JSON.stringify(v) : v);
    ' "$1" "$2" "$3"
}

WORK="$(mktemp -d)"
new_home "$WORK"

# ---- a minimal task/variant pointing at the two-row fixture ------------------

task="$WORK/task"
mkdir -p "$task"
cat > "$task/task.json" <<'EOF'
{
  "instance_id": "report-test-1",
  "unit": { "field": "libraries_done", "max": 8, "label": "libraries" },
  "variants": {
    "default": { "version": "v2.1", "results": "results-two-rows.json" }
  },
  "defaults": { "variant": "default" }
}
EOF
mkdir -p "$WORK/data/results"
cp "$FIXTURES/results-two-rows.json" "$WORK/data/results/results-two-rows.json"

echo "test-report: --format json gives both rows, ranked and capped correctly"
code=0
"$ISB" --task "$task" --data-dir "$WORK/data" report --format json "$WORK/report.json" \
    > "$WORK/report1.out" 2>"$WORK/report1.err" || code=$?
assert_eq "exit code is 0" "$code" "0"
[ -f "$WORK/report.json" ] && ok "report.json exists" || bad "report.json exists"
assert_eq "claude-sonnet-5 rank is 1" "$(row_by_model "$WORK/report.json" claude-sonnet-5 rank)" "1"
assert_eq "claude-haiku-4.5 rank is 2" "$(row_by_model "$WORK/report.json" claude-haiku-4.5 rank)" "2"
assert_eq "claude-sonnet-5 capped is 98.5" "$(row_by_model "$WORK/report.json" claude-sonnet-5 capped)" "98.5"
assert_eq "claude-sonnet-5 raw is 98.5" "$(row_by_model "$WORK/report.json" claude-sonnet-5 raw)" "98.5"
assert_eq "claude-haiku-4.5 capped is 68" "$(row_by_model "$WORK/report.json" claude-haiku-4.5 capped)" "68"
assert_eq "claude-haiku-4.5 raw is 68" "$(row_by_model "$WORK/report.json" claude-haiku-4.5 raw)" "68"

echo "test-report: --format html renders both rows, no external requests"
code=0
"$ISB" --task "$task" --data-dir "$WORK/data" report --format html "$WORK/report.html" \
    > /dev/null 2>"$WORK/report2.err" || code=$?
assert_eq "exit code is 0" "$code" "0"
[ -f "$WORK/report.html" ] && ok "report.html exists" || bad "report.html exists"
grep -qF "claude-sonnet-5" "$WORK/report.html" && ok "html contains claude-sonnet-5" || bad "html contains claude-sonnet-5"
grep -qF "claude-haiku-4.5" "$WORK/report.html" && ok "html contains claude-haiku-4.5" || bad "html contains claude-haiku-4.5"
if grep -qF '<script src' "$WORK/report.html"; then
    bad "html has no <script src"
else
    ok "html has no <script src"
fi
if grep -qF '<link' "$WORK/report.html"; then
    bad "html has no <link"
else
    ok "html has no <link"
fi
if grep -qF '@import' "$WORK/report.html"; then
    bad "html has no @import"
else
    ok "html has no @import"
fi

echo "test-report: --format md and --format csv render without error"
code=0
"$ISB" --task "$task" --data-dir "$WORK/data" report --format md "$WORK/report.md" \
    > /dev/null 2>"$WORK/report3.err" || code=$?
assert_eq "md exit code is 0" "$code" "0"
grep -qF "claude-sonnet-5" "$WORK/report.md" && ok "md contains claude-sonnet-5" || bad "md contains claude-sonnet-5"

code=0
"$ISB" --task "$task" --data-dir "$WORK/data" report --format csv "$WORK/report.csv" \
    > /dev/null 2>"$WORK/report4.err" || code=$?
assert_eq "csv exit code is 0" "$code" "0"
grep -qF "claude-haiku-4.5" "$WORK/report.csv" && ok "csv contains claude-haiku-4.5" || bad "csv contains claude-haiku-4.5"

# ---- --scan over a directory with two separate results files -----------------

echo "test-report: --scan produces an index and two cross-linked group pages"
scandir="$WORK/scandir"
mkdir -p "$scandir/proj-one/results" "$scandir/proj-two/results"
node -e '
    const fs = require("fs");
    const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], JSON.stringify({ runs: [src.runs[0]] }, null, 2));
    fs.writeFileSync(process.argv[3], JSON.stringify({ runs: [src.runs[1]] }, null, 2));
' "$FIXTURES/results-two-rows.json" \
    "$scandir/proj-one/results/results-default.json" \
    "$scandir/proj-two/results/results-guided.json"
code=0
"$ISB" report --scan "$scandir" > "$WORK/scan.out" 2>"$WORK/scan.err" || code=$?
assert_eq "scan exit code is 0" "$code" "0"
[ -f "$scandir/index.html" ] && ok "index.html exists" || bad "index.html exists"
group1="$scandir/proj-one-default.html"
group2="$scandir/proj-two-guided.html"
[ -f "$group1" ] && ok "proj-one-default.html exists" || bad "proj-one-default.html exists"
[ -f "$group2" ] && ok "proj-two-guided.html exists" || bad "proj-two-guided.html exists"
grep -qF 'href="proj-one-default.html"' "$scandir/index.html" && ok "index links to proj-one-default.html" || bad "index links to proj-one-default.html"
grep -qF 'href="proj-two-guided.html"' "$scandir/index.html" && ok "index links to proj-two-guided.html" || bad "index links to proj-two-guided.html"
grep -qF 'href="index.html"' "$group1" && ok "proj-one-default.html links back to index" || bad "proj-one-default.html links back to index"
grep -qF 'href="index.html"' "$group2" && ok "proj-two-guided.html links back to index" || bad "proj-two-guided.html links back to index"

# ---- refusals -----------------------------------------------------------------

echo "test-report: a score_total that disagrees with the scores sum is refused"
task_bad="$WORK/task-bad-sum"
mkdir -p "$task_bad"
cp "$task/task.json" "$task_bad/task.json"
mkdir -p "$WORK/data-bad-sum/results"
node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    d.runs[0].score_total = d.runs[0].score_total + 5;
    fs.writeFileSync(process.argv[2], JSON.stringify(d, null, 2));
' "$FIXTURES/results-two-rows.json" "$WORK/data-bad-sum/results/results-two-rows.json"
code=0
out_before="not-written"
err="$("$ISB" --task "$task_bad" --data-dir "$WORK/data-bad-sum" report --format json "$WORK/refuse1.json" 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is nonzero" "$([ "$code" != "0" ] && echo nonzero || echo zero)" "nonzero"
case "$err" in
    *"scores sum"*"!="*"score_total"*) ok "stderr names the sum mismatch" ;;
    *) bad "stderr names the sum mismatch"; echo "        got: $err" ;;
esac
[ -f "$WORK/refuse1.json" ] && bad "no output file written" || ok "no output file written"

echo "test-report: a reruns row whose score_total does not match the retry-penalty formula is refused"
task_rerun="$WORK/task-rerun"
mkdir -p "$task_rerun"
cat > "$task_rerun/task.json" <<'EOF'
{
  "instance_id": "report-rerun-1",
  "unit": { "field": "libraries_done", "max": 8, "label": "libraries" },
  "variants": {
    "default": { "version": "v1", "results": "results-rerun.json" }
  },
  "defaults": { "variant": "default" }
}
EOF
mkdir -p "$WORK/data-rerun/results"
cat > "$WORK/data-rerun/results/results-rerun.json" <<'EOF'
{
  "runs": [
    {
      "model": "some-model",
      "libraries_done": 4,
      "score_total": 45,
      "scores": { "completion": 45 },
      "reruns": 1,
      "telemetry": {}
    }
  ]
}
EOF
code=0
err="$("$ISB" --task "$task_rerun" --data-dir "$WORK/data-rerun" report --format json "$WORK/refuse2.json" 2>&1 1>/dev/null)" || code=$?
assert_eq "exit code is nonzero" "$([ "$code" != "0" ] && echo nonzero || echo zero)" "nonzero"
case "$err" in
    *"reruns 1 needs score_total"*) ok "stderr names the reruns mismatch" ;;
    *) bad "stderr names the reruns mismatch"; echo "        got: $err" ;;
esac
[ -f "$WORK/refuse2.json" ] && bad "no output file written" || ok "no output file written"

# ---- --all on a task with two variants ----------------------------------------

echo "test-report: --all on a two-variant task produces two cross-linked files"
task_all="$WORK/task-all"
mkdir -p "$task_all"
cat > "$task_all/task.json" <<'EOF'
{
  "instance_id": "report-all-1",
  "unit": { "field": "libraries_done", "max": 8, "label": "libraries" },
  "variants": {
    "default": { "version": "v1", "results": "results-default.json" },
    "guided": { "version": "v1", "results": "results-guided.json" }
  }
}
EOF
mkdir -p "$WORK/data-all/results"
cp "$FIXTURES/results-two-rows.json" "$WORK/data-all/results/results-default.json"
cp "$FIXTURES/results-two-rows.json" "$WORK/data-all/results/results-guided.json"
code=0
"$ISB" --task "$task_all" --data-dir "$WORK/data-all" report --all \
    > "$WORK/all.out" 2>"$WORK/all.err" || code=$?
assert_eq "exit code is 0" "$code" "0"
file_default="$WORK/data-all/reports/report-all-1-default.html"
file_guided="$WORK/data-all/reports/report-all-1-guided.html"
[ -f "$file_default" ] && ok "report-all-1-default.html exists" || bad "report-all-1-default.html exists"
[ -f "$file_guided" ] && ok "report-all-1-guided.html exists" || bad "report-all-1-guided.html exists"
grep -qF 'href="report-all-1-guided.html"' "$file_default" && ok "default page links to guided page" || bad "default page links to guided page"
grep -qF 'href="report-all-1-default.html"' "$file_guided" && ok "guided page links to default page" || bad "guided page links to default page"

# ---- a $&/$` in row text renders literally in html, not as a replace pattern -

echo "test-report: a \$& and \$\` in row text renders literally in html, no leftover {{ token"
task_dollar="$WORK/task-dollar"
mkdir -p "$task_dollar"
cat > "$task_dollar/task.json" <<'EOF'
{
  "instance_id": "report-dollar-1",
  "unit": { "field": "libraries_done", "max": 8, "label": "libraries" },
  "variants": {
    "default": { "version": "v1", "results": "results-dollar.json" }
  },
  "defaults": { "variant": "default" }
}
EOF
mkdir -p "$WORK/data-dollar/results"
cat > "$WORK/data-dollar/results/results-dollar.json" <<'EOF'
{
  "runs": [
    {
      "model": "some-model",
      "libraries_done": 0,
      "score_total": 0,
      "scores": { "completion": 0 },
      "invalid": true,
      "invalid_reason": "judge said $& and $` oops",
      "telemetry": {}
    }
  ]
}
EOF
code=0
"$ISB" --task "$task_dollar" --data-dir "$WORK/data-dollar" report --format html "$WORK/dollar.html" \
    > /dev/null 2>"$WORK/dollar.err" || code=$?
assert_eq "exit code is 0" "$code" "0"
if grep -qF 'judge said $&amp; and $` oops' "$WORK/dollar.html"; then
    ok "the \$& / \$\` text renders literally, unmangled"
else
    bad "the \$& / \$\` text renders literally, unmangled"
fi
if grep -qF '{{' "$WORK/dollar.html"; then
    bad "no unreplaced {{ placeholder token survives"
else
    ok "no unreplaced {{ placeholder token survives"
fi

# ---- rank is per prompt_version group, not global ------------------------------

echo "test-report: rank is computed within each prompt_version group, not globally"
task_groups="$WORK/task-groups"
mkdir -p "$task_groups"
cat > "$task_groups/task.json" <<'EOF'
{
  "instance_id": "report-groups-1",
  "unit": { "field": "libraries_done", "max": 8, "label": "libraries" },
  "variants": {
    "default": { "version": "v1", "results": "results-groups.json" }
  },
  "defaults": { "variant": "default" }
}
EOF
mkdir -p "$WORK/data-groups/results"
cat > "$WORK/data-groups/results/results-groups.json" <<'EOF'
{
  "runs": [
    {
      "model": "model-a",
      "prompt_version": "v2",
      "libraries_done": 8,
      "score_total": 90,
      "scores": { "completion": 90 },
      "telemetry": {}
    },
    {
      "model": "model-b",
      "prompt_version": "v1",
      "libraries_done": 1,
      "score_total": 10,
      "scores": { "completion": 10 },
      "telemetry": {}
    }
  ]
}
EOF
code=0
"$ISB" --task "$task_groups" --data-dir "$WORK/data-groups" report --format json "$WORK/groups.json" \
    > /dev/null 2>"$WORK/groups.err" || code=$?
assert_eq "exit code is 0" "$code" "0"
rank_v1="$(node -e '
    const r = require(process.argv[1]);
    const g = r.tasks[0].rows.find((x) => x.prompt_version === "v1");
    console.log(g ? g.rows[0].rank : "no-group");
' "$WORK/groups.json")"
assert_eq "model-b, alone in the v1 group, is rank 1 in its own group" "$rank_v1" "1"

# ---- no-unit, list-derived score line is not doubled ---------------------------

echo "test-report: no-unit, list-derived score line is 'resolved', not 'resolved · resolved'"
task_lists="$WORK/task-lists"
mkdir -p "$task_lists"
cat > "$task_lists/task.json" <<'EOF'
{
  "instance_id": "report-lists-1",
  "variants": {
    "default": { "version": "v1", "results": "results-lists.json" }
  },
  "defaults": { "variant": "default" }
}
EOF
mkdir -p "$WORK/data-lists/results"
cat > "$WORK/data-lists/results/results-lists.json" <<'EOF'
{
  "runs": [
    {
      "model": "list-model",
      "score_total": 20,
      "scores": { "foo": 20 },
      "resolved": true,
      "resolved_by": "lists",
      "telemetry": {}
    }
  ]
}
EOF
code=0
"$ISB" --task "$task_lists" --data-dir "$WORK/data-lists" report --format json "$WORK/lists.json" \
    > /dev/null 2>"$WORK/lists.err" || code=$?
assert_eq "exit code is 0" "$code" "0"
score_line="$(row_by_model "$WORK/lists.json" list-model score_line)"
assert_eq "score line is 'resolved', not doubled" "$score_line" "resolved"

rm -rf "$WORK"

echo "test-report: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
