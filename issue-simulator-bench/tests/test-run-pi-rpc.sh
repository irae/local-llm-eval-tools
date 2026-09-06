#!/bin/bash
# Tests for the Mendel runner's live loop stop
# (../mendel-benchmark/benchmark/run-pi-rpc.mjs), through a fake pi on
# PATH that replays a real event fixture and answers the RPC commands.
# The fixtures are real Mendel logs, trimmed (fixtures/README.md).

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
RUNNER="${MENDEL_RUNNER:-$ROOT/../mendel-benchmark/benchmark/run-pi-rpc.mjs}"
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

if [ ! -f "$RUNNER" ]; then
    echo "  skip run-pi-rpc tests: no runner at $RUNNER (set MENDEL_RUNNER)"
    exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod +x "$HERE/helpers/fake-pi"
mkdir -p "$WORK/bin" "$WORK/repo"
ln -s "$HERE/helpers/fake-pi" "$WORK/bin/pi"
git -C "$WORK/repo" init -q
echo "task" > "$WORK/prompt.txt"

run_fixture() {
    FAKE_PI_EVENTS="$FIXTURES/$1" PATH="$WORK/bin:$PATH" \
        timeout 60 node "$RUNNER" --model fake --prompt "$WORK/prompt.txt" \
        --out "$WORK/out-$2" --cwd "$WORK/repo" --allow-bad-config \
        > "$WORK/out-$2.log" 2>&1
}

meta_field() {
    node -e "const m=require(process.argv[1]); console.log(process.argv[2].split('.').reduce((o,k)=>o==null?'':o[k],m) ?? '')" "$WORK/out-$1-meta.json" "$2"
}

echo "test-run-pi-rpc: the same tool call five times in a row ends the run"
run_fixture events-loop-calls.jsonl calls
assert_eq "end reason" "$(meta_field calls end_reason)" "repetition_loop"
assert_eq "kind" "$(meta_field calls repetition_loop.kind)" "tool call"
assert_eq "count" "$(meta_field calls repetition_loop.count)" "5"
case "$(meta_field calls repetition_loop.unit)" in
    *".taprc"*) ok "unit names the repeated command" ;;
    *) bad "unit names the repeated command"; echo "        got: $(meta_field calls repetition_loop.unit)" ;;
esac

echo "test-run-pi-rpc: a short text cycle inside one message ends the run"
run_fixture events-text-cycle.jsonl cycle
assert_eq "end reason" "$(meta_field cycle end_reason)" "repetition_loop"
assert_eq "kind" "$(meta_field cycle repetition_loop.kind)" "text cycle"

echo "test-run-pi-rpc: a one-character flood ends the run before the message ends"
run_fixture events-flood.jsonl flood
assert_eq "end reason" "$(meta_field flood end_reason)" "degenerate_output"
assert_eq "char" "$(meta_field flood degenerate_output.char)" "whitespace"

echo "test-run-pi-rpc: a healthy run with distinct calls completes"
run_fixture events-healthy.jsonl healthy
assert_eq "end reason" "$(meta_field healthy end_reason)" "complete"
assert_eq "no loop record" "$(meta_field healthy repetition_loop)" ""

echo "test-run-pi-rpc: a healthy run that repeats a call with work between completes"
run_fixture events-healthy-repeats.jsonl repeats
assert_eq "end reason" "$(meta_field repeats end_reason)" "complete"
assert_eq "no loop record" "$(meta_field repeats repetition_loop)" ""
assert_eq "no flood record" "$(meta_field repeats degenerate_output)" ""

echo "test-run-pi-rpc: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
