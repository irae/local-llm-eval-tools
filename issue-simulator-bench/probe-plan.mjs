#!/usr/bin/env node
// Reads how much of a subscription plan's rate-limit windows is used right now.
//
//   node probe-plan.mjs <provider> [--out <file>]
//     provider: anthropic | openai-codex | xai | none
//
// run-worker.sh calls this before and after every run that spends a plan, so the
// run's share of the plan is (after − before) per window — no guessing from token
// counts. Output is one JSON object; secrets never leave the process.
//
//   anthropic    GET https://api.anthropic.com/api/oauth/usage with the Claude Code
//                OAuth token (~/.claude/.credentials.json). Fields: five_hour,
//                seven_day utilization. This is the plan Claude Code runs draw on.
//                (pi's own Anthropic login bills "extra usage" per token instead,
//                so pi+anthropic runs are metered, not plan.)
//   openai-codex GET https://chatgpt.com/backend-api/wham/usage with pi's Codex
//                OAuth token (`pi auth print-bearer-token`). Fields: plan_type,
//                rate_limit.primary_window (5 h) and secondary_window (7 d)
//                used_percent, reset_at.
//   xai          No usage endpoint accepts the OAuth token (grok.com rejects it,
//                api.x.ai has none). Recorded as unsupported; Grok plan runs keep
//                the "not exposed" label and the metered/OpenRouter figure.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const provider = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
if (!provider) {
    console.error(
        'usage: probe-plan.mjs <anthropic|openai-codex|xai|none> [--out file]'
    );
    process.exit(2);
}

const result = {
    provider,
    at: new Date().toISOString(),
    supported: false,
    plan_type: null,
    windows: [], // { name, seconds, used_percent, reset_at }
    error: null,
};

async function getJson(url, headers) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    try {
        const r = await fetch(url, { headers, signal: ac.signal });
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text);
    } finally {
        clearTimeout(t);
    }
}

async function anthropic() {
    const p = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(p))
        throw new Error(
            `no Claude Code credentials at ~/.claude/.credentials.json`
        );
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const c = raw.claudeAiOauth || raw;
    if (!c.accessToken) throw new Error('credentials file has no accessToken');
    const d = await getJson('https://api.anthropic.com/api/oauth/usage', {
        Authorization: `Bearer ${c.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
    });
    result.supported = true;
    result.plan_type = c.subscriptionType || null;
    const win = (name, seconds, o) =>
        o &&
        result.windows.push({
            name,
            seconds,
            used_percent: o.utilization ?? o.used_percent ?? null,
            reset_at: o.resets_at ?? o.reset_at ?? null,
        });
    win('five_hour', 18000, d.five_hour);
    win('seven_day', 604800, d.seven_day);
    for (const [k, v] of Object.entries(d))
        if (
            !['five_hour', 'seven_day'].includes(k) &&
            v &&
            typeof v === 'object' &&
            'utilization' in v
        )
            win(k, null, v);
    result.raw_keys = Object.keys(d);
}

async function openaiCodex() {
    const token = execFileSync(
        'pi',
        ['auth', 'print-bearer-token', '--provider', 'openai-codex'],
        {
            encoding: 'utf8',
        }
    ).trim();
    const payload = token.split('.')[1];
    const claims = JSON.parse(
        Buffer.from(
            payload.replace(/-/g, '+').replace(/_/g, '/'),
            'base64'
        ).toString()
    );
    const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    const d = await getJson('https://chatgpt.com/backend-api/wham/usage', {
        Authorization: `Bearer ${token}`,
        ...(account ? { 'ChatGPT-Account-Id': account } : {}),
        'User-Agent': 'mendel-benchmark-probe',
    });
    result.supported = true;
    result.plan_type = d.plan_type ?? null;
    const rl = d.rate_limit || {};
    const win = (name, o) =>
        o &&
        result.windows.push({
            name,
            seconds: o.limit_window_seconds ?? null,
            used_percent: o.used_percent ?? null,
            reset_at: o.reset_at
                ? new Date(o.reset_at * 1000).toISOString()
                : null,
        });
    win('primary', rl.primary_window);
    win('secondary', rl.secondary_window);
    result.credits = d.credits
        ? { has_credits: d.credits.has_credits, balance: d.credits.balance }
        : null;
}

async function main() {
    try {
        if (provider === 'anthropic') await anthropic();
        else if (provider === 'openai-codex') await openaiCodex();
        else if (provider === 'xai')
            result.error =
                'no usage endpoint accepts the xAI OAuth token; plan share not measurable';
        else if (provider === 'none') result.error = 'no plan involved';
        else throw new Error(`unknown provider ${provider}`);
    } catch (e) {
        result.error = e.message;
    }
    const text = JSON.stringify(result, null, 2) + '\n';
    if (outFile) writeFileSync(outFile, text);
    process.stdout.write(text);
    if (result.error && provider !== 'xai' && provider !== 'none')
        process.exit(1);
}

main();
