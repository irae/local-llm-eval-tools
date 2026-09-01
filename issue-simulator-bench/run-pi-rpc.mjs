#!/usr/bin/env node
// Drives one pi run over `pi --mode rpc` with a fixed, model-agnostic nudge policy.
//
//   node run-pi-rpc.mjs --model <id> --prompt <file> --out <prefix> [--cwd <dir>]
//        [--thinking <level>] [--max-tooling 10] [--max-model 3]
//        [--stall-min 10] [--wall-min 300] [--allow-bad-config]
//
// Why: `pi -p` exits on the first `length`/`error` stop, which is a harness
// limitation, not a model failure. A person in the TUI would type "continue".
// This runner keeps ONE session alive and applies the same policy to every model:
//
//   tooling nudge (never scored) — the stop was caused by the harness or the
//     server: stream error, premature `length` (far below the model's output
//     budget), a stall with no events, an aborted turn, a dead pi process.
//     Message: TOOLING_MSG. Budget --max-tooling.
//   model nudge (scored) — the model stopped on its own (`stop`, or `length`
//     at its real output budget) while work is visibly unfinished: TASKS.md
//     still has `- [ ]` items or the tree has uncommitted changes.
//     Message: MODEL_MSG, always the same text. Budget --max-model.
//
// Neither path reads or interprets the chat. Everything is recorded in
// <out>-meta.json; the raw event stream goes to <out>-events.jsonl, the
// session JSONL (home path redacted) to <out>-session.jsonl, and an HTML
// export to <out>-session.html.

import { spawn, execFileSync } from 'node:child_process';
import {
    readFileSync,
    writeFileSync,
    existsSync,
    appendFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const TOOLING_MSG = 'Continue from where you stopped.';
const MODEL_MSG =
    'You are not done. Check TASKS.md for unchecked items and `git status` for uncommitted work, then continue the workflow from where you stopped.';

// ---- args -----------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--allow-bad-config') args['allow-bad-config'] = true;
    else if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}
const need = (k) => {
    if (!args[k]) {
        console.error(`missing --${k}`);
        process.exit(2);
    }
    return args[k];
};
const model = need('model');
const promptFile = need('prompt');
const out = need('out');
const cwd = resolve(args.cwd || process.cwd());
const thinking = args.thinking || null;
const maxTooling = Number(args['max-tooling'] ?? 10);
const maxModel = Number(args['max-model'] ?? 3);
const stallMs = Number(args['stall-min'] ?? 10) * 60_000;
const wallMs = Number(args['wall-min'] ?? 300) * 60_000;
const prompt = readFileSync(promptFile, 'utf8');

// ---- bookkeeping ----------------------------------------------------------
const home = homedir();
const redact = (s) => (s ? s.split(home).join('~') : s);
const startedAt = new Date();
const meta = {
    model,
    thinking,
    cwd: redact(cwd),
    prompt_file: redact(resolve(promptFile)),
    policy: {
        max_tooling: maxTooling,
        max_model: maxModel,
        stall_min: stallMs / 60_000,
        wall_min: wallMs / 60_000,
        tooling_msg: TOOLING_MSG,
        model_msg: MODEL_MSG,
    },
    start: startedAt.toISOString(),
    end: null,
    end_reason: null,
    nudges: { tooling: [], model: [] },
    respawns: 0,
    compactions: [],
    retries: [],
    warnings: [],
    session_file: null,
    session_id: null,
    stats: null,
    model_info: null,
};
const eventsPath = `${out}-events.jsonl`;
writeFileSync(eventsPath, '');
const logEvent = (e) => appendFileSync(eventsPath, JSON.stringify(e) + '\n');
const say = (m) =>
    console.error(`[run-pi-rpc ${new Date().toISOString()}] ${m}`);
const saveMeta = () =>
    writeFileSync(`${out}-meta.json`, JSON.stringify(meta, null, 2) + '\n');

// ---- pi process -----------------------------------------------------------
let pi = null;
let buf = '';
let nextId = 1;
const pending = new Map();
let settledWaiter = null;
let lastAssistant = null;
let lastEventAt = Date.now();
let exited = false;

function spawnPi(sessionFile) {
    const argv = ['--mode', 'rpc', '--model', model];
    if (thinking) argv.push('--thinking', thinking);
    if (sessionFile) argv.push('--session', sessionFile);
    say(`spawn pi ${argv.join(' ')}`);
    exited = false;
    buf = '';
    pi = spawn('pi', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    pi.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            let line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line.trim()) handleLine(line);
        }
    });
    pi.stderr.on('data', (d) => appendFileSync(`${out}-stderr.log`, d));
    pi.on('exit', (code, sig) => {
        exited = true;
        say(`pi exited code=${code} signal=${sig}`);
        for (const [, p] of pending) p.reject(new Error('pi exited'));
        pending.clear();
        if (settledWaiter) {
            const w = settledWaiter;
            settledWaiter = null;
            w.resolve('exited');
        }
    });
}

