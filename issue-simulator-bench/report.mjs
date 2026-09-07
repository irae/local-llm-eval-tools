#!/usr/bin/env node
// The report model, and its four renderers.
//
//   node report.mjs [--variant <name>] [--all] [--scan <dir>]
//                    [--format json|csv|md|html] [--out <file>] [output ...]
//
// ISB_TASK_DIR and ISB_DATA_DIR come from the environment; isb sets them
// before this script starts. With --scan neither is required: the scan
// walks a directory of results files directly.

import { execFileSync } from 'node:child_process';
import {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = { json: 'json', csv: 'csv', md: 'md', html: 'html' };

// ---- args -------------------------------------------------------------------
let variantOverride = null;
let allVariants = false;
let scanDir = null;
let format = null;
let outArg = null;
const positional = [];
{
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--all') {
            allVariants = true;
            continue;
        }
        if (a === '--variant' || a === '--scan' || a === '--format' || a === '--out') {
            if (i + 1 >= argv.length) {
                console.error(`error: ${a} requires a value`);
                process.exit(2);
            }
            const v = argv[++i];
            if (a === '--variant') variantOverride = v;
            else if (a === '--scan') scanDir = v;
            else if (a === '--format') format = v;
            else outArg = v;
            continue;
        }
        if (a.startsWith('--')) {
            console.error(`error: unknown argument ${a}`);
            process.exit(2);
        }
        positional.push(a);
    }
}
if (format && !['json', 'csv', 'md', 'html'].includes(format)) {
    console.error(`error: unknown --format ${format} (want json, csv, md or html)`);
    process.exit(2);
}
if (scanDir && allVariants) {
    console.error('error: --all and --scan cannot both be given');
    process.exit(2);
}
if (!format) format = scanDir || allVariants ? 'html' : 'json';

const navMode = scanDir ? 'scan' : allVariants ? 'all' : 'single';

const taskDir = process.env.ISB_TASK_DIR;
const dataDir = process.env.ISB_DATA_DIR;

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function toolVersion() {
    if (process.env.ISB_TOOL_VERSION) return process.env.ISB_TOOL_VERSION;
    try {
        return execFileSync('git', ['-C', HERE, 'describe', '--tags', '--always'], {
            encoding: 'utf8',
        }).trim();
    } catch {
        return 'unknown';
    }
}

// ---- the completion cap, dimming and score line, one row at a time ----------
// Sort and rank happen per prompt_version group (see groupByPromptVersion):
// different prompt versions are not comparable, so a global rank would be
// meaningless across them.
function processRuns(runs, unit, errors) {
    return runs.map((row) => {
        const scores = row.scores || {};
        const sum = Object.values(scores).reduce((a, b) => a + (Number(b) || 0), 0);
        const scoreTotal = row.score_total;
        if (Math.abs(sum - scoreTotal) > 0.001) {
            errors.push(`${row.model}: scores sum ${sum} != score_total ${scoreTotal}`);
        }
        const raw = scoreTotal;
        const capped = unit ? Math.min(scoreTotal, (100 * row[unit.field]) / unit.max) : scoreTotal;
        const reruns = row.reruns ?? 0;
        if (reruns) {
            const expected = Math.max(0, Math.min(raw, capped) - 10 * reruns);
            if (Math.abs(expected - scoreTotal) > 0.001) {
                errors.push(
                    `${row.model}: reruns ${reruns} needs score_total ${expected}, row says ${scoreTotal}`
                );
            }
        }
        const invalid = row.invalid ?? false;
        const dimmed = invalid || (unit ? row[unit.field] < unit.max : row.resolved === false);
        const processedRow = { ...row, raw, capped, invalid, dimmed };
        processedRow.score_line = scoreLine(processedRow, unit);
        return processedRow;
    });
}

