#!/bin/bash
# Tests for the four isb sub-commands that only forward to a script:
# loop-check, count, and estimate-plan (its default results-directory
# behavior and its clean failure with no data directory).

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
ISB="$ROOT/isb"
FIXTURE="$HERE/fixtures/session-healthy.jsonl"
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

echo "test-isb-wiring: isb loop-check matches loop-check.py run directly"
direct_out="$(python3 "$ROOT/loop-check.py" "$FIXTURE")"
direct_code=$?
isb_out="$("$ISB" loop-check "$FIXTURE")"
isb_code=$?
assert_eq "isb loop-check output matches direct run" "$isb_out" "$direct_out"
assert_eq "isb loop-check exit code matches direct run" "$isb_code" "$direct_code"

echo "test-isb-wiring: isb count matches count-tool-calls.mjs run directly"
direct_out="$(node "$ROOT/count-tool-calls.mjs" "$FIXTURE")"
direct_code=$?
isb_out="$("$ISB" count "$FIXTURE")"
isb_code=$?
assert_eq "isb count output matches direct run" "$isb_out" "$direct_out"
assert_eq "isb count exit code matches direct run" "$isb_code" "$direct_code"

echo "test-isb-wiring: isb estimate-plan with no ISB_DATA_DIR fails cleanly, names the missing directory"
code=0
err="$(env -u ISB_DATA_DIR "$ISB" estimate-plan some-model 2>&1 1>/dev/null)" || code=$?
if [ "$code" != "0" ]; then ok "exit code is nonzero"; else bad "exit code is nonzero"; fi
case "$err" in
    *"no results files found under"*"results"*) ok "stderr names the missing results directory" ;;
    *) bad "stderr names the missing results directory"; echo "        got: $err" ;;
esac

echo "test-isb-wiring: isb estimate-plan reads every json file under \$ISB_DATA_DIR/results without explicit paths"
data_dir="$WORK/data-dir"
mkdir -p "$data_dir/results"
node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
        runs: [{ model: "unrelated-model" }]
    }, null, 2));
' "$data_dir/results/a.json"
node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
        runs: [{
            model: "target-model",
            cost_basis: "plan",
            cost: { paid_basis: "plan share", paid_usd: "0.38", vendor_usd: "5.73" },
            telemetry: { tokens_total: 1000, wall_clock_min: 10 },
            prompt_version: "v1"
        }]
    }, null, 2));
' "$data_dir/results/b.json"
code=0
out="$("$ISB" --data-dir "$data_dir" estimate-plan target-model)" || code=$?
assert_eq "exit code is 0" "$code" "0"
case "$out" in
    *"anchor: target-model"*) ok "the anchor from b.json was found (both files were read, not just the first)" ;;
    *) bad "the anchor from b.json was found (both files were read, not just the first)"; echo "        got: $out" ;;
esac

rm -rf "$WORK"

echo "test-isb-wiring: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
