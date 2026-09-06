#!/usr/bin/env node
// Fallback plan-share estimator, for a plan run whose before/after
// probes are missing or unusable (probe failed, xai's no-endpoint
// case, or run-worker recorded plan_provider=none). A measured probe
// delta ALWAYS wins over this estimate — see PLAN.md "Plan accounting".
//
// Method (owner-approved 2026-09-02): anchor on the same model's most
// recent run that HAS a measured plan share. Scale that share three
// ways — by vendor token cost, by total tokens, by wall-clock minutes.
// The three must agree within TOLERANCE_USD; a spread wider than that
// means the run shape changed too much and the anchor is stale — stop
// and ask the owner (or take a fresh probe pair on the next run).
//
// Usage:
//   node estimate-plan-share.mjs <model> [results.json ...]
// With no results files, reads results.json and results-guided.json.
// Prints the three scalings and the recommended value (vendor-cost
// scaling, the one that prices the long-context tier mix). The scorer
// records it as cost.paid_usd with paid_basis "plan est.", copies the
// anchor's plan block with marginal/wweek recomputed and
// "w5h": "not measured", and writes a config_note naming the anchor.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const TOLERANCE_USD = 0.05;

const dir = dirname(fileURLToPath(import.meta.url));
const [model, ...files] = process.argv.slice(2);
if (!model) {
    console.error('usage: estimate-plan-share.mjs <model> [results.json ...]');
    process.exit(2);
}
if (!files.length) files.push('results.json', 'results-guided.json');

const runs = files.flatMap(
    (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).runs
);
const anchors = runs.filter(
    (r) =>
        r.model === model &&
        r.cost_basis === 'plan' &&
        r.cost.paid_basis === 'plan share' &&
        Number.isFinite(Number(r.cost.paid_usd))
);
if (!anchors.length) {
    console.error(
        `no measured plan-share run for "${model}" — nothing to anchor on. ` +
            'Take a probe pair on the next run, or ask the owner.'
    );
    process.exit(1);
}
const anchor = anchors[anchors.length - 1];
const a = {
    paid: Number(anchor.cost.paid_usd),
    vendor: Number(anchor.cost.vendor_usd),
    tokens: anchor.telemetry.tokens_total,
    wall: anchor.telemetry.wall_clock_min,
};
console.log(
    `anchor: ${model} ${anchor.prompt_version} — paid $${a.paid}, vendor $${a.vendor}, ${a.tokens} tok, ${a.wall} min`
);

const targets = runs.filter(
    (r) =>
        r.model === model && r !== anchor && r.cost.paid_basis !== 'plan share'
);
for (const r of targets) {
    const t = r.telemetry;
    const byVendor = (Number(r.cost.vendor_usd) / a.vendor) * a.paid;
    const byTokens = (t.tokens_total / a.tokens) * a.paid;
    const byWall = (t.wall_clock_min / a.wall) * a.paid;
    const vals = [byVendor, byTokens, byWall];
    const spread = Math.max(...vals) - Math.min(...vals);
    const ok = spread <= TOLERANCE_USD;
    console.log(
        `${r.prompt_version} (${r.cost.paid_basis}): vendor-scaled $${byVendor.toFixed(2)}, ` +
            `token-scaled $${byTokens.toFixed(2)}, time-scaled $${byWall.toFixed(2)} — ` +
            (ok
                ? `RECOMMEND $${byVendor.toFixed(2)} (basis "plan est.")`
                : `spread $${spread.toFixed(2)} > $${TOLERANCE_USD}: anchor stale, ask the owner`)
    );
}
if (!targets.length) console.log('no runs of this model need an estimate.');