function scoreLine(row, unit) {
    let line;
    if (row.invalid) {
        line = `invalid — ${row.invalid_reason ?? ''}`.trimEnd();
    } else if (unit) {
        line = `${row[unit.field]}/${unit.max} ${unit.label}`;
        if (row.capped < row.raw) line += ` (raw ${row.raw})`;
    } else {
        line = row.resolved ? 'resolved' : 'not resolved';
    }
    const parts = [line];
    // The no-unit main clause is already "resolved"/"not resolved"; only the
    // unit's done/max/label clause needs the list-derived word appended too.
    if (unit && row.resolved_by === 'lists') parts.push(row.resolved ? 'resolved' : 'not resolved');
    if (row.best_of) parts.push(`best of ${row.best_of} run${row.best_of === 1 ? '' : 's'}`);
    else if (row.reruns) parts.push(`reruns: ${row.reruns}, −${10 * row.reruns}`);
    else if (row.anomaly) parts.push(row.anomaly);
    return parts.join(' · ');
}

// ---- sort (invalid last, then capped descending) and 1-based rank ------------
function sortAndRank(rows) {
    const sorted = [...rows].sort(
        (a, b) => (a.invalid ? 1 : 0) - (b.invalid ? 1 : 0) || b.capped - a.capped
    );
    let rank = 0;
    for (const r of sorted) r.rank = r.invalid ? '—' : ++rank;
    return sorted;
}

// ---- grouping by prompt_version, newest first; each group sorted and ranked
// on its own, since versions are never compared to each other -----------------
function groupByPromptVersion(rows) {
    const m = new Map();
    for (const r of rows) {
        const v = r.prompt_version || 'unversioned';
        if (!m.has(v)) m.set(v, []);
        m.get(v).push(r);
    }
    return [...m.entries()]
        .sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }))
        .map(([prompt_version, rows]) => ({ prompt_version, rows: sortAndRank(rows) }));
}

// ---- cost and plan, built from whatever the rows already carry ---------------
function buildCost(rows) {
    return rows
        .filter((r) => r.cost_usd != null)
        .map((r) => ({
            model: r.model,
            thinking: r.thinking ?? null,
            cost_usd: r.cost_usd,
            cost_basis: r.cost_basis ?? null,
            tokens_total: r.telemetry?.tokens_total ?? null,
        }))
        .sort((a, b) => b.cost_usd - a.cost_usd);
}

function buildPlan(rows) {
    return rows
        .filter((r) => r.plan_provider && r.plan_provider !== 'none')
        .map((r) => ({ model: r.model, thinking: r.thinking ?? null, plan_provider: r.plan_provider }));
}

function buildTaskEntry({ instanceId, variantName, version, unit, runs, errors }) {
    const flat = processRuns(runs, unit, errors);
    return {
        instance_id: instanceId,
        variant: variantName,
        version: version ?? null,
        unit: unit ?? null,
        rows: groupByPromptVersion(flat),
        cost: buildCost(flat),
        plan: buildPlan(flat),
    };
}

function flattenEntryRows(entry) {
    const rows = [];
    for (const g of entry.rows) rows.push(...g.rows);
    return rows;
}

// ---- loading results files ----------------------------------------------------
function loadRuns(resultsPath) {
    if (!existsSync(resultsPath)) {
        console.error(`error: no results file at ${resultsPath}`);
        process.exit(2);
    }
    const parsed = readJson(resultsPath);
    return Array.isArray(parsed.runs) ? parsed.runs : [];
}

// ---- --scan: derive (instance_id, variant) from a bare results file's path ---
// The tool's own data layout is <data_base>/<instance_id>/results/<file>.json
// (see the README, "Settings and directories"), so instance_id is the name of
// the results file's grandparent directory. The variant is the file's own
// name with the "results-" prefix and ".json" suffix stripped, matching
// score.mjs's own naming (a bare "results.json" is the "default" variant).
function scanResultsFiles(dir) {
    const found = [];
    (function walk(d) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.isFile() && entry.name.endsWith('.json') && basename(d) === 'results')
                found.push(p);
        }
    })(dir);
    return found.map((p) => {
        const fname = basename(p, '.json');
        const variant = fname === 'results' ? 'default' : fname.replace(/^results-/, '');
        const instanceId = basename(dirname(dirname(p)));
        return { path: p, instanceId, variant };
    });
}

// ---- building the tasks array ---------------------------------------------------
const errors = [];
let taskEntries = [];

