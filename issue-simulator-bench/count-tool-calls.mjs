#!/usr/bin/env node
// Counts the tool calls and assistant messages of a pi session log, and finds
// the peak context, so a `telemetry` block in `results.json` or
// `results-guided.json` can be checked against the log it came from.
//
//   node count-tool-calls.mjs [--lines <n>] <session.jsonl> [...]
//
// The rule for tool calls: a tool call is one `toolCall` block inside an
// assistant message. A call the model issued counts even when no result came
// back. Tool results, user messages, and every non-message record are
// excluded.
//
// The rule for peak context: `peak_context` is the maximum over the assistant
// messages of the scored session(s) of
// `usage.input + usage.cacheRead + usage.cacheWrite + usage.output`, which is
// pi's `usage.totalTokens`. It is the largest context a single turn occupied,
// the response of that turn included, across all compaction cycles. The
// output prints both the maximum of `totalTokens` and the maximum of the sum,
// so a reader can see that the two agree. A file with no usage to read
// prints `-`. The retired claude-code harness writes its log in another
// record shape, which this script does not read, so its rows print `-` and
// keep the value the scorer wrote.
//
// A run split across two sessions is one run: pass both files in order and
// read the TOTAL line, which sums the counts and takes the largest peak.
// `--lines <n>` reads only the first n lines of each file, for a session
// whose scored part stops before the end of the file
// (`runs/SESSIONS.md` says which run needs this and where it stops).
//
// Validated against the published rows on 2026-09-04: it reproduces
// `telemetry.tool_calls`, `telemetry.assistant_msgs` and
// `telemetry.peak_context` for every pi row with a committed log, including
// the two split runs and the one line-limited run. Pass only the scored
// session of a run that has a false start.
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
    let peakTotal = 0;
    let peakSum = 0;
    let sawUsage = false;
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
        const usage = message.usage;
        if (!usage) continue;
        sawUsage = true;
        const sum =
            (usage.input || 0) +
            (usage.cacheRead || 0) +
            (usage.cacheWrite || 0) +
            (usage.output || 0);
        if (sum > peakSum) peakSum = sum;
        if ((usage.totalTokens || 0) > peakTotal) peakTotal = usage.totalTokens;
    }
    return {
        toolCalls,
        assistantMsgs,
        peakTotal: sawUsage ? peakTotal : null,
        peakSum: sawUsage ? peakSum : null,
    };
}

const show = (value) => (value === null ? '-' : value);

let totalCalls = 0;
let totalMsgs = 0;
let topTotal = null;
let topSum = null;
for (const file of files) {
    const { toolCalls, assistantMsgs, peakTotal, peakSum } = count(file);
    totalCalls += toolCalls;
    totalMsgs += assistantMsgs;
    if (peakTotal !== null) topTotal = Math.max(topTotal ?? 0, peakTotal);
    if (peakSum !== null) topSum = Math.max(topSum ?? 0, peakSum);
    console.log(
        `${file}\ttool_calls ${toolCalls}\tassistant_msgs ${assistantMsgs}` +
            `\tpeak_context ${show(peakTotal)}\tpeak_sum ${show(peakSum)}`
    );
}
if (files.length > 1)
    console.log(
        `TOTAL\ttool_calls ${totalCalls}\tassistant_msgs ${totalMsgs}` +
            `\tpeak_context ${show(topTotal)}\tpeak_sum ${show(topSum)}`
    );