function send(cmd) {
    return new Promise((res, rej) => {
        if (exited) return rej(new Error('pi not running'));
        const id = `c${nextId++}`;
        pending.set(id, { resolve: res, reject: rej });
        pi.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
    });
}

function handleLine(line) {
    let e;
    try {
        e = JSON.parse(line);
    } catch {
        return;
    }
    lastEventAt = Date.now();
    if (e.type === 'response') {
        const p = pending.get(e.id);
        if (p) {
            pending.delete(e.id);
            p.resolve(e);
        }
        return;
    }
    logEvent({ t: new Date().toISOString(), ...e });
    if (e.type === 'message_end' && e.message?.role === 'assistant')
        lastAssistant = e.message;
    if (e.type === 'compaction_start')
        meta.compactions.push({
            at: new Date().toISOString(),
            reason: e.reason,
        });
    if (e.type === 'auto_retry_start')
        meta.retries.push({
            at: new Date().toISOString(),
            attempt: e.attempt,
            error: e.errorMessage,
        });
    if (
        e.type === 'extension_ui_request' &&
        ['select', 'confirm', 'input', 'editor'].includes(e.method)
    ) {
        // Headless: dismiss any dialog an extension opens. Recorded, never answered by a person.
        pi.stdin.write(
            JSON.stringify({
                type: 'extension_ui_response',
                id: e.id,
                cancelled: true,
            }) + '\n'
        );
        meta.warnings.push(`extension dialog dismissed: ${e.method}`);
    }
    if (e.type === 'agent_settled' && settledWaiter) {
        const w = settledWaiter;
        settledWaiter = null;
        w.resolve('settled');
    }
}

const waitSettled = () =>
    new Promise((resolve) => (settledWaiter = { resolve }));

async function turn(message) {
    lastAssistant = null;
    const settled = waitSettled();
    const r = await send({ type: 'prompt', message });
    if (!r.success) throw new Error(`prompt rejected: ${r.error}`);
    return settled;
}

// ---- done check (mechanical, no chat reading) -------------------------------
function unfinishedWork() {
    const reasons = [];
    const tasks = resolve(cwd, 'TASKS.md');
    if (existsSync(tasks) && /- \[ \]/.test(readFileSync(tasks, 'utf8')))
        reasons.push('TASKS.md has unchecked items');
    try {
        // untracked files count too: test-first creates files that must be committed
        const st = execFileSync('git', ['status', '--porcelain'], {
            cwd,
            encoding: 'utf8',
        }).trim();
        if (st) reasons.push('uncommitted or untracked changes');
    } catch (e) {
        reasons.push(`git status failed: ${e.message}`);
    }
    return reasons;
}

// ---- classify a settled turn ---------------------------------------------
// returns { kind: 'done' | 'tooling' | 'model', cause }
function classify(settleKind) {
    if (settleKind === 'exited')
        return { kind: 'tooling', cause: 'pi process exited' };
    if (settleKind === 'stall')
        return {
            kind: 'tooling',
            cause: `no events for ${stallMs / 60_000} min, turn aborted`,
        };
    const sr = lastAssistant?.stopReason;
    if (sr === 'error')
        return {
            kind: 'tooling',
            cause: `stream error: ${(lastAssistant.errorMessage || '').slice(0, 200)}`,
        };
    if (sr === 'aborted') return { kind: 'tooling', cause: 'turn aborted' };
    if (sr === 'toolUse')
        return { kind: 'tooling', cause: 'settled with a tool call pending' };
    if (sr === 'length') {
        const outTok = lastAssistant?.usage?.output ?? 0;
        const budget = meta.model_info?.maxTokens ?? 0;
        if (budget && outTok >= 0.8 * budget) {
            const why = unfinishedWork();
            return why.length
                ? {
                      kind: 'model',
                      cause: `output budget hit (${outTok}/${budget}); ${why.join(', ')}`,
                  }
                : {
                      kind: 'done',
                      cause: `output budget hit but nothing left to do`,
                  };
        }
        return {
            kind: 'tooling',
            cause: `premature length stop (${outTok} output tokens, budget ${budget || '?'})`,
        };
    }
    // 'stop' or unknown: the model says it is done
    const why = unfinishedWork();
    return why.length
        ? { kind: 'model', cause: why.join(', ') }
        : { kind: 'done', cause: 'model stopped, work complete' };
}

