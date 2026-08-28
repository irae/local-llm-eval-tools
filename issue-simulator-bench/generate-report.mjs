#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
const template = readFileSync(join(dir, 'report-template.html'), 'utf8');
const outputs = process.argv.slice(2);
if (!outputs.length) outputs.push(join(dir, 'report.html'));

const runs = [...data.runs].sort((a, b) => b.score_total - a.score_total);

const SHORT = {
    'claude-opus-5': 'opus-5',
    'claude-sonnet-5': 'sonnet-5',
    'claude-haiku-4.5': 'haiku-4.5',
    'gpt-5.6-luna': 'luna',
    'deepseek-v4-pro-0813': 'deepseek',
    'qwen3.6-35b-a3b': 'qwen',
    'gemma-4-26b-a4b': 'gemma',
};
const short = (r) =>
    (SHORT[r.model] || r.model) + (r.partial ? ' (partial)' : '');

const pill = (tone, text) =>
    tone ? `<span class="pill p-${tone}">${text}</span>` : text;
const faint = (t) =>
    `<em style="display:inline;color:var(--ink-faint);font-size:11px;font-style:normal">${t}</em>`;
const smallBlock = (t) =>
    `<small style="display:block;color:var(--ink-faint)">${t}</small>`;
const kFmt = (v) => {
    const k = v / 1000;
    return (k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)) + ' k';
};
const mFmt = (v) => (v / 1e6).toFixed(1) + ' M';
const share = (t) =>
    (
        (100 * t.cache_read) /
        (t.tokens_in + t.tokens_out + t.cache_read + (t.cache_write || 0) || 1)
    ).toFixed(1) + ' %';

const bugPoints = (r) =>
    r.defects.reduce(
        (n, d) => n + { critical: 3, medium: 2, minor: 1 }[d.severity],
        0
    );
const bugTone = (n) => (n === 0 ? 'good' : n <= 4 ? 'mid' : 'bad');

const sub = (r) =>
    [r.harness, r.provider, r.local ? 'local' : null]
        .filter(Boolean)
        .join(' · ');

const min = (key) => Math.min(...runs.map((r) => r.telemetry[key]));

