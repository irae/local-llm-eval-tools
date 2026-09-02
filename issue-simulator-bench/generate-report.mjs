#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
// Two tests, independent artifacts (see PLAN.md): the default is the blind
// bake-off; `--guided` switches every input and output to the guided run.
const args = process.argv.slice(2);
const guided = args[0] === '--guided';
if (guided) args.shift();
for (const a of args) {
    if (a.startsWith('--') || !a.endsWith('.html')) {
        console.error(
            `unknown argument "${a}" — usage: generate-report.mjs [--guided] [output.html ...]`
        );
        process.exit(2);
    }
}
const resultsFile = guided ? 'results-guided.json' : 'results.json';
const templateFile = guided
    ? 'report-guided-template.html'
    : 'report-template.html';
const data = JSON.parse(readFileSync(join(dir, resultsFile), 'utf8'));
const otherData = JSON.parse(
    readFileSync(join(dir, guided ? 'results.json' : 'results-guided.json'), 'utf8')
);
const template = readFileSync(join(dir, templateFile), 'utf8');
const outputs = args;
if (!outputs.length)
    outputs.push(join(dir, guided ? 'report-guided.html' : 'report.html'));

const runs = [...data.runs].sort((a, b) => b.score_total - a.score_total);

// Rows never mix across prompt versions (PLAN.md forbids the comparison):
// every scoreboard and matrix renders once per version, newest first.
const groups = (() => {
    const m = new Map();
    for (const r of runs) {
        const v = r.prompt_version || 'unversioned';
        if (!m.has(v)) m.set(v, []);
        m.get(v).push(r);
    }
    return [...m.entries()].sort((a, b) =>
        b[0].localeCompare(a[0], undefined, { numeric: true })
    );
})();

// The matrix cells are prose, but their bold numbers must equal `scores`,
// the single source of truth. Refuse to render a report that disagrees
// with itself.
const MATRIX_SCORE_ROWS = [
    [/^Bugs remaining/, 'bugs'],
    [/^Subtotal.*20/, 'completion'],
    [/^node_modules actually/, 'node_modules'],
    [/^Prettier/, 'lint'],
    [/^Subtotal.*12/, 'commit_craft'],
    [/^Right the first time/, 'first_time'],
    [/^Full suite/, 'test_discipline'],
    [/^Task list built/, 'task_list'],
    [/^Truncated noisy/, 'truncation'],
    [/^Followed house/, 'conventions'],
];
{
    const dataRows = data.matrix_rows.filter((r) => r.type !== 'group');
    const errors = [];
    for (const r of runs) {
        const sum = Object.values(r.scores).reduce((a, b) => a + b, 0);
        if (Math.abs(sum - r.score_total) > 0.001)
            errors.push(
                `${r.model}: scores sum ${sum} != score_total ${r.score_total}`
            );
        dataRows.forEach((row, i) => {
            const label = row.label.replace(/<[^>]+>/g, ' ').trim();
            const map = MATRIX_SCORE_ROWS.find(([re]) => re.test(label));
            if (!map) return;
            const b = (r.matrix_cells[i] || '').match(/<b>([\d.]+)/);
            if (!b || Number(b[1]) !== r.scores[map[1]])
                errors.push(
                    `${r.model}: matrix cell "${label}" says ${b ? b[1] : 'nothing'}, scores.${map[1]} is ${r.scores[map[1]]}`
                );
        });
    }
    if (errors.length) {
        console.error('score consistency check failed:');
        for (const e of errors) console.error('  ' + e);
        process.exit(1);
    }
}

const DISPLAY = {
    'claude-opus-5': 'Claude Opus 5',
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-haiku-4.5': 'Claude Haiku 4.5',
    'Claude Haiku 4.5': 'Claude Haiku 4.5',
    'Claude Sonnet 4.5': 'Claude Sonnet 4.5',
    'gpt-5.6-luna': 'GPT-5.6 Luna',
    'gpt-5.6-sol': 'GPT-5.6 Sol',
    'grok-4.6': 'Grok 4.6',
    'kimi-k3': 'Kimi K3',
    'deepseek-v4-pro-0813': 'DeepSeek V4 Pro (0813)',
    'deepseek-v4-flash-0731': 'DeepSeek V4 Flash (0731)',
    'glm-5p3-flash': 'GLM 5.3 Flash',
    'qwen3.6-35b-a3b': 'Qwen3.6 35B-A3B',
    'gemma-4-26b-a4b': 'Gemma 4 26B-A4B',
    'mlx-community/Qwen3.8-27B-4bit': 'Qwen3.8 27B (MLX 4-bit)',
    'Qwen3.8-27B (mlx, low)': 'Qwen3.8 27B (MLX 4-bit, low reasoning)',
    'prism-ml/Ternary-Bonsai-27B-mlx-2bit': 'Ternary Bonsai 27B (MLX 2-bit)',
    'Ternary-Bonsai-27B (mlx, low)':
        'Ternary Bonsai 27B (MLX 2-bit, low reasoning)',
};
const display = (r) => DISPLAY[r.model] || r.model;