if (scanDir) {
    const found = scanResultsFiles(scanDir);
    if (!found.length) {
        console.error(`error: no results/*.json files found under ${scanDir}`);
        process.exit(2);
    }
    for (const f of found) {
        taskEntries.push(
            buildTaskEntry({
                instanceId: f.instanceId,
                variantName: f.variant,
                version: null,
                unit: null,
                runs: loadRuns(f.path),
                errors,
            })
        );
    }
} else {
    if (!taskDir || !dataDir) {
        console.error('error: ISB_TASK_DIR and ISB_DATA_DIR must be set (run through isb), unless --scan is given');
        process.exit(2);
    }
    const taskJsonPath = join(taskDir, 'task.json');
    if (!existsSync(taskJsonPath)) {
        console.error(`error: no task.json at ${taskJsonPath}`);
        process.exit(2);
    }
    const task = readJson(taskJsonPath);
    const instanceId = task.instance_id || basename(taskDir);
    const variants = task.variants || {};
    const unit = task.unit || null;

    let names;
    if (allVariants) {
        names = Object.keys(variants);
    } else {
        const name = variantOverride || process.env.ISB_VARIANT || task.defaults?.variant;
        if (!name) {
            console.error(
                'error: no variant resolved. Give one of: --variant <name>, ISB_VARIANT, or a "variant" key in the task\'s defaults'
            );
            process.exit(2);
        }
        names = [name];
    }

    for (const name of names) {
        const variant = variants[name];
        if (!variant) {
            console.error(`error: no variant "${name}" in ${taskJsonPath}`);
            process.exit(2);
        }
        const resultsPath = join(dataDir, 'results', variant.results);
        taskEntries.push(
            buildTaskEntry({
                instanceId,
                variantName: name,
                version: variant.version ?? task.version ?? null,
                unit,
                runs: loadRuns(resultsPath),
                errors,
            })
        );
    }
}

if (errors.length) {
    console.error('score consistency check failed:');
    for (const e of errors) console.error('  ' + e);
    process.exit(2);
}
if (!taskEntries.length) {
    console.error('error: nothing to report');
    process.exit(2);
}

const model = {
    generated: new Date().toISOString(),
    tool_version: toolVersion(),
    tasks: taskEntries,
};

// ---- output paths ----------------------------------------------------------------
function reportsDir() {
    return join(dataDir, 'reports');
}
function defaultOutPath(fmt) {
    if (scanDir) return join(scanDir, `index.${EXT[fmt]}`);
    if (navMode === 'all') return join(reportsDir(), `${taskEntries[0].instance_id}.${EXT[fmt]}`);
    return join(reportsDir(), `${taskEntries[0].instance_id}-${taskEntries[0].variant}.${EXT[fmt]}`);
}
function ensureDir(p) {
    mkdirSync(dirname(p), { recursive: true });
}
function writeOut(path, content) {
    ensureDir(path);
    writeFileSync(path, content);
    return path;
}

