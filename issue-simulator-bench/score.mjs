#!/usr/bin/env node
// Scores one run: a generic evidence pack, the task's battery, an objective
// results row, and an optional judge merge.
//
//   node score.mjs <fslug> [--worktree <dir>] [--judge <verdict.json>]
//   node score.mjs --judge-pack <fslug>
//
// <fslug> is the run's file slug (`<slug>-<variant>`), the same prefix
// run-worker.sh uses for runs/<fslug>-*. ISB_TASK_DIR and ISB_DATA_DIR come
// from the environment; isb sets them before this script starts.

import { execFileSync } from 'node:child_process';
import {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ---- args -------------------------------------------------------------------
// Every argv token is either --judge-pack, a recognized flag with its value,
// or the one positional <fslug>. Anything else is its own error, exit 2.
let judgePack = false;
let worktreeArg = null;
let judgeFile = null;
const positional = [];
{
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--judge-pack') {
            judgePack = true;
            continue;
        }
        if (a === '--worktree' || a === '--judge') {
            if (i + 1 >= argv.length) {
                console.error(`error: ${a} requires a value`);
                process.exit(2);
            }
            if (a === '--worktree') worktreeArg = argv[++i];
            else judgeFile = argv[++i];
            continue;
        }
        if (a.startsWith('--') || positional.length >= 1) {
            console.error(`error: unknown argument ${a}`);
            process.exit(2);
        }
        positional.push(a);
    }
}
const fslug = positional[0];
if (!fslug) {
    console.error(
        'usage: score.mjs <fslug> [--worktree <dir>] [--judge <verdict.json>]\n' +
            '       score.mjs --judge-pack <fslug>'
    );
    process.exit(2);
}

const taskDir = process.env.ISB_TASK_DIR;
const dataDir = process.env.ISB_DATA_DIR;
if (!taskDir || !dataDir) {
    console.error('error: ISB_TASK_DIR and ISB_DATA_DIR must be set (run through isb)');
    process.exit(2);
}

const runsDir = join(dataDir, 'runs');
const metaPath = join(runsDir, `${fslug}-meta.json`);
const workerPath = join(runsDir, `${fslug}-worker.json`);
const sessionPath = join(runsDir, `${fslug}-session.jsonl`);