const SHORT = {
    'claude-opus-5': 'opus-5',
    'claude-sonnet-5': 'sonnet-5',
    'claude-haiku-4.5': 'haiku-4.5',
    'Claude Haiku 4.5': 'haiku-4.5',
    'Claude Sonnet 4.5': 'sonnet-4.5',
    'gpt-5.6-luna': 'luna',
    'gpt-5.6-sol': 'sol',
    'grok-4.6': 'grok',
    'kimi-k3': 'kimi',
    'deepseek-v4-pro-0813': 'deepseek',
    'deepseek-v4-flash-0731': 'ds-flash',
    'glm-5p3-flash': 'glm-flash',
    'qwen3.6-35b-a3b': 'qwen',
    'gemma-4-26b-a4b': 'gemma',
    'mlx-community/Qwen3.8-27B-4bit': 'qwen3.8',
    'Qwen3.8-27B (mlx, low)': 'qwen3.8-low',
    'prism-ml/Ternary-Bonsai-27B-mlx-2bit': 'bonsai',
    'Ternary-Bonsai-27B (mlx, low)': 'bonsai-low',
};
const short = (r) =>
    (SHORT[r.model] || display(r)) + (r.partial ? ' (partial)' : '');

const END_REASON = {
    complete: null, // not shown; completeness is the default
    wall_clock: 'time budget',
    model_budget_exhausted: 'nudge budget',
    tooling_budget_exhausted: 'harness budget',
    harness_crash: 'harness crash',
    stuck: 'stuck',
    operator_stop: 'stopped',
};
const partialDetail = (r) => {
    if (!r.partial) return null;
    const parts = ['partial'];
    if (r.libraries_done != null) parts.push(`${r.libraries_done} of 8`);
    const why = END_REASON[r.end_reason];
    if (why) parts.push(why);
    return parts.join(' · ');
};

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
    [
        r.harness,
        r.provider,
        r.local ? 'local' : null,
        r.thinking ? `think ${r.thinking}` : null,
    ]
        .filter(Boolean)
        .join(' · ');

const topCut = (values) => {
    const k = Math.max(1, Math.round(values.length * 0.2));
    return [...values].sort((a, b) => a - b)[k - 1] * 1.05;
};
// "best" highlighting compares only within a prompt-version group.
const topChecker = (rows) => {
    const cuts = {};
    return (key, v) => {
        if (!(key in cuts))
            cuts[key] = topCut(rows.map((r) => r.telemetry[key]));
        return v <= cuts[key];
    };
};

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
            return `<th${i ? ' class="num"' : ''}${sortable ? ` data-sort="${i}"` : ''}${active ? ' data-dir="desc"' : ''}>${h}${sortable ? ` <span class="dir">${active ? '▼' : ''}</span>` : ''}</th>`;
        })
        .join('\n            ');

const versionHeading = (v) =>
    `<h3 class="lede">Prompt ${v === 'unversioned' ? 'version not recorded' : v}</h3>\n      `;
const versionSection = (v, inner) =>
    `<div class="vsec" data-v="${v}">${versionHeading(v)}${inner}</div>`;

const versionsOf = (d) =>
    [...new Set(d.runs.map((r) => r.prompt_version || 'unversioned'))].sort(
        (a, b) => b.localeCompare(a, undefined, { numeric: true })
    );
const blindVersions = versionsOf(guided ? otherData : data);
const guidedVersions = versionsOf(guided ? data : otherData);
const pairs = blindVersions.flatMap((b) =>
    guidedVersions.map((g) => ({
        id: `${b}_${g}`,
        label: `blind ${b} / guided ${g}`,
    }))
);
if (pairs.length) pairs[0].label = 'latest / latest';

