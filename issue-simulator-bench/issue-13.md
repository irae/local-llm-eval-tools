# Issue 13 snapshot — the benchmark task text

Fetched 2026-09-01 with `gh issue view 13 --repo irae/mendel`. The issue
is locked on GitHub so the task cannot drift; a run prompt fetches the
live issue, and it must match this snapshot (compare the body sha256
below). Zero comments existed at snapshot time.

```
title:	Drop small dependencies with a native Node equivalent
state:	OPEN
author:	irae (Irae Carvalho)
labels:
comments:	0
assignees:
projects:
milestone:
issue-type:
parent:
sub-issues:
sub-issues-completed:
blocked-by:
blocking:
number:	13
--
Survey of small utility npm dependencies across the monorepo that have a clean native Node.js replacement. All replacements below are satisfied by the repo's declared Node floor (`>=22.22.2` at root/`mendel-pipeline`, `>=22.0.0` elsewhere).

## To do

### `uuid` → `crypto.randomUUID()`
- **Used in:** `examples/planout-example` only.
- **Call sites:** `examples/planout-example/app.js:9,27` — `const {v4: uuidv4} = require('uuid'); req.visitorId = uuidv4();`
- **Native replacement:** `crypto.randomUUID()` (from `node:crypto`).
- **Min Node:** 14.17.0 / 15.6.0.

### `xtend` → `Object.assign({}, a, b)`
- **Used in:** `mendel-core`, `mendel-config`.
- **Call sites:**
  - `packages/mendel-core/tree-hash-walker.js:67` — `xtend(this._result, {error: this.error})`
  - `packages/mendel-core/tree-variation-walker.js:61` — `xtend(MendelWalker.prototype.found.call(this), {...})`
  - `packages/mendel-config/index.js:53` — `xtend(fileConfig, config)`
  - `packages/mendel-config/legacy/index.js:14` — `xtend(defaults, config)`
- **Native replacement:** `Object.assign({}, source1, source2)` — note the empty-object first argument, since `xtend` never mutates either input while `Object.assign(target, ...)` mutates `target`. Object/array spread (`{...source1, ...source2}`) is an equally clean alternative.
- **Min Node:** `Object.assign` — ES2015, always available; object spread — Node 8.3+.

### `urlsafe-base64` → `Buffer` native `base64url` encoding
- **Used in:** `mendel-core` only.
- **Call sites:**
  - `packages/mendel-core/tree-serialiser.js:65` — `URLSafeBase64.encode(Concentrate.prototype.result.call(this))` (encodes a Buffer to a urlsafe-base64 string).
  - `packages/mendel-core/tree-deserialiser.js:51` — `URLSafeBase64.decode(treeHash)` (decodes a urlsafe-base64 string back to a Buffer).
- **Native replacement:** `buffer.toString('base64url')` for encode; `Buffer.from(treeHash, 'base64url')` for decode.
- **Min Node:** `base64url` encoding support — Node 15.7.0.

### `rimraf` → `fs.rmSync(path, {recursive: true, force: true})` / `fs.rm(...)`
- **Used in:** root, `mendel-pipeline`, `mendel-transform-less` — all in test files.
- **Call sites:**
  - `packages/mendel-transform-less/test/outlet-css.js:9-10` — `rimraf.sync(buildPath)`, `rimraf.sync(path.join(appPath, '.mendelipc'))`.
  - `packages/mendel-pipeline/test/helpers/index.js:45` — `rimraf.sync(runDir)`.
- **Native replacement:** `fs.rmSync(path, {recursive: true, force: true})` for the sync sites. `force: true` matters: `fs.rm`/`rmSync` throw on a non-existent path unless it's passed, while `rimraf` silently no-ops on a missing path by default.
- **Min Node:** `fs.rm`/`rmSync` recursive option — Node 14.14.0 (stabilized/no-warning by Node 16).

### `glob` → `fs.globSync` / `fs.promises.glob`
- **Used in:** `mendel-mocha-runner`, `mendel-development` (real usage); `mendel-deps` (test-only usage).
- **Call sites:**
  - `packages/mendel-mocha-runner/index.js:24` — `options.prelude = globSync(options.prelude)` (sync).
  - `packages/mendel-development/apply-extra-options.js:19,42,64` — promise form `glob(pattern).then(...)`, used to resolve `ignore`/`exclude`/`external` glob options that come from user-supplied bundler config (arbitrary patterns, not hardcoded).
  - `packages/mendel-deps/test/js.js:8,37`, `packages/mendel-deps/test/edge-case1.js:8`, `packages/mendel-deps/test/css.js:8` — simple `**/*.ext` patterns against fixture directories, test-only.
- **Native replacement:** `fs.globSync(pattern)` / `fs.promises.glob(pattern)` (from `node:fs`).
- **Min Node:** `fs.glob`/`fs.globSync` were added in Node 22 (exposed as of 22.0, fixes through 22.17), and remain **Stability: 1 – Experimental** as of the versions checked.
- Also note: `eslint.config.js` requires a package literally named `globals` (dictionary of ESLint global variable names) — unrelated to file globbing, not part of this item.

### `chalk` → `util.styleText(styles, text)`
- **Used in:** `mendel-pipeline` only, spread across 6 files.
- **Call sites:** `packages/mendel-pipeline/src/main.js:31`, `src/cli.js:74`, `src/cache/network/unix-socket.js:71,76`, `src/helpers/analytics/cli-printer.js:9,10,28,57,129,139,146,156,157`.
- **Native replacement:** `util.styleText(['blue', 'dim'], text)` etc. from `node:util`. `cli-printer.js:28` does `chalk.level = options.enableColor !== false ? 3 : 0;` — an explicit runtime on/off switch with no direct `styleText` equivalent (it auto-detects TTY/`NO_COLOR` via a `validateStream` option instead), so that call site needs a small redesign rather than a 1:1 swap.
- **Min Node:** introduced experimental in Node 20.12.0, marked stable in Node 22.13.0.

### `tmp` → `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`
- **Used in:** `mendel-manifest-extract-bundles`, `mendel-development`, `mendel-manifest-uglify`.
- **Call sites (all the same pattern):** `tmp.dirSync().name` — `packages/mendel-manifest-extract-bundles/test/manifest-extract.js:15`, `packages/mendel-development/validate-manifest.js:55`, `packages/mendel-development/test/post-process-manifest.js:12`, `packages/mendel-manifest-uglify/test/manifest-uglify.js:15`.
- **Native replacement:** `fs.mkdtempSync(path.join(os.tmpdir(), 'mendel-'))`. `tmp` also registers a `process.on('exit', ...)` handler that auto-removes every directory it created; none of these call sites clean up explicitly, so the swap needs an added `fs.rmSync(dir, {recursive: true, force: true})` in an `after`/teardown hook, not just a search-and-replace.
- **Min Node:** `fs.mkdtempSync` — Node 5.10.0.

### `shasum` → `crypto.createHash('sha1')`
- **Used in:** `mendel-development`, `mendel-outlet-manifest`.
- **Call sites:** `packages/mendel-development/mendelify-transform-stream.js:62` — `shasum(row.source)`; `packages/mendel-outlet-manifest/src/index.js:65` — `shasum(item.source)`.
- **Native replacement:** `crypto.createHash('sha1').update(source).digest('hex')` — `shasum`'s default algorithm is SHA-1. Confirm `row.source`/`item.source` are always strings/Buffers at both call sites before swapping: `shasum` also accepts non-string/Buffer values and stable-stringifies them first, which `crypto.createHash` does not do on its own.

## Looked at, not to be done

- `fs-extra` (`legacy-packages/mendel-requirify`)
- `temp` (`legacy-packages/mendel-requirify`)
- `async` (`mendel-development`, `mendel-treenherit`)
- `path-to-regexp`, `commander`, `chokidar`, `resolve`, `browser-resolve`, `postcss`, `minimatch`, `debug`, `concentrate`, `dissolve`, `through2`, `falafel`
- `globals` (in `eslint.config.js`) — the ESLint global-variable-names package, unrelated to the `glob` file-matching package despite the similar name
- `packages/mendel-deps/test/js-fixtures/es5/foo/browser.js:2` — `require('glob')` here is fixture data for the dependency-graph parser, not real glob usage
- `object-assign`, `array-flatten`/`flatten`, `array-unique`/`uniq`, `deep-equal`/`fast-deep-equal`, `once`, `lodash.*`, `pify`, `dotenv`, `node-fetch`, `abort-controller`, a `structuredClone`-shaped manual deep-clone package, `mkdirp-classic`, `del` — not found anywhere in the monorepo

```

sha256 of the fetch above: d3a43709c4906dbed86a231c4c87ad8623df1048f931c05b3508bed717b92c66
