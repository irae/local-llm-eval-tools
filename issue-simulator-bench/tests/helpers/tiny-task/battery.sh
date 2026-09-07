#!/bin/bash
set -u

args_json=""
for arg in "$@"; do
    escaped=$(printf '%s' "$arg" | sed 's/\\/\\\\/g; s/"/\\"/g')
    if [ -z "$args_json" ]; then
        args_json="\"$escaped\""
    else
        args_json="$args_json,\"$escaped\""
    fi
done

printf '{"tiny_battery": {"args": [%s]}, "resolved": true, "files_done": 2, "scores": {"completion": 10, "lint": 5}, "tests": {"t_fix": true, "t_keep": true}}\n' "$args_json"