function nav() {
    const options = pairs
        .map(
            (p, i) =>
                `<option value="${p.id}"${i === 0 ? ' selected' : ''}>${p.label}</option>`
        )
        .join('');
    const link = guided
        ? '<a id="crosslink" data-base="report.html" href="report.html">← Blind report</a>'
        : '<a id="crosslink" data-base="report-guided.html" href="report-guided.html">Guided report →</a>';
    return `<p class="lede" id="report-nav">${link}
        &nbsp;·&nbsp; <label>Prompt versions:
        <select id="pairsel" data-own="${guided ? 'guided' : 'blind'}">${options}</select></label></p>`;
}

function scoreboardFor(rows) {
    const heads = [
        '#',
        'Model',
        'Score',
        'Cost',
        'Wall',
        'Tokens',
        'Peak ctx',
        'Window',
        'Commits',
        'Bugs',
    ];
    const head = heads
        .map((h, i) => `<th${i > 3 ? ' class="num"' : ''}>${h}</th>`)
        .join('\n            ');
    const isTop = topChecker(rows);
    const body = rows
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
            const orNum = Number(r.cost.or_usd);
            const orMain = r.local
                ? pill('good', '$0')
                : Number.isFinite(orNum)
                  ? `$${r.cost.or_usd}`
                  : '—';
            const cost = `${orMain}${smallBlock(paid)}`;
            const bp = bugPoints(r);
            const winTone = t.window_pct > 90 ? 'bad' : null;
            const crit = r.defects.filter(
                (d) => d.severity === 'critical'
            ).length;
            const planUsd = r.plan ? numVal(r.plan.marginal) : orNum;
            const fin = (v) => (Number.isFinite(v) ? v : '');
            const attrs = ` data-base="${r.score_total}" data-or="${fin(orNum)}" data-plan="${fin(planUsd)}" data-crit="${crit}" data-wall="${Math.round(t.wall_clock_min)}"`;
            const detail = partialDetail(r);
            return `          <tr${attrs}>
            <td class="rank${i === 0 ? ' rank-1' : ''}">${i + 1}</td>
            <th scope="row" class="model${i === 0 ? ' best' : ''}">${display(r)}<small>${sub(r)}</small>${detail ? smallBlock(detail) : ''}</th>
            <td>${gauge}</td>
            <td class="num">${cost}</td>
            <td class="num${best(isTop('wall_clock_min', t.wall_clock_min))}">${Math.round(t.wall_clock_min)} min</td>
            <td class="num${best(isTop('tokens_total', t.tokens_total))}">${mFmt(t.tokens_total)}</td>
            <td class="num${best(isTop('peak_context', t.peak_context))}">${kFmt(t.peak_context)}</td>
            <td class="num">${pill(winTone, t.window_pct + ' %')}</td>
            <td class="num">${t.commits}</td>
            <td class="num${best(bp === 0)}">${pill(bugTone(bp), String(bp))}</td>
          </tr>`;
        })
        .join('\n');
    return `<div class="scroller"><table class="scoreboard">
        <thead>
          <tr>
            ${head}
          </tr>
        </thead>
        <tbody>
${body}
        </tbody>
      </table></div>`;
}

function scoreboard() {
    const radios = `<p class="lede" id="costmode-radios">
        <label><input type="radio" name="costmode" value="none" checked> quality only</label>
        &nbsp; <label><input type="radio" name="costmode" value="or"> weighted by OpenRouter cost</label>
        &nbsp; <label><input type="radio" name="costmode" value="plan"> weighted by plan estimate</label>
      </p>
      <p class="lede" id="plan-note" style="display:none">Cost-weighted score = 100 × quality score ÷ (1 + cost × (1 + criticals) + $0.01 per minute of wall clock), normalised to the leader. A critical bug is priced as one extra run of the same model — fixing after a cheap run is cheap, fixing after an expensive run is expensive. Plan mode uses the marginal plan estimate where one exists; runs without a plan keep their OpenRouter figure; local runs cost $0 plus time.</p>`;
    return (
        radios +
        '\n      ' +
        groups
            .map(([v, rows]) => versionSection(v, scoreboardFor(rows)))
            .join('\n      ')
    );
}

