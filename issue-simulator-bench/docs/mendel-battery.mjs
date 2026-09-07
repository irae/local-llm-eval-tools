#!/usr/bin/env node
// Scratch relocation of Mendel's own verification battery, moved out of
// score.mjs so the generic scorer has no Mendel-specific logic left in it.
// Not imported or run by anything in this repository. Task 10 rebuilds
// Mendel's task folder from this file; until then it exists only so the
// logic is not lost.
//
//   node mendel-battery.mjs <worktree> <branch> <base-sha>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [worktree, branch, base] = process.argv.slice(2);
if (!worktree || !branch || !base) {
    console.error('usage: mendel-battery.mjs <worktree> <branch> <base-sha>');
    process.exit(2);
}

const git = (...a) =>
    execFileSync('git', a, { cwd: worktree, encoding: 'utf8', maxBuffer: 64e6 });
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

const result = {
    static_completeness: null,
    lockfile: null,
    root_devdeps: null,
    commit_craft: null,
    session_habits: null,
    runtime_checks: null,
};

// ---- static completeness (criterion 2) -------------------------------------
{
    const re = `require\\('(${DEPS.join('|')})'\\)`;
    const codeRaw = tryGit('grep', '-nE', re, 'HEAD', '--', '*.js').toString();
    const code = codeRaw
        .split('\n')
        .filter(Boolean)
        .filter((l) => !l.includes(FIXTURE));
    const pkgRe = `"(${DEPS.join('|')})":`;
    let pkg = [];
    try {
        pkg = git('grep', '-nE', pkgRe, 'HEAD', '--', '*/package.json', 'package.json')
            .split('\n')
            .filter(Boolean)
            // devDependency tools of the repo itself are not the eight targets
            .filter((l) => !/eslint|prettier|husky|lint-staged/.test(l));
    } catch {
        pkg = [];
    }
    result.static_completeness = {
        stale_requires: code,
        stale_package_json: pkg,
        clean: code.length === 0 && pkg.length === 0,
        note: `fixture ${FIXTURE} excluded where present`,
    };
}

// ---- lockfile (criterion 3, partial) ---------------------------------------
{
    const stat = tryGit('diff', '--numstat', `${base}..HEAD`, '--', 'pnpm-lock.yaml').trim();
    const m = stat.match(/^(\d+)\s+(\d+)/);
    result.lockfile = {
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
        root = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8'));
    } catch {
        root = null;
    }
    const dev = root ? { ...root.dependencies, ...root.devDependencies } : {};
    const left = DEPS.filter((d) => dev && d in dev);
    result.root_devdeps = {
        still_declared: left,
        removed: left.length === 0,
    };
}

// ---- commit craft, package grouping (criterion 5 facts) --------------------
{
    const log = tryGit('log', '--format=%H%x09%s', `${base}..HEAD`)
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
                    const m = f.match(/^(packages|legacy-packages|examples)\/([^/]+)\//);
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
    result.commit_craft = {
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
// The session file is not one of this script's positional arguments; a
// future caller passes it as an extra argument if it wants this section.
{
    const sessionFile = process.argv[5];
    if (sessionFile && existsSync(sessionFile)) {
        const cmds = [];
        for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
            if (!line.includes('toolCall') && !line.includes('tool_use')) continue;
            let e;
            try {
                e = JSON.parse(line);
            } catch {
                continue;
            }
            const blocks = e.message?.content || [];
            for (const b of blocks) {
                if (
                    b.type === 'toolCall' &&
                    b.name === 'bash' &&
                    typeof b.arguments?.command === 'string'
                )
                    cmds.push(b.arguments.command);
                if (
                    b.type === 'tool_use' &&
                    b.name === 'Bash' &&
                    typeof b.input?.command === 'string'
                )
                    cmds.push(b.input.command);
            }
        }
        const noisy = cmds.filter((c) =>
            /\b(pnpm|npm|npx|tap|node|git (log|diff|show)|eslint|prettier)\b/.test(c)
        );
        const truncated = noisy.filter((c) =>
            /\|\s*(tail|head)\b|>\s*\S+\.(log|txt)/.test(c)
        );
        result.session_habits = {
            bash_commands: cmds.length,
            noisy_commands: noisy.length,
            truncated_noisy: truncated.length,
            truncation_share: noisy.length
                ? Math.round((100 * truncated.length) / noisy.length)
                : null,
            full_suite_runs: cmds.filter((c) => /pnpm (run )?unit|pnpm test\b/.test(c)).length,
            lint_self_runs: cmds.filter((c) => /prettier --check|eslint /.test(c)).length,
        };
    } else {
        result.session_habits = 'no session file given (pass it as a 4th argument)';
    }
}

// ---- runtime checks (prettier, eslint, trap A repro) ------------------------
{
    const run = (cmd, a) => {
        try {
            return {
                ok: true,
                out: execFileSync(cmd, a, {
                    cwd: worktree,
                    encoding: 'utf8',
                    maxBuffer: 64e6,
                })
                    .trim()
                    .slice(0, 2000),
            };
        } catch (e) {
            return {
                ok: false,
                out: `${(e.stdout || '') + (e.stderr || '')}`.trim().slice(0, 2000),
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
    result.runtime_checks = {
        prettier: run(join(worktree, 'node_modules/.bin/prettier'), ['--check', '.']),
        eslint: run(join(worktree, 'node_modules/.bin/eslint'), ['.']),
        trap_a: run('node', [repro, worktree]),
    };
}

console.log(JSON.stringify(result));
