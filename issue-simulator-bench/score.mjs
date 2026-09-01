#!/usr/bin/env node
// Computes the mechanical part of the RUBRIC verification battery and writes
// an evidence pack, so the scorer's judgement surface shrinks to defect
// severity and criteria 1, 6, 8, 9.
//
//   node score.mjs <branch> [--session <file.jsonl>] [--meta <file.json>]
//        [--worktree <dir>] [--out <file>]
//
// Without --worktree it computes everything git and the logs can answer:
// static completeness, lockfile shrink, commit craft facts, root devDeps,
// TASKS.md leak, session-log habits (truncation share, --no-verify,
// git add -A, full-suite cadence), nudge counts. With --worktree it also
// runs the runtime checks (prettier, eslint, trap A repro, tap suites) in
// that worktree. The pack is evidence, not a verdict: every number sits next
// to the raw lines it came from.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(dir, '..');

const args = { _: [] };
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
    else args._.push(a);
}
const branch = args._[0];
if (!branch) {
    console.error(
        'usage: score.mjs <branch> [--session f] [--meta f] [--worktree d] [--out f]'
    );
    process.exit(2);
}

const git = (...a) =>
    execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 64e6 });
const tryGit = (...a) => {
    try {
        return git(...a);
    } catch (e) {
        return `git-error: ${e.message.split('\n')[0]}`;
    }
};

const DEPS = [
    'uuid',
    'xtend',
    'urlsafe-base64',
    'rimraf',
    'glob',
    'chalk',
    'tmp',
    'shasum',
];
const FIXTURE = 'js/es5/foo/browser.js';
const base = tryGit('merge-base', branch, 'master').trim();

const evidence = {
    branch,
    base,
    generated: new Date().toISOString(),
    static_completeness: null,
    lockfile: null,
    root_devdeps: null,
    commit_craft: null,
    session_habits: null,
    runner: null,
    runtime_checks: null,
};

// ---- static completeness (criterion 2) -------------------------------------
{
    const re = `require\\('(${DEPS.join('|')})'\\)`;
    const codeRaw = tryGit('grep', '-nE', re, branch, '--', '*.js').toString();
    const code = codeRaw
        .split('\n')
        .filter(Boolean)
        .filter((l) => !l.includes(FIXTURE));
    const pkgRe = `"(${DEPS.join('|')})":`;
    let pkg = [];
    try {
        pkg = git(
            'grep',
            '-nE',
            pkgRe,
            branch,
            '--',
            '*/package.json',
            'package.json'
        )
            .split('\n')
            .filter(Boolean)
            // devDependency tools of the repo itself are not the eight targets
            .filter((l) => !/eslint|prettier|husky|lint-staged/.test(l));
    } catch {
        pkg = [];
    }
    evidence.static_completeness = {
        stale_requires: code,
        stale_package_json: pkg,
        clean: code.length === 0 && pkg.length === 0,
        note: `fixture ${FIXTURE} excluded where present`,
    };
}

// ---- lockfile (criterion 3, partial) ---------------------------------------
{
    const stat = tryGit(
        'diff',
        '--numstat',
        `${base}..${branch}`,
        '--',
        'pnpm-lock.yaml'
    ).trim();
    const m = stat.match(/^(\d+)\s+(\d+)/);
    evidence.lockfile = {
        numstat: stat || 'no change',
        added: m ? Number(m[1]) : 0,
        removed: m ? Number(m[2]) : 0,
        shrank: m ? Number(m[2]) > Number(m[1]) : false,
    };
}

// ---- root devDependencies (criteria 1/5 note) ------------------------------
{
    let root = {};
    try {
        root = JSON.parse(git('show', `${branch}:package.json`));
    } catch {
        root = null;
    }
    const dev = root ? { ...root.dependencies, ...root.devDependencies } : {};
    const left = DEPS.filter((d) => dev && d in dev);
    evidence.root_devdeps = {
        still_declared: left,
        removed: left.length === 0,
    };
}

// ---- commit craft (criterion 5 facts) --------------------------------------
{
    const log = tryGit('log', '--format=%H%x09%s', `${base}..${branch}`)
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            const [hash, subject] = l.split('\t');
            return { hash, subject };
        })
        .reverse();
    const perCommit = log.map((c) => {
        const files = tryGit('show', '--name-only', '--format=', c.hash)
            .split('\n')
            .filter(Boolean);
        const pkgs = new Set(
            files
                .filter((f) => f !== 'pnpm-lock.yaml')
                .map((f) => {
                    const m = f.match(
                        /^(packages|legacy-packages|examples)\/([^/]+)\//
                    );
                    return m ? `${m[1]}/${m[2]}` : 'root';
                })
        );
        return {
            hash: c.hash.slice(0, 7),
            subject: c.subject,
            chore: /^chore(\(|:)/.test(c.subject),
            packages: [...pkgs],
            tasks_md: files.includes('TASKS.md'),
        };
    });
    evidence.commit_craft = {
        commits: perCommit.length,
        non_chore: perCommit.filter((c) => !c.chore).map((c) => c.subject),
        multi_package: perCommit
            .filter((c) => c.packages.filter((p) => p !== 'root').length > 1)
            .map((c) => `${c.hash} ${c.subject} [${c.packages.join(', ')}]`),
        tasks_md_leak: perCommit.filter((c) => c.tasks_md).map((c) => c.hash),
        per_commit: perCommit,
    };
}

