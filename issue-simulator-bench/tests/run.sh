#!/bin/bash
# Runs every test in this folder: the moved fixture-based runner tests,
# the loop-check unit tests, and every tests/test-isb-*.sh script.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

overall=0

echo "== tests/test-run-pi-rpc.sh =="
bash tests/test-run-pi-rpc.sh
[ "$?" = "0" ] || overall=1

echo "== python3 -m unittest tests.test_loop_check =="
python3 -m unittest tests.test_loop_check -v
[ "$?" = "0" ] || overall=1

for t in tests/test-isb-*.sh; do
    [ -f "$t" ] || continue
    echo "== $t =="
    bash "$t"
    [ "$?" = "0" ] || overall=1
done

if [ "$overall" = "0" ]; then
    echo "run.sh: all tests passed"
else
    echo "run.sh: some tests failed"
fi
exit "$overall"