// ---- main -------------------------------------------------------------------
async function finish(reason) {
    meta.end_reason = reason;
    meta.end = new Date().toISOString();
    try {
        if (!exited) {
            const st = await send({ type: 'get_session_stats' });
            if (st.success)
                meta.stats = {
                    ...st.data,
                    sessionFile: redact(st.data.sessionFile),
                };
            const ex = await send({
                type: 'export_html',
                outputPath: resolve(`${out}-session.html`),
            });
            if (!ex.success)
                meta.warnings.push(`export_html failed: ${ex.error}`);
        }
    } catch (e) {
        meta.warnings.push(`finish: ${e.message}`);
    }
    if (meta._session_path && existsSync(meta._session_path)) {
        const raw = readFileSync(meta._session_path, 'utf8');
        writeFileSync(`${out}-session.jsonl`, redact(raw));
    }
    delete meta._session_path;
    saveMeta();
    say(
        `done: ${reason} — tooling nudges ${meta.nudges.tooling.length}, model nudges ${meta.nudges.model.length}`
    );
    try {
        pi?.stdin.end();
        setTimeout(() => pi?.kill('SIGTERM'), 3000).unref();
    } catch {
        // best effort; the run is ending anyway
    }
}

async function main() {
    spawnPi(null);
    // configuration checks — recorded, never silently ignored
    await send({ type: 'set_auto_compaction', enabled: true });
    await send({ type: 'set_auto_retry', enabled: true });
    const state = await send({ type: 'get_state' });
    if (!state.success) throw new Error('get_state failed');
    meta.session_file = redact(state.data.sessionFile);
    meta._session_path = state.data.sessionFile;
    meta.session_id = state.data.sessionId;
    meta.model_info = state.data.model && {
        id: state.data.model.id,
        provider: state.data.model.provider,
        contextWindow: state.data.model.contextWindow,
        maxTokens: state.data.model.maxTokens,
    };
    if (!state.data.autoCompactionEnabled)
        meta.warnings.push('auto-compaction is OFF after set_auto_compaction');
    if (!meta.model_info?.contextWindow)
        meta.warnings.push(
            'model has no contextWindow — auto-compaction cannot trigger correctly'
        );
    if (!meta.model_info?.maxTokens)
        meta.warnings.push(
            'model has no maxTokens — length stops cannot be classified'
        );
    for (const w of meta.warnings) say(`WARNING: ${w}`);
    saveMeta();
    // A run on a misconfigured model is not comparable. Refuse before the first prompt.
    const fatal = meta.warnings.filter((w) =>
        /contextWindow|maxTokens|auto-compaction/.test(w)
    );
    if (fatal.length && !('allow-bad-config' in args)) {
        say(
            `refusing to start: ${fatal.join('; ')} — fix ~/.pi/agent/models.json (or pass --allow-bad-config to record the run as non-comparable)`
        );
        meta.end_reason = 'bad_config';
        meta.end = new Date().toISOString();
        saveMeta();
        pi.stdin.end();
        process.exit(3);
    }
    if ('allow-bad-config' in args && fatal.length)
        meta.warnings.push(
            'started with --allow-bad-config: this run is not comparable'
        );

    const wallTimer = setTimeout(async () => {
        say('wall clock budget reached, aborting');
        try {
            await send({ type: 'abort' });
        } catch {
            // best effort; the run is ending anyway
        }
        wallHit = true;
    }, wallMs);
    let wallHit = false;

    // stall watchdog
    let stallFlag = false;
    const stallTimer = setInterval(async () => {
        if (settledWaiter && Date.now() - lastEventAt > stallMs && !exited) {
            stallFlag = true;
            say('stall detected, aborting turn');
            try {
                await send({ type: 'abort' });
            } catch {
                // best effort; the run is ending anyway
            }
        }
    }, 15_000);

    let message = prompt;
    for (;;) {
        stallFlag = false;
        let settleKind = await turn(message);
        if (wallHit) {
            await finish('wall_clock');
            break;
        }
        if (settleKind === 'settled' && stallFlag) settleKind = 'stall';
        const c = classify(settleKind);
        say(`turn settled: ${c.kind} — ${c.cause}`);
        if (c.kind === 'done') {
            await finish('complete');
            break;
        }
        // A nudge is recorded only when it is actually sent; the budget check comes first.
        const entry = {
            at: new Date().toISOString(),
            cause: c.cause,
            stop_reason: lastAssistant?.stopReason ?? null,
        };
        if (c.kind === 'tooling') {
            if (meta.nudges.tooling.length >= maxTooling) {
                meta.unsent_nudge = { kind: 'tooling', ...entry };
                await finish('tooling_budget_exhausted');
                break;
            }
            meta.nudges.tooling.push(entry);
            if (settleKind === 'exited') {
                meta.respawns++;
                spawnPi(meta._session_path);
                await send({ type: 'set_auto_compaction', enabled: true });
                await send({ type: 'set_auto_retry', enabled: true });
            }
            message = TOOLING_MSG;
        } else {
            if (meta.nudges.model.length >= maxModel) {
                meta.unsent_nudge = { kind: 'model', ...entry };
                await finish('model_budget_exhausted');
                break;
            }
            meta.nudges.model.push(entry);
            message = MODEL_MSG;
        }
        saveMeta();
    }
    clearTimeout(wallTimer);
    clearInterval(stallTimer);
}

main().catch(async (e) => {
    say(`fatal: ${e.stack || e}`);
    meta.warnings.push(`fatal: ${e.message}`);
    await finish('runner_error');
    process.exit(1);
});
