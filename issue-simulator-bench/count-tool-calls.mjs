#!/usr/bin/env node
// Counts the tool calls and assistant messages of a pi session log, so a
// `telemetry` block in `results.json` or `results-guided.json` can be checked
// against the log it came from.
//
//   node count-tool-calls.mjs [--lines <n>] <session.jsonl> [...]
//
// The rule: a tool call is one `toolCall` block inside an assistant message.
// A call the model issued counts even when no result came back. Tool results,
// user messages, and every non-message record are excluded.
//
// A run split across two sessions is one run: pass both files in order and
// read the TOTAL line. `--lines <n>` reads only the first n lines of each
// file, for a session whose scored part stops before the end of the file
// (`runs/SESSIONS.md` says which run needs this and where it stops).
//
// Validated against the published rows: it reproduces `telemetry.tool_calls`
// and `telemetry.assistant_msgs` for all 17 local rows of the two result
// files, including the two split runs and the one line-limited run.
//
// No dependencies: Node standard library only.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let limit = Infinity;
const files = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lines') limit = Number(args[++i]);
    else files.push(args[i]);
}
if (!files.length || limit <= 0 || Number.isNaN(limit)) {
    console.error(
        'usage: count-tool-calls.mjs [--lines <n>] <session.jsonl> [...]'
    );
    process.exit(2);
}

function count(file) {
    let toolCalls = 0;
    let assistantMsgs = 0;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines.slice(0, limit)) {
        if (!line.trim()) continue;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (record.type !== 'message') continue;
        const message = record.message || {};
        if (message.role !== 'assistant') continue;
        assistantMsgs++;
        for (const block of message.content || [])
            if (block?.type === 'toolCall') toolCalls++;
    }
    return { toolCalls, assistantMsgs };
}

let totalCalls = 0;
let totalMsgs = 0;
for (const file of files) {
    const { toolCalls, assistantMsgs } = count(file);
    totalCalls += toolCalls;
    totalMsgs += assistantMsgs;
    console.log(
        `${file}\ttool_calls ${toolCalls}\tassistant_msgs ${assistantMsgs}`
    );
}
if (files.length > 1)
    console.log(`TOTAL\ttool_calls ${totalCalls}\tassistant_msgs ${totalMsgs}`);