const numVal = (x) => {
    const m = String(x)
        .replace(/<[^>]+>/g, ' ')
        .match(/-?\d[\d,.]*/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : -1;
};
const sortHead = (labels, sortableFrom, sortableTo, initial) =>
    labels
        .map((h, i) => {
            const sortable = i >= sortableFrom && i <= sortableTo;
            const active = i === initial;
            return `<th${i ? ' class="num"' : ''}${sortable ? ` data-sort="${i}"` : ''}${active ? ' data-dir="desc"' : ''}>${h}${sortable ? ` <span class="dir">${active ? '\u25BC' : ''}</span>` : ''}</th>`;
        })
        .join('\n            ');

function scoreboard() {
    const heads = [
        '#',
        'Model',
        'Score',
        'Cost',
        'Wall',
        'Tokens',
        'Peak ctx',
        'Window',
        'Compact',
        'Commits',
        'Bugs',
    ];
    const head = heads
        .map((h, i) => `<th${i > 3 ? ' class="num"' : ''}>${h}</th>`)
        .join('\n            ');
    const body = runs
        .map((r, i) => {
            const t = r.telemetry;
            const best = (cond) => (cond ? ' best' : '');
            const gauge =
                `<div class="scorewrap"><span class="scoreval">${Math.round(r.score_total)}</span>` +
                `<div class="bar${i === 0 ? ' gold' : ''}"><span style="width:${Math.round(r.score_total)}%"></span></div></div>` +
                `<small style="display:block;color:var(--ink-faint);font-size:11px;margin-top:3px">${r.cost.provider_label}</small>`;
            const paid = r.cost.paid_usd
                ? `paid ${r.cost.paid_basis === 'metered' ? '' : '≈'}$${r.cost.paid_usd}`
                : 'paid ≈$?.??';
            const orMain = r.local ? pill('good', '$0') : `$${r.cost.or_usd}`;
            const cost = `${orMain}${smallBlock(paid)}`;
            const bp = bugPoints(r);
            const winTone = t.window_pct > 90 ? 'bad' : null;
            return `          <tr>
            <td class="rank${i === 0 ? ' rank-1' : ''}">${i + 1}</td>
            <th scope="row" class="model${i === 0 ? ' best' : ''}">${r.model}<small>${sub(r)}</small></th>
            <td>${gauge}</td>
            <td class="num">${cost}</td>
            <td class="num${best(t.wall_clock_min === min('wall_clock_min'))}">${Math.round(t.wall_clock_min)} min</td>
            <td class="num${best(t.tokens_total === min('tokens_total'))}">${mFmt(t.tokens_total)}</td>
            <td class="num${best(t.peak_context === min('peak_context'))}">${kFmt(t.peak_context)}</td>
            <td class="num">${pill(winTone, t.window_pct + ' %')}</td>
            <td class="num${best(t.compactions === 0)}">${t.compactions}</td>
            <td class="num">${t.commits}</td>
            <td class="num${best(bp === 0)}">${pill(bugTone(bp), String(bp))}</td>
          </tr>`;
        })
        .join('\n');
    return `<table>
        <thead>
          <tr>
            ${head}
          </tr>
        </thead>
        <tbody>
${body}
        </tbody>
      </table>`;
}

function matrix() {
    const head = ['Criterion', ...runs.map(short)]
        .map((h) => `<th>${h}</th>`)
        .join('\n            ');
    let dataRow = 0;
    const body = data.matrix_rows
        .map((row) => {
            if (row.type === 'group')
                return `          <tr class="group"><th scope="row">${row.label}</th><td colspan="${runs.length}"></td></tr>`;
            const i = dataRow++;
            const cells = runs
                .map((r) => '            ' + r.matrix_cells[i])
                .join('\n');
            return `          <tr>
            <th scope="row">${row.label}</th>
${cells}
          </tr>`;
        })
        .join('\n');
    const totals = runs
        .map(
            (r, i) =>
                `<td${i === 0 ? ' class="best"' : ''}>${r.matrix_total}</td>`
        )
        .join('\n            ');
    return `<table class="matrix">
        <thead>
          <tr>
            ${head}
          </tr>
        </thead>
        <tbody>
${body}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            ${totals}
          </tr>
        </tfoot>
      </table>`;
}

function costTable() {
    const heads = [
        'Per run',
        'Cheapest OpenRouter',
        'Actually paid',
        'Fresh input',
        'Output',
        'Cache read',
        'Vendor rate',
        '$/M input',
        '$/M output',
        '$/M cache read',
        'Cache share',
        'Provider used',
    ];
    const head = sortHead(heads, 1, 10, 1);
    const body = runs
        .filter((r) => r.cost.rate_in)
        .sort((a, b) => Number(b.cost.or_usd) - Number(a.cost.or_usd))
        .map((r) => {
            const t = r.telemetry;
            const c = r.cost;
            const cells = [
                `${faint(`(${c.or_route})`)} $${c.or_usd}`,
                `${faint(`(${c.paid_basis})`)} $${c.paid_usd}`,
                kFmt(t.tokens_in),
                kFmt(t.tokens_out),
                mFmt(t.cache_read),
                `$${c.vendor_usd}`,
                c.rate_in,
                c.rate_out,
                pill(c.rate_tone, c.rate_cr),
                share(t),
                c.provider_label,
            ]
                .map(
                    (x) =>
                        `            <td class="num" data-v="${numVal(x)}">${x}</td>`
                )
                .join('\n');
            return `          <tr>
            <th scope="row" class="model">${r.model}</th>
${cells}
          </tr>`;
        })
        .join('\n');
    return `<table class="sortable">
        <thead>
          <tr>
            ${head}
          </tr>
        </thead>
        <tbody>
${body}
        </tbody>
      </table>`;
}

function planTable() {
    const heads = [
        'On a plan',
        'Marginal cost',
        'Metered equivalent',
        'Runs/week held',
        'Plan',
        'Allocated to the model',
        'A week of allowance',
        'Of the 5-hour window',
        'Of the weekly window',
    ];
    const head = sortHead(heads, 1, 6);
    const ne = (v) => (v === 'not exposed' ? pill('none', 'not exposed') : v);
    const body = runs
        .filter((r) => r.plan)
        .map((r) => {
            const p = r.plan;
            const metTone =
                Number(r.cost.vendor_usd) >= 5
                    ? 'bad'
                    : Number(r.cost.vendor_usd) <= 1.5
                      ? 'good'
                      : null;
            const cells = [
                pill(
                    numVal(p.marginal) <= 0.1
                        ? 'good'
                        : numVal(p.marginal) <= 0.5
                          ? 'mid'
                          : 'bad',
                    p.marginal
                ),
                pill(metTone, `$${r.cost.vendor_usd}`),
                p.rpw,
                p.plan,
                `${faint(p.alloc_note)} ${p.alloc}`,
                p.week,
                ne(p.w5h),
                ne(p.wweek),
            ]
                .map(
                    (x) =>
                        `            <td class="num" data-v="${numVal(x)}">${x}</td>`
                )
                .join('\n');
            return `          <tr>
            <th scope="row" class="model">${r.model}</th>
${cells}
          </tr>`;
        })
        .join('\n');
    return `<table class="sortable">
        <thead>
          <tr>
            ${head}
          </tr>
        </thead>
        <tbody>
${body}
        </tbody>
      </table>`;
}

const SORTER =
    `<script>
document.querySelectorAll('table.sortable th[data-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
        const table = th.closest('table');
        const idx = Number(th.dataset.sort);
        const desc = th.dataset.dir !== 'desc';
        table.querySelectorAll('th[data-sort]').forEach((o) => {
            delete o.dataset.dir;
            o.querySelector('.dir').textContent = '';
        });
        th.dataset.dir = desc ? 'desc' : 'asc';
        th.querySelector('.dir').textContent = desc ? '\u25BC' : '\u25B2';
        const tbody = table.tBodies[0];
        [...tbody.rows]
            .sort((a, b) => {
                const va = Number(a.cells[idx].dataset.v);
                const vb = Number(b.cells[idx].dataset.v);
                return desc ? vb - va : va - vb;
            })
            .forEach((r) => tbody.appendChild(r));
    });
});
</` + `script>`;

let html =
    template
        .replace('{{SCOREBOARD}}', scoreboard())
        .replace('{{MATRIX}}', matrix())
        .replace('{{COST}}', costTable())
        .replace('{{PLAN}}', planTable()) + SORTER;

for (const out of outputs) writeFileSync(out, html);

const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
tables.forEach((t, ti) => {
    const rows = t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    const counts = {};
    for (const r of rows) {
        const n =
            (r.match(/<t[dh]\b/g) || []).length +
            [...r.matchAll(/colspan="(\d+)"/g)].reduce(
                (a, m) => a + Number(m[1]) - 1,
                0
            );
        counts[n] = (counts[n] || 0) + 1;
    }
    console.log(
        `table ${ti + 1}: rows=${rows.length} colcounts=${JSON.stringify(counts)}`
    );
});
console.log('written:', outputs.join(', '));
