# update-deps

Update npm dependencies across many app repositories from a CLI **or** a local UI server.

Zero third-party dependencies for Node and UI (HTML / CSS / JS only). Requires **Node.js 24+**.

---

## What it does

For each app repo:

1. Clones the repo from a git URL template (`{app}` placeholder)
2. Finds every `package-lock.json` (skips `node_modules` / `.git`)
3. Detects outdated **direct** dependencies (`npm outdated`)
4. Updates selected packages (CLI: all outdated; UI: user selection)
5. Runs `lint` / `test` / `build` when those scripts exist
6. Commits and pushes a new branch: `chore/deps-update-YYYYMMDD`  
   (a clock suffix is added when that name already exists locally or on the remote; never onto `main`, `master`, or the configured base branch)

---

## Install

```bash
# from this repo
npm install
npm link          # optional: expose `update-deps` on PATH
```

Or run directly:

```bash
node bin/update-deps.mjs --help
```

---

## Requirements

| Requirement | Notes |
|-------------|--------|
| Node.js `>=24` | Uses modern Node APIs (`node:http`, `AbortSignal`, etc.) |
| `git` on PATH | Clone / branch / push |
| `npm` on PATH | `ci`, `outdated`, `update`, `install`, `run` |
| Network + credentials | HTTPS or SSH clone/push to your org remotes |

---

## CLI usage

```bash
update-deps \
  --git-url 'https://github.com/org/{app}.git' \
  --base-branch develop \
  --apps checkout-ui,cart-ui \
  --apps catalog-ui \
  --concurrency 3
```

### Required flags

| Flag | Description |
|------|-------------|
| `--git-url <template>` | Clone URL containing `{app}` **exactly once**. `https://` or `git@` only. |
| `--base-branch <name>` | Branch to clone from. Commits never land on this branch, `main`, or `master`. |
| `--apps <name>` | App name(s). Repeatable; comma-separated values also work. |

### Optional flags

| Flag | Default | Description |
|------|---------|-------------|
| `--include-pins` | off | Also move exact pins (`1.2.3`) to newest same-major via `npm view` + exact install |
| `--concurrency <n>` | `3` | How many apps scan or update at once |
| `--timeout <ms>` | `1200000` | Per-app time budget |
| `--work-dir <path>` | temp dir | Where clones live |
| `--dry-run` | off | Plan updates only; no write / check / commit / push |
| `--help` | | Show help |

### CLI examples

```bash
# dry-run
update-deps --git-url 'git@github.com:org/{app}.git' --base-branch main \
  --apps starter-app --dry-run

# include exact pins
update-deps --git-url 'https://github.com/org/{app}.git' --base-branch develop \
  --apps a,b --include-pins --concurrency 2
```

---

## UI server (`serve`)

```bash
update-deps serve \
  --git-url 'https://github.com/org/{app}.git' \
  --base-branch develop \
  --apps starter-app,checkout-ui \
  --concurrency 2 \
  --port 3847 \
  --work-dir ./work
```

Then open: `http://127.0.0.1:3847`

Same shared flags as CLI, plus:

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `3847` | UI listen port (bound to `127.0.0.1`) |

### UI behavior

**Startup (scan)**  
- Clones apps with the same `--concurrency` cap used for updates. A leftover app folder is deleted first, then cloned from the base branch  
- Builds inventory: app → lockfile path → libs (`current` → `available`)  
- Streams progress over SSE so the inventory fills in live  

**Selection**  
- Checkbox per lib, per lockfile, or per app (indeterminate when partial)  
- Exact pins (when `--include-pins`) show a **Pinned** badge before the version  

**Update job**  
- Submit runs updates only for selected packages  
- Concurrency applies here: extra apps stay **Queued**  
- Stages: Queued → Branching → Updating → Installing → Lint → Test → Build → Committing → Pushing → Done  

**Rescan**  
- Per-app reload icon re-clones that app from the base branch and refreshes inventory  
- Clears that app’s Progress panel entry and its package selections  

**Logs**  
- Header **Logs** toggle shows live server logs (also printed to the terminal)  
- Follows OS light/dark theme (`prefers-color-scheme`); no theme toggle  