function matrixFor(rows) {
    const head = ['Criterion', ...rows.map(short)]
        .map((h) => `<th>${h}</th>`)
        .join('\n            ');
    let dataRow = 0;
    const body = data.matrix_rows
        .map((row) => {
            if (row.type === 'group')
                return `          <tr class="group"><th scope="row">${row.label}</th><td colspan="${rows.length}"></td></tr>`;
            const i = dataRow++;
            const cells = rows
                .map((r) => '            ' + r.matrix_cells[i])
                .join('\n');
            return `          <tr>
            <th scope="row">${row.label}</th>
${cells}
          </tr>`;
        })
        .join('\n');
    const totals = rows
        .map(
            (r, i) =>
                `<td${i === 0 ? ' class="best"' : ''}>${r.score_total}</td>`
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

const matrix = () =>
    groups
        .map(([v, rows]) => versionSection(v, matrixFor(rows)))
        .join('\n      ');

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
            <th scope="row" class="model">${display(r)}</th>
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
                (() => {
                    const est = / est\.?$/.test(p.marginal);
                    const val = p.marginal.replace(/ est\.?$/, '');
                    const tone =
                        numVal(val) <= 0.1
                            ? 'good'
                            : numVal(val) <= 0.5
                              ? 'mid'
                              : 'bad';
                    return (est ? faint('(est)') + ' ' : '') + pill(tone, val);
                })(),
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
            <th scope="row" class="model">${display(r)}</th>
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
(() => {
    const note = document.getElementById('plan-note');
    const boards = [...document.querySelectorAll('table.scoreboard tbody')];
    const apply = () => {
        const mode = document.querySelector(
            'input[name="costmode"]:checked'
        ).value;
        for (const tbody of boards) {
            const rows = [...tbody.rows];
            let vals = rows.map((r) => {
                const d = r.dataset;
                if (mode === 'none') return Number(d.base);
                const raw = mode === 'or' ? d.or : d.plan;
                if (raw === '') return NaN;
                return (
                    Number(d.base) /
                    (1 +
                        Number(raw) * (1 + Number(d.crit)) +
                        0.01 * Number(d.wall))
                );
            });
            if (mode !== 'none') {
                const mx = Math.max(...vals.filter(Number.isFinite));
                vals = vals.map((v) => (100 * v) / mx);
            }
            rows.forEach((r, i) => {
                const ok = Number.isFinite(vals[i]);
                r.dataset.adj = ok ? vals[i] : '';
                r.querySelector('.scoreval').textContent = ok
                    ? Math.round(vals[i])
                    : '—';
                r.querySelector('.bar span').style.width = ok
                    ? Math.round(vals[i]) + '%'
                    : '0%';
            });
            const adj = (r) =>
                r.dataset.adj === '' ? -Infinity : Number(r.dataset.adj);
            rows.sort((a, b) => adj(b) - adj(a));
            rows.forEach((r, i) => {
                tbody.appendChild(r);
                const rank = r.querySelector('.rank');
                rank.textContent = i + 1;
                rank.classList.toggle('rank-1', i === 0);
                r.querySelector('.bar').classList.toggle('gold', i === 0);
                r.querySelector('.model').classList.toggle('best', i === 0);
            });
        }
        note.style.display = mode === 'plan' ? 'block' : 'none';
    };
    document
        .querySelectorAll('input[name="costmode"]')
        .forEach((el) => el.addEventListener('change', apply));
})();
(() => {
    const sel = document.getElementById('pairsel');
    if (!sel) return;
    const link = document.getElementById('crosslink');
    const own = sel.dataset.own;
    const fromHash = (location.hash.match(/pair=([^&]+)/) || [])[1];
    if (fromHash && [...sel.options].some((o) => o.value === fromHash))
        sel.value = fromHash;
    const apply = () => {
        const [b, g] = sel.value.split('_');
        const v = own === 'guided' ? g : b;
        document
            .querySelectorAll('.vsec')
            .forEach((d) => (d.hidden = d.dataset.v !== v));
        link.href = link.dataset.base + '#pair=' + sel.value;
        if (location.hash) location.hash = 'pair=' + sel.value;
    };
    sel.addEventListener('change', () => {
        location.hash = 'pair=' + sel.value;
        apply();
    });
    apply();
})();
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
        th.querySelector('.dir').textContent = desc ? '▼' : '▲';
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
        .replace('{{NAV}}', nav())
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