function requireJson(path, kind) {
    if (!existsSync(path)) {
        console.error(`error: no ${kind} for ${fslug} at ${path}`);
        process.exit(2);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
}

const meta = requireJson(metaPath, 'meta file');
const worker = requireJson(workerPath, 'worker file');

const taskJsonPath = join(taskDir, 'task.json');
if (!existsSync(taskJsonPath)) {
    console.error(`error: no task.json at ${taskJsonPath}`);
    process.exit(2);
}
const task = JSON.parse(readFileSync(taskJsonPath, 'utf8'));

// ---- task-dir cross-check, noted, never fatal --------------------------------
let taskMismatch = null;
if (worker.task && resolve(worker.task) !== resolve(taskDir)) {
    taskMismatch = { worker_task: worker.task, isb_task_dir: taskDir };
}

// ---- variant lookup, by branch_suffix ----------------------------------------
function matchVariant(branch) {
    const variants = task.variants || {};
    for (const [name, v] of Object.entries(variants)) {
        if (v.branch_suffix && branch.endsWith(v.branch_suffix))
            return { name, ...v };
    }
    return null;
}
const variant = matchVariant(worker.branch);

// ---- the checkout, or the artifact pack as a fallback ------------------------
const checkoutDir = worktreeArg || worker.checkout;
const artifactsDir = worker.artifacts;
const checkoutExists = Boolean(checkoutDir) && existsSync(checkoutDir);
const sourceRoot = checkoutExists ? checkoutDir : artifactsDir;

// ---- session log, one pass ----------------------------------------------------
function extractBashCommand(block) {
    if (
        block?.type === 'toolCall' &&
        block.name === 'bash' &&
        typeof block.arguments?.command === 'string'
    )
        return block.arguments.command;
    if (
        block?.type === 'tool_use' &&
        block.name === 'Bash' &&
        typeof block.input?.command === 'string'
    )
        return block.input.command;
    return null;
}

function analyzeSession(path) {
    const bashCommands = [];
    let toolCalls = 0;
    let assistantMsgs = 0;
    let tokensIn = 0,
        tokensOut = 0,
        cacheRead = 0,
        cacheWrite = 0,
        tokensTotal = 0,
        peakContext = 0,
        toolErrors = 0;
    let sawUsage = false;
    const pendingCommits = new Map();
    const failedCommits = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec.type !== 'message') continue;
        const msg = rec.message || {};
        if (msg.role === 'assistant') {
            assistantMsgs++;
            for (const b of msg.content || []) {
                if (b?.type === 'toolCall' || b?.type === 'tool_use') toolCalls++;
                const cmd = extractBashCommand(b);
                if (cmd !== null) {
                    bashCommands.push(cmd);
                    if (b.id && /git commit/.test(cmd)) pendingCommits.set(b.id, cmd);
                }
            }
            const usage = msg.usage;
            if (usage) {
                sawUsage = true;
                tokensIn += usage.input || 0;
                tokensOut += usage.output || 0;
                cacheRead += usage.cacheRead || 0;
                cacheWrite += usage.cacheWrite || 0;
                const total =
                    usage.totalTokens ??
                    (usage.input || 0) +
                        (usage.cacheRead || 0) +
                        (usage.cacheWrite || 0) +
                        (usage.output || 0);
                tokensTotal += total;
                if (total > peakContext) peakContext = total;
            }
        } else if (msg.role === 'toolResult') {
            const text = (msg.content || [])
                .filter((c) => c?.type === 'text')
                .map((c) => c.text || '')
                .join('\n');
            if (/error|failed|exception/i.test(text)) toolErrors++;
            const id = msg.toolCallId;
            if (id && pendingCommits.has(id)) {
                if (/error|fatal|nothing to commit|not a git repository/i.test(text))
                    failedCommits.push({
                        command: pendingCommits.get(id),
                        result: text.slice(0, 300),
                    });
                pendingCommits.delete(id);
            }
        }
    }
    return {
        bashCommands,
        toolCalls,
        assistantMsgs,
        tokensIn,
        tokensOut,
        cacheRead,
        cacheWrite,
        tokensTotal,
        peakContext: sawUsage ? peakContext : null,
        toolErrors,
        failedCommits,
    };
}

const sessionExists = existsSync(sessionPath);
const session = sessionExists ? analyzeSession(sessionPath) : null;

// ---- session habits (generic) -------------------------------------------------
function sessionHabits(bashCommands) {
    const n = bashCommands.length;
    const commitCmds = bashCommands.filter((c) => /git commit/.test(c)).length;
    const noVerify = bashCommands.filter((c) => c.includes('--no-verify'));
    const gitAddAll = bashCommands.filter((c) =>
        /git add (-A|--all|\.)(\s|$)/.test(c)
    );
    const truncated = bashCommands.filter((c) =>
        /\|\s*(tail|head)\b|>\s*\S+\.(log|txt)/.test(c)
    );
    return {
        bash_commands: n,
        commit_cmds: commitCmds,
        no_verify: noVerify,
        git_add_all: gitAddAll,
        truncated_commands: truncated,
        truncation_pct: n ? Math.round((100 * truncated.length) / n) : null,
    };
}
const habits = session
    ? sessionHabits(session.bashCommands)
    : { bash_commands: 0, commit_cmds: 0, no_verify: [], git_add_all: [], truncated_commands: [], truncation_pct: null };

// ---- commit craft, checkout or artifact pack -----------------------------------
const gitIn = (cwd, ...a) => {
    try {
        return execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64e6 });
    } catch {
        return null;
    }
};