// ---- csv --------------------------------------------------------------------------
function csvCell(v) {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const DERIVED = ['rank', 'capped', 'raw', 'dimmed', 'score_line'];
function buildCsvColumns(rows) {
    const base = new Set();
    const scoreKeys = new Set();
    const telemetryKeys = new Set();
    for (const r of rows) {
        for (const k of Object.keys(r)) {
            if (k === 'scores') {
                Object.keys(r.scores || {}).forEach((x) => scoreKeys.add(x));
                continue;
            }
            if (k === 'telemetry') {
                Object.keys(r.telemetry || {}).forEach((x) => telemetryKeys.add(x));
                continue;
            }
            if (DERIVED.includes(k)) continue;
            base.add(k);
        }
    }
    const baseCols = [...base].sort((a, b) =>
        a === 'model' ? -1 : b === 'model' ? 1 : a.localeCompare(b)
    );
    return [
        ...baseCols,
        ...[...scoreKeys].sort().map((k) => `scores.${k}`),
        ...[...telemetryKeys].sort().map((k) => `telemetry.${k}`),
        ...DERIVED,
    ];
}
function renderCsv(entries) {
    const rows = entries.flatMap(flattenEntryRows);
    const cols = buildCsvColumns(rows);
    const lines = [cols.join(',')];
    for (const r of rows) {
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

// ---- markdown ---------------------------------------------------------------------
function renderMd(rmodel) {
    const parts = [
        '# Report',
        '',
        `Generated: ${rmodel.generated}`,
        `Tool version: ${rmodel.tool_version}`,
        '',
    ];
    for (const entry of rmodel.tasks) {
        parts.push(`# ${entry.instance_id} — ${entry.variant}`, '');
        for (const g of entry.rows) {
            parts.push(
                `## Prompt ${g.prompt_version === 'unversioned' ? 'version not recorded' : g.prompt_version}`,
                '',
                '| rank | model | thinking | capped score | score line | end reason |',
                '|---|---|---|---|---|---|'
            );
            for (const r of g.rows) {
                parts.push(
                    `| ${r.rank} | ${r.model} | ${r.thinking ?? '—'} | ${Math.round(r.capped)} | ${r.score_line} | ${r.end_reason ?? '—'} |`
                );
            }
            parts.push('');
        }
        if (entry.cost.length) {
            parts.push(
                '## Cost',
                '',
                '| model | thinking | cost usd | cost basis | tokens total |',
                '|---|---|---|---|---|'
            );
            for (const c of entry.cost)
                parts.push(
                    `| ${c.model} | ${c.thinking ?? '—'} | ${c.cost_usd} | ${c.cost_basis ?? '—'} | ${c.tokens_total ?? '—'} |`
                );
            parts.push('');
        }
        if (entry.plan.length) {
            parts.push('## Plan', '', '| model | thinking | plan provider |', '|---|---|---|');
            for (const p of entry.plan)
                parts.push(`| ${p.model} | ${p.thinking ?? '—'} | ${p.plan_provider} |`);
            parts.push('');
        }
    }
    return parts.join('\n') + '\n';
}

// ---- html -------------------------------------------------------------------------
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function scoreboardHtml(entry) {
    return entry.rows
        .map((g) => {
            const heading = `<h2>${esc(entry.instance_id)} — ${esc(entry.variant)} · Prompt ${
                g.prompt_version === 'unversioned' ? 'version not recorded' : esc(g.prompt_version)
            }</h2>`;
            const body = g.rows
                .map(
                    (r) => `          <tr${r.dimmed ? ' class="dim"' : ''}>
            <td class="rank">${r.rank}</td>
            <td class="model">${esc(r.model)}</td>
            <td>${r.thinking != null ? esc(String(r.thinking)) : '—'}</td>
            <td class="num">${Math.round(r.capped)}</td>
            <td>${esc(r.score_line)}</td>
            <td>${esc(r.end_reason ?? '—')}</td>
          </tr>`
                )
                .join('\n');
            return `${heading}
      <div class="scroller"><table>
        <thead>
          <tr><th>#</th><th>Model</th><th>Thinking</th><th class="num">Score</th><th>Score line</th><th>End reason</th></tr>
        </thead>
        <tbody>
${body}
        </tbody>
      </table></div>`;
        })
        .join('\n');
}
function costHtml(entry) {
    if (!entry.cost.length) return '';
    const body = entry.cost
        .map(
            (c) => `          <tr>
            <td class="model">${esc(c.model)}</td>
            <td>${c.thinking != null ? esc(String(c.thinking)) : '—'}</td>
            <td class="num">$${c.cost_usd}</td>
            <td>${esc(c.cost_basis ?? '—')}</td>
            <td class="num">${c.tokens_total ?? '—'}</td>
          </tr>`
        )
        .join('\n');
    return `<h2>Cost</h2>
      <div class="scroller"><table>
        <thead>
          <tr><th>Model</th><th>Thinking</th><th class="num">Cost (USD)</th><th>Basis</th><th class="num">Tokens total</th></tr>
        </thead>
        <tbody>
${body}
        </tbody>
      </table></div>`;
}
function planHtml(entry) {
    if (!entry.plan.length) return '';
    const body = entry.plan
        .map(
            (p) => `          <tr>
            <td class="model">${esc(p.model)}</td>
            <td>${p.thinking != null ? esc(String(p.thinking)) : '—'}</td>
            <td>${esc(p.plan_provider)}</td>
          </tr>`
        )
        .join('\n');
    return `<h2>Plan</h2>
      <div class="scroller"><table>
        <thead>
          <tr><th>Model</th><th>Thinking</th><th>Plan provider</th></tr>
        </thead>
        <tbody>
${body}
        </tbody>
      </table></div>`;
}
function renderPage(template, { nav, generated, scoreboard, cost, plan }) {
    // A function replacer, not a string, so a literal "$&"/"$`"/"$1" etc. in
    // row-derived text (invalid_reason, anomaly, judge notes) is inserted as
    // written, never interpreted as a String.replace substitution pattern.
    return template
        .replace('{{NAV}}', () => nav)
        .replace('{{GENERATED}}', () => esc(generated))
        .replace('{{SCOREBOARD}}', () => scoreboard)
        .replace('{{COST}}', () => cost)
        .replace('{{PLAN}}', () => plan);
}
function navAll(entries, current) {
    return (
        '<ul class="nav">' +
        entries
            .map((e) =>
                e === current
                    ? `<li>${esc(e.variant)}</li>`
                    : `<li><a href="${esc(e.instance_id)}-${esc(e.variant)}.html">${esc(e.variant)}</a></li>`
            )
            .join('') +
        '</ul>'
    );
}
function navScan() {
    return '<p class="nav"><a href="index.html">← Index</a></p>';
}
function indexScoreboard(entries) {
    return (
        '<ul class="nav">' +
        entries
            .map(
                (e) =>
                    `<li><a href="${esc(e.instance_id)}-${esc(e.variant)}.html">${esc(e.instance_id)} — ${esc(e.variant)}</a></li>`
            )
            .join('') +
        '</ul>'
    );
}

// ---- dispatch -----------------------------------------------------------------------
const written = [];

if (format === 'json') {
    const out = outArg || positional[0] || defaultOutPath('json');
    written.push(writeOut(out, JSON.stringify(model, null, 2) + '\n'));
} else if (format === 'md') {
    const out = outArg || positional[0] || defaultOutPath('md');
    written.push(writeOut(out, renderMd(model)));
} else if (format === 'csv') {
    const chosen = outArg || positional[0] || defaultOutPath('csv');
    if (taskEntries.length <= 1) {
        written.push(writeOut(chosen, renderCsv(taskEntries)));
    } else {
        const base = chosen.replace(/\.[^./\\]+$/, '');
        for (const e of taskEntries)
            written.push(writeOut(`${base}-${e.instance_id}-${e.variant}.csv`, renderCsv([e])));
    }
} else {
    const template = readFileSync(join(HERE, 'report-template.html'), 'utf8');
    if (navMode === 'single') {
        const destinations = [...(outArg ? [outArg] : []), ...positional];
        if (!destinations.length) destinations.push(defaultOutPath('html'));
        const entry = taskEntries[0];
        const html = renderPage(template, {
            nav: '',
            generated: model.generated,
            scoreboard: scoreboardHtml(entry),
            cost: costHtml(entry),
            plan: planHtml(entry),
        });
        for (const d of destinations) written.push(writeOut(d, html));
    } else if (navMode === 'all') {
        for (const entry of taskEntries) {
            const html = renderPage(template, {
                nav: navAll(taskEntries, entry),
                generated: model.generated,
                scoreboard: scoreboardHtml(entry),
                cost: costHtml(entry),
                plan: planHtml(entry),
            });
            const p = join(reportsDir(), `${entry.instance_id}-${entry.variant}.html`);
            written.push(writeOut(p, html));
        }
    } else {
        for (const entry of taskEntries) {
            const html = renderPage(template, {
                nav: navScan(),
                generated: model.generated,
                scoreboard: scoreboardHtml(entry),
                cost: costHtml(entry),
                plan: planHtml(entry),
            });
            const p = join(scanDir, `${entry.instance_id}-${entry.variant}.html`);
            written.push(writeOut(p, html));
        }
        const indexOut = outArg || positional[0] || join(scanDir, 'index.html');
        const indexPage = renderPage(template, {
            nav: '',
            generated: model.generated,
            scoreboard: indexScoreboard(taskEntries),
            cost: '',
            plan: '',
        });
        written.push(writeOut(indexOut, indexPage));
    }
}

console.log(written.join('\n'));
