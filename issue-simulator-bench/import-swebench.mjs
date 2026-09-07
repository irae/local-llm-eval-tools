#!/usr/bin/env node
// Builds a task folder from one SWE-bench instance record.
//
//   node import-swebench.mjs <instance.json> [--to <dir>]
//
// Writes task.json, issue.md, prompts/default.txt, agents.md, battery.mjs
// and rubric.md into the target directory (default: ./<instance_id>).

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

// ---- args -------------------------------------------------------------------
// Every argv token is --to with its value, or the one positional instance
// file. Anything else is its own error, exit 2.
let toDir = null;
const positional = [];
{
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--to') {
            if (i + 1 >= argv.length) {
                console.error('error: --to requires a value');
                process.exit(2);
            }
            toDir = argv[++i];
            continue;
        }
        if (a.startsWith('--') || positional.length >= 1) {
            console.error(`error: unknown argument ${a}`);
            process.exit(2);
        }
        positional.push(a);
    }
}
const instancePath = positional[0];
if (!instancePath) {
    console.error('error: usage: import-swebench.mjs <instance.json> [--to <dir>]');
    process.exit(2);
}

// ---- read the instance record ------------------------------------------------
let raw;
try {
    raw = readFileSync(instancePath, 'utf8');
} catch (e) {
    console.error(`error: cannot read ${instancePath}: ${e.message}`);
    process.exit(2);
}
let instance;
try {
    instance = JSON.parse(raw);
} catch (e) {
    console.error(`error: cannot parse ${instancePath}: ${e.message}`);
    process.exit(2);
}

for (const field of ['instance_id', 'repo', 'base_commit', 'problem_statement']) {
    if (instance[field] == null) {
        console.error(`error: instance record missing '${field}'`);
        process.exit(2);
    }
}

const targetDir = toDir || instance.instance_id;
const version = instance.version ?? '1';

// ---- task.json ----------------------------------------------------------------
const manifest = {
    instance_id: instance.instance_id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    problem_statement: 'issue.md',
    version,
    FAIL_TO_PASS: instance.FAIL_TO_PASS ?? [],
    PASS_TO_PASS: instance.PASS_TO_PASS ?? [],
};
for (const field of [
    'hints_text',
    'created_at',
    'patch',
    'test_patch',
    'environment_setup_commit',
]) {
    if (instance[field] !== undefined && instance[field] !== null) manifest[field] = instance[field];
}
manifest.test_cmd =
    "echo 'set test_cmd in task.json before running this task' && exit 1";
manifest.battery = 'node battery.mjs';
manifest.agents_file = 'agents.md';
manifest.variants = {
    default: {
        prompt: 'prompts/default.txt',
        version,
        branch_suffix: `-${instance.instance_id}`,
        worktree_prefix: 'swebench-bench-',
        results: 'results-default.json',
    },
};

// ---- issue.md, prompts/default.txt, agents.md, rubric.md ----------------------
const problemStatement = instance.problem_statement.endsWith('\n')
    ? instance.problem_statement
    : instance.problem_statement + '\n';

const defaultPrompt =
    'Fix the issue described in `issue.md`. Read it first, then make the smallest correct change.\n\n' +
    problemStatement;

const agents =
    'Work only inside this repository.\n' +
    'Read issue.md before you start.\n' +
    'Run the tests before you stop.\n';

const rubric =
    'This task was imported from a SWE-bench instance record.\n' +
    'It has no judge rubric yet: SWE-bench only defines pass/fail test lists.\n' +
    'Add your own criteria here if a judge should weigh in on this task.\n';

// ---- battery.mjs ----------------------------------------------------------------
const battery = `#!/usr/bin/env node
// Runs the task's FAIL_TO_PASS/PASS_TO_PASS test ids with test_cmd, generated
// by import-swebench.mjs from a SWE-bench instance record.
//
//   node battery.mjs <worktree-or-artifact-path> <branch> <base-sha>

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const task = JSON.parse(readFileSync(join(here, 'task.json'), 'utf8'));
const cwd = process.argv[2];

const ids = [...new Set([...(task.FAIL_TO_PASS || []), ...(task.PASS_TO_PASS || [])])];

function shellQuote(s) {
    return "'" + s.replace(/'/g, "'\\\\''") + "'";
}

const tests = {};
for (const id of ids) {
    try {
        execSync(\`\${task.test_cmd} \${shellQuote(id)}\`, {
            cwd,
            encoding: 'utf8',
            maxBuffer: 64e6,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        tests[id] = true;
    } catch (e) {
        tests[id] = false;
    }
}

console.log(JSON.stringify({ tests }));
`;

// ---- write the task folder ----------------------------------------------------
mkdirSync(join(targetDir, 'prompts'), { recursive: true });
writeFileSync(join(targetDir, 'task.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(targetDir, 'issue.md'), problemStatement);
writeFileSync(join(targetDir, 'prompts', 'default.txt'), defaultPrompt);
writeFileSync(join(targetDir, 'agents.md'), agents);
writeFileSync(join(targetDir, 'rubric.md'), rubric);
const batteryPath = join(targetDir, 'battery.mjs');
writeFileSync(batteryPath, battery);
chmodSync(batteryPath, 0o755);

console.log(targetDir);