function parsePatchFile(text) {
    const hashMatch = text.match(/^From ([0-9a-f]{7,40})/m);
    const subjectMatch = text.match(/^Subject:\s*\[PATCH[^\]]*\]\s*(.*)$/m);
    const files = new Set();
    const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
    let m;
    while ((m = re.exec(text))) files.add(m[2]);
    return {
        hash: hashMatch ? hashMatch[1].slice(0, 7) : null,
        subject: subjectMatch ? subjectMatch[1].trim() : null,
        files: [...files],
    };
}

function commitCraft() {
    const base = worker.base_commit;
    if (checkoutExists) {
        const log = gitIn(checkoutDir, 'log', '--format=%H%x09%s', `${base}..HEAD`) || '';
        const commits = log
            .split('\n')
            .filter(Boolean)
            .map((l) => {
                const [hash, subject] = l.split('\t');
                return { hash, subject };
            })
            .reverse();
        const perCommit = commits.map((c) => {
            const filesRaw = gitIn(checkoutDir, 'show', '--name-only', '--format=', c.hash) || '';
            return {
                hash: c.hash.slice(0, 7),
                subject: c.subject,
                files: filesRaw.split('\n').filter(Boolean),
            };
        });
        return { source: 'checkout', commits: perCommit.length, per_commit: perCommit };
    }
    let perCommit = [];
    if (artifactsDir) {
        const patchesDir = join(artifactsDir, 'patches');
        if (existsSync(patchesDir)) {
            const files = readdirSync(patchesDir)
                .filter((f) => f.endsWith('.patch'))
                .sort();
            perCommit = files.map((f) =>
                parsePatchFile(readFileSync(join(patchesDir, f), 'utf8'))
            );
        } else {
            const logTxt = join(artifactsDir, 'log.txt');
            if (existsSync(logTxt))
                perCommit = readFileSync(logTxt, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .map((l) => {
                        const sp = l.indexOf(' ');
                        return { hash: l.slice(0, sp), subject: l.slice(sp + 1), files: [] };
                    });
        }
    }
    return { source: 'artifact pack', commits: perCommit.length, per_commit: perCommit };
}
const craft = commitCraft();
craft.failed_commits = session ? session.failedCommits : [];

// ---- runner (from meta) --------------------------------------------------------
const runner = {
    end_reason: meta.end_reason,
    nudges_tooling: meta.nudges?.tooling?.length ?? null,
    nudges_model: meta.nudges?.model?.length ?? null,
    model_nudge_causes: (meta.nudges?.model || []).map((n) => n.cause),
    baseline_dirty: meta.baseline_dirty,
    warnings: meta.warnings,
    thinking_level: meta.thinking_level,
    harness_window: meta.harness_window,
};

// ---- telemetry -------------------------------------------------------------------
function wallClockMinutes(start, end) {
    if (!start || !end) return null;
    const ms = new Date(end) - new Date(start);
    if (Number.isNaN(ms)) return null;
    return Math.round((ms / 60_000) * 10) / 10;
}
const wallClockMin = wallClockMinutes(worker.start, worker.end);
const telemetry = session
    ? {
          tool_calls: session.toolCalls,
          assistant_msgs: session.assistantMsgs,
          peak_context: session.peakContext,
          tokens_in: session.tokensIn,
          tokens_out: session.tokensOut,
          cache_read: session.cacheRead,
          cache_write: session.cacheWrite,
          tokens_total: session.tokensTotal,
          compactions: meta.compactions?.length ?? 0,
          wall_clock_min: wallClockMin,
          loop_flag: worker.loop_flag ?? null,
          loop_ratio: worker.loop_ratio ?? null,
          loop_kind: worker.loop_kind ?? null,
          tool_errors: session.toolErrors,
          truncation_pct: habits.truncation_pct,
          nudges_tooling: meta.nudges?.tooling?.length ?? null,
          nudges_model: meta.nudges?.model?.length ?? null,
      }
    : {
          tool_calls: null,
          assistant_msgs: null,
          peak_context: null,
          tokens_in: null,
          tokens_out: null,
          cache_read: null,
          cache_write: null,
          tokens_total: null,
          compactions: meta.compactions?.length ?? 0,
          wall_clock_min: wallClockMin,
          loop_flag: worker.loop_flag ?? null,
          loop_ratio: worker.loop_ratio ?? null,
          loop_kind: worker.loop_kind ?? null,
          tool_errors: null,
          truncation_pct: null,
          nudges_tooling: meta.nudges?.tooling?.length ?? null,
          nudges_model: meta.nudges?.model?.length ?? null,
      };

// ---- the task battery -------------------------------------------------------------
function runBattery() {
    const cmd = task.battery;
    if (!cmd) return { result: null, error: 'no battery in task.json' };
    const [prog, ...cmdArgs] = cmd.split(' ');
    try {
        const out = execFileSync(
            prog,
            [...cmdArgs, sourceRoot || '', worker.branch, worker.base_commit],
            { cwd: taskDir, encoding: 'utf8', maxBuffer: 64e6 }
        );
        return { result: JSON.parse(out), error: null };
    } catch (e) {
        return { result: null, error: e.message.split('\n')[0] };
    }
}
const battery = runBattery();

// ---- the evidence pack -------------------------------------------------------------
const evidence = {
    branch: worker.branch,
    base: worker.base_commit,
    generated: new Date().toISOString(),
    commit_craft: craft,
    session_habits: habits,
    runner,
    telemetry,
};
if (taskMismatch) evidence.task_mismatch = taskMismatch;
if (battery.error) evidence.battery_error = battery.error;
else Object.assign(evidence, battery.result);

// ---- resolved: from FAIL_TO_PASS/PASS_TO_PASS when the task has them, else
// the battery's own key -------------------------------------------------------
function deriveResolved(batteryResult) {
    const failToPass = task.FAIL_TO_PASS || [];
    const passToPass = task.PASS_TO_PASS || [];
    if (!failToPass.length && !passToPass.length)
        return { resolved: Boolean(batteryResult.resolved), resolved_by: 'battery' };
    const allIds = [...failToPass, ...passToPass];
    const tests = batteryResult.tests;
    const computed = allIds.every((id) => tests?.[id] === true);
    if (!tests) {
        console.error(
            `warning: battery reported no 'tests' key for ${fslug} while FAIL_TO_PASS/PASS_TO_PASS are set; treating resolved as false`
        );
    } else if (
        Object.prototype.hasOwnProperty.call(batteryResult, 'resolved') &&
        Boolean(batteryResult.resolved) !== computed
    ) {
        console.error(
            `warning: battery's own resolved (${batteryResult.resolved}) disagrees with the list-derived resolved (${computed}) for ${fslug}; using the list-derived value`
        );
    }
    return { resolved: computed, resolved_by: 'lists' };
}

// ---- the objective row --------------------------------------------------------------
function buildRow() {
    const row = {
        model: worker.model,
        model_id: worker.model,
        harness: worker.harness,
        harness_guessed: false,
        provider: null,
        local: null,
        serving: null,
        branch: worker.branch,
        base_commit: worker.base_commit,
        thinking: worker.thinking,
        prompt_version: variant ? variant.version : null,
        partial: meta.end_reason !== 'complete',
        end_reason: meta.end_reason,
        tool_version: worker.tool_version,
        defects: [],
        telemetry,
        cost_usd: null,
        cost_basis: 'local',
        scored_by: 'battery',
    };
    if (battery.result) {
        const scores = battery.result.scores || {};
        row.scores = scores;
        row.score_total = Object.values(scores).reduce(
            (a, b) => a + (Number(b) || 0),
            0
        );
        const { resolved, resolved_by } = deriveResolved(battery.result);
        row.resolved = resolved;
        row.resolved_by = resolved_by;
        const unitField = task.unit?.field || 'resolved';
        row[unitField] = task.unit ? battery.result[task.unit.field] ?? null : row.resolved;
    }
    return row;
}

// ---- results file: read, replace-by-branch, write, regenerate the CSV -----------
function loadResults(path) {
    if (!existsSync(path)) return { runs: [] };
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        console.error(`error: cannot parse results file ${path}: ${e.message}`);
        process.exit(2);
    }
    if (!parsed || !Array.isArray(parsed.runs)) return { runs: [] };
    return parsed;
}
function saveRow(row) {
    const resultsDir = join(dataDir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    const resultsPath = join(resultsDir, variant.results);
    const store = loadResults(resultsPath);
    const idx = store.runs.findIndex((r) => r.branch === row.branch);
    if (idx >= 0) store.runs[idx] = row;
    else store.runs.push(row);
    writeFileSync(resultsPath, JSON.stringify(store, null, 2) + '\n');
    writeFileSync(resultsPath.replace(/\.json$/, '.csv'), toCsv(store.runs));
    return resultsPath;
}

const FIXED_PRE = [
    'model',
    'model_id',
    'harness',
    'harness_guessed',
    'provider',
    'local',
    'serving',
    'branch',
    'base_commit',
    'thinking',
    'prompt_version',
    'partial',
    'end_reason',
];
const FIXED_POST = ['score_total', 'resolved', 'scored_by', 'cost_usd', 'cost_basis'];

function buildColumns(runs) {
    const unitKeys = new Set();
    const scoreKeys = new Set();
    const telemetryKeys = new Set();
    let hasDefects = false;
    let hasNotes = false;
    for (const r of runs) {
        for (const k of Object.keys(r)) {
            if (FIXED_PRE.includes(k) || FIXED_POST.includes(k) || k === 'scores' || k === 'telemetry')
                continue;
            if (k === 'defects') {
                hasDefects = true;
                continue;
            }
            if (k === 'notes') {
                hasNotes = true;
                continue;
            }
            unitKeys.add(k);
        }
        Object.keys(r.scores || {}).forEach((k) => scoreKeys.add(k));
        Object.keys(r.telemetry || {}).forEach((k) => telemetryKeys.add(k));
    }
    const cols = [...FIXED_PRE, ...[...unitKeys].sort(), ...FIXED_POST];
    if (hasDefects) cols.push('defects');
    if (hasNotes) cols.push('notes');
    cols.push(...[...scoreKeys].sort().map((k) => `scores.${k}`));
    cols.push(...[...telemetryKeys].sort().map((k) => `telemetry.${k}`));
    return cols;
}
function csvCell(v) {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(runs) {
    const cols = buildColumns(runs);
    const lines = [cols.join(',')];
    for (const r of runs) {
        lines.push(
            cols
                .map((c) => {
                    if (c.startsWith('scores.')) return csvCell(r.scores?.[c.slice(7)]);
                    if (c.startsWith('telemetry.')) return csvCell(r.telemetry?.[c.slice(10)]);
                    return csvCell(r[c]);
                })
                .join(',')
        );
    }
    return lines.join('\n') + '\n';
}

// ---- the judge-pack mode ------------------------------------------------------------
function writeJudgePack() {
    const rubricRel = variant?.rubric || task.rubric;
    const rubricPath = rubricRel ? resolve(taskDir, rubricRel) : null;
    const rubricText =
        rubricPath && existsSync(rubricPath)
            ? readFileSync(rubricPath, 'utf8')
            : '(no rubric configured for this task/variant)';
    const logPath = artifactsDir ? join(artifactsDir, 'log.txt') : null;
    const logText = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf8') : null;
    const parts = [
        '# Rubric',
        '',
        rubricText.trim(),
        '',
        '# Evidence',
        '',
        '```json',
        JSON.stringify(evidence, null, 2),
        '```',
    ];
    if (logText !== null) {
        parts.push('', '# Artifact log', '', '```text', logText.trim(), '```');
    }
    parts.push(
        '',
        '# Session',
        '',
        `Session file: ${sessionPath}`,
        '',
        '# Your answer',
        '',
        'Answer as a `verdict.json` file with exactly these keys: `judge` (your model name), ' +
            '`scores` (an object of judged-criteria scores, none of them named the same as a battery-produced ' +
            'score already in the evidence above), `defects` (an array), and `notes` with four string fields: ' +
            '`summary`, `what_decided_it`, `defects`, `anomalies`.'
    );
    const evidenceDir = join(dataDir, 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    const out = join(evidenceDir, `${fslug}-judge-pack.md`);
    writeFileSync(out, parts.join('\n') + '\n');
    return out;
}

if (judgePack) {
    const out = writeJudgePack();
    console.log(out);
    process.exit(0);
}

// ---- plain score, with an optional judge merge ---------------------------------
const row = buildRow();

// The variant must resolve before anything is written: a results file name
// cannot be chosen without it, and a refusal here writes nothing at all.
if (!variant) {
    console.error(`error: no variant of ${taskDir} matches branch ${worker.branch}`);
    process.exit(2);
}

function validateVerdict(v) {
    if (typeof v.judge !== 'string' || v.judge.trim() === '') {
        console.error(
            "error: judge verdict must have a non-empty 'judge' field naming the judge"
        );
        process.exit(2);
    }
    if (v.defects !== undefined && !Array.isArray(v.defects)) {
        console.error(
            `error: judge verdict 'defects' must be an array, got ${typeof v.defects}`
        );
        process.exit(2);
    }
    if (
        v.notes !== undefined &&
        (typeof v.notes !== 'object' || v.notes === null || Array.isArray(v.notes))
    ) {
        console.error(
            `error: judge verdict 'notes' must be an object, got ${typeof v.notes}`
        );
        process.exit(2);
    }
    for (const [k, val] of Object.entries(v.scores || {})) {
        if (typeof val !== 'number' || !Number.isFinite(val)) {
            console.error(
                `error: judge verdict score '${k}' is not a number: ${JSON.stringify(val)}`
            );
            process.exit(2);
        }
    }
}

if (judgeFile) {
    if (!existsSync(judgeFile)) {
        console.error(`error: no verdict file at ${judgeFile}`);
        process.exit(2);
    }
    let verdict;
    try {
        verdict = JSON.parse(readFileSync(judgeFile, 'utf8'));
    } catch (e) {
        console.error(`error: cannot parse judge file ${judgeFile}: ${e.message}`);
        process.exit(2);
    }
    validateVerdict(verdict);
    const existingScores = row.scores || {};
    const clash = Object.keys(verdict.scores || {}).find((k) => k in existingScores);
    if (clash) {
        console.error(
            `error: judge verdict criterion '${clash}' clashes with a battery-computed score`
        );
        process.exit(2);
    }
    row.scores = { ...existingScores, ...(verdict.scores || {}) };
    row.score_total = Object.values(row.scores).reduce(
        (a, b) => a + (Number(b) || 0),
        0
    );
    row.defects = verdict.defects || [];
    row.notes = verdict.notes || {};
    row.scored_by = `judge:${verdict.judge}`;
}

const evidenceDir = join(dataDir, 'evidence');
mkdirSync(evidenceDir, { recursive: true });
const evidencePath = join(evidenceDir, `${fslug}-evidence.json`);
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');

saveRow(row);

const unitFieldName = task.unit?.field || 'resolved';
console.log(
    [
        `evidence: ${evidencePath}`,
        `resolved: ${row.resolved ?? 'unknown'}`,
        `${unitFieldName}: ${row[unitFieldName] ?? 'unknown'}`,
        `score_total: ${row.score_total ?? 'unknown'}`,
    ].join('\n')
);