### Safety rules (CLI + UI)

- Refuses commit/push to `main`, `master`, or `--base-branch`
- Push uses `HEAD:refs/heads/<update-branch>` (no force-push)
- After `npm update`, quality reinstall uses `npm install` (not `npm ci`) so lockfile sync issues are avoided

---

## HTTP API (serve mode)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Static UI |
| `GET` | `/api/state` | Snapshot (config, apps inventory, job, logs) |
| `GET` | `/api/events` | SSE stream |
| `POST` | `/api/run` | Start update job: `{ "selections": { "<app>": { "<lockRel>": ["pkg"] } } }` |
| `POST` | `/api/rescan` | Rescan one app: `{ "app": "starter-app" }` |
| `POST` | `/api/cancel` | Abort in-flight update job |

### SSE events

| Event | Meaning |
|-------|---------|
| `state` | Full snapshot (connect / reconnect) |
| `phase` | `scanning` / `ready` / `updating` |
| `scan.app` | Per-app scan progress or inventory |
| `scan.done` | Initial scan finished |
| `rescan.start` / `rescan.done` | Per-app reload lifecycle |
| `job.start` / `job.app` / `job.done` | Update job lifecycle |
| `log` | Structured log line |

---

## Project layout

```
bin/update-deps.mjs     # executable entry
update-deps.mjs         # CLI main + re-exports
lib/core.mjs            # shared helpers (parse, git safety, pool, logging)
lib/scan.mjs            # scanApp / rescanApp / scanAllApps
lib/update.mjs          # runRepo (CLI) / updateSelectedApp (UI)
lib/server.mjs          # HTTP + SSE server
public/                 # vanilla UI (index.html, styles.css, app.js)
update-deps.test.mjs    # node:test suite (no third-party test libs)
package.json
```

---

## Architecture (high level)

```text
CLI path:   parseCli → mapPool(concurrency) → runRepo → summarize
UI path:    parseCli(serve) → startServer
              ├─ scanAllApps (mapPool concurrency, fresh base-branch clone)
              ├─ POST /api/run → mapPool(concurrency) → updateSelectedApp
              └─ POST /api/rescan → rescanApp (rm clone + scanApp)
```

---

## Scripts

```bash
npm test                 # node --test update-deps.test.mjs
npm start                # bin serve (still needs flags via args / env wiring)
node bin/update-deps.mjs --help
```

---

## Testing

Uses built-in `node:test` and `node:assert` only.

```bash
npm test
```

### Coverage map

| Area | Tests |
|------|--------|
| Git URL / branch safety | `repoUrl`, `assertSafeBranch`, `pushRefspec` |
| Outdated classification | ranged vs pins, nested packages ignored |
| Lockfile discovery | skips `node_modules`, nested locks |
| Quality scripts | run vs skipped |
| Changed files filter | manifests + locks only |
| CLI parsing | apps list, serve/`--port`, validation errors |
| Concurrency | `mapPool` never exceeds limit |
| Progress (CLI) | non-TTY lines |
| Full CLI repo flow | `runRepo` update + quality + push (mocked) |
| Scan inventory | current/available; pins when `--include-pins` |
| Selective UI update | only selected packages; up-to-date path |
| Post-update install | uses `npm install` (not `npm ci`) for quality |
| Rescan | deletes stale clone then rescans |
| Selections helpers | normalize + app list |
| Server snapshot / SSE | `serializeState`, `createSseHub` |
| Logging / errors | `formatError`, `createLogger` |
| Branch / commit helpers | `updateBranchName`, `commitMessage`, `isSuccess`, `summarize` |

Mocks replace real `git` / `npm` via the injectable `run` function so tests stay offline and fast.

---

## Notes

- Only `package-lock.json` projects are supported (npm).
- Direct dependencies only (deps / devDeps / optionalDeps in the adjacent `package.json`).
- No auth UI — use your local git credentials / SSH agent.
- Clones are kept under `--work-dir` (or a temp dir) for the life of the serve process so updates can reuse them.