// ---- session habits (criteria 4/7/10 facts) --------------------------------
if (args.session && existsSync(args.session)) {
    const cmds = [];
    for (const line of readFileSync(args.session, 'utf8').split('\n')) {
        if (!line.includes('toolCall')) continue;
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const blocks = e.message?.content || [];
        for (const b of blocks)
            if (
                b.type === 'toolCall' &&
                b.name === 'bash' &&
                b.arguments?.command
            )
                cmds.push(b.arguments.command);
    }
    const noisy = cmds.filter((c) =>
        /\b(pnpm|npm|npx|tap|node|git (log|diff|show)|eslint|prettier)\b/.test(
            c
        )
    );
    const truncated = noisy.filter((c) =>
        /\|\s*(tail|head)\b|>\s*\S+\.(log|txt)/.test(c)
    );
    evidence.session_habits = {
        bash_commands: cmds.length,
        noisy_commands: noisy.length,
        truncated_noisy: truncated.length,
        truncation_share: noisy.length
            ? Math.round((100 * truncated.length) / noisy.length)
            : null,
        no_verify: cmds.filter((c) => c.includes('--no-verify')),
        git_add_all: cmds.filter((c) => /git add (-A|--all|\.)(\s|$)/.test(c)),
        full_suite_runs: cmds.filter((c) =>
            /pnpm (run )?unit|pnpm test\b/.test(c)
        ).length,
        commit_cmds: cmds.filter((c) => /git commit/.test(c)).length,
        lint_self_runs: cmds.filter((c) => /prettier --check|eslint /.test(c))
            .length,
    };
} else {
    evidence.session_habits = args.session
        ? `session file not found: ${args.session}`
        : 'no --session given';
}

// ---- runner meta (nudges, end reason) --------------------------------------
if (args.meta && existsSync(args.meta)) {
    const m = JSON.parse(readFileSync(args.meta, 'utf8'));
    evidence.runner = {
        end_reason: m.end_reason,
        nudges_tooling: m.nudges?.tooling?.length ?? null,
        nudges_model: m.nudges?.model?.length ?? null,
        model_nudge_causes: (m.nudges?.model || []).map((n) => n.cause),
        baseline_dirty: m.baseline_dirty,
        warnings: m.warnings,
        thinking_level: m.thinking_level,
    };
} else {
    evidence.runner = args.meta
        ? `meta file not found: ${args.meta}`
        : 'no --meta given';
}

// ---- runtime checks (need a worktree) --------------------------------------
if (args.worktree) {
    const wt = resolve(args.worktree);
    const run = (cmd, a) => {
        try {
            return {
                ok: true,
                out: execFileSync(cmd, a, {
                    cwd: wt,
                    encoding: 'utf8',
                    maxBuffer: 64e6,
                })
                    .trim()
                    .slice(0, 2000),
            };
        } catch (e) {
            return {
                ok: false,
                out: `${(e.stdout || '') + (e.stderr || '')}`
                    .trim()
                    .slice(0, 2000),
            };
        }
    };
    const repro = join('/tmp', `repro-glob-${process.pid}.js`);
    writeFileSync(
        repro,
        `const applyExtraOptions = require(process.argv[2] + '/packages/mendel-development/apply-extra-options.js');
const b = { _pending: 0, _ready: true, ignore(){}, exclude(){}, external(){}, require(){}, emit(){} };
try { applyExtraOptions(b, {ignore: ['packages/*/index.js']}); console.log('SYNC OK, pending=', b._pending); }
catch (e) { console.log('THREW:', e.constructor.name, e.message); }
`
    );
    evidence.runtime_checks = {
        prettier: run(join(wt, 'node_modules/.bin/prettier'), ['--check', '.']),
        eslint: run(join(wt, 'node_modules/.bin/eslint'), ['.']),
        trap_a: run('node', [repro, wt]),
    };
} else {
    evidence.runtime_checks =
        'no --worktree given — run prettier/eslint/trap A/tap there per RUBRIC.md';
}

const out = args.out || join(dir, 'runs', `${branch}-evidence.json`);
writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
const sc = evidence.static_completeness;
console.log(
    [
        `evidence: ${out}`,
        `static: ${sc.clean ? 'clean' : `${sc.stale_requires.length} requires, ${sc.stale_package_json.length} package.json`}`,
        `lockfile: -${evidence.lockfile.removed}/+${evidence.lockfile.added}`,
        `root devDeps left: ${evidence.root_devdeps.still_declared.join(',') || 'none'}`,
        `commits: ${evidence.commit_craft.commits} (${evidence.commit_craft.non_chore.length} non-chore, ${evidence.commit_craft.multi_package.length} multi-package, ${evidence.commit_craft.tasks_md_leak.length} TASKS.md leaks)`,
        typeof evidence.session_habits === 'object'
            ? `truncation: ${evidence.session_habits.truncation_share}% · full suites: ${evidence.session_habits.full_suite_runs} vs ${evidence.session_habits.commit_cmds} commits`
            : evidence.session_habits,
    ].join('\n')
);
