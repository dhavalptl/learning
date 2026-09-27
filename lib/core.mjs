import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, styleText } from 'node:util';

export const APP_NAME = /^[A-Za-z0-9._-]+$/;
export const EXACT_PIN = /^=?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const BLOCKED_BRANCHES = new Set(['master', 'main']);
export const QUALITY_SCRIPT_NAMES = ['lint', 'test', 'build'];
export const OUTPUT_LIMIT = 120_000;

export const JOB_STAGES = [
  'queued',
  'branching',
  'updating',
  'installing',
  'lint',
  'test',
  'build',
  'committing',
  'pushing',
  'done',
];

export const HELP = `Update direct dependencies in many app repos and push a new branch.

Usage:
  update-deps --git-url <template> --base-branch <name> --apps <name> [--apps <name>]
  update-deps serve --git-url <template> --base-branch <name> --apps <name> [options]

Required:
  --git-url <template>     Clone URL containing {app} once.
                           Example: https://github.com/org/{app}.git
  --base-branch <name>     Branch to clone. Commits never land on this branch,
                           master, or main.
  --apps <name>            App name, repeatable. Comma-separated values are also accepted.

Options:
  --include-pins           Move exact pins to the newest same-major version.
  --concurrency <n>        Repos running at once during updates. Default: 3.
  --timeout <ms>           Time budget for one repo. Default: 1200000.
  --work-dir <path>        Clone root. Default: a temporary directory.
  --dry-run                Show the update list. Do not write, check, commit, or push.
  --port <n>               UI server port (serve only). Default: 3847.
  --help                   Show this help.

Without --include-pins, only packages behind the wanted version in npm outdated
are updated. Lockfiles under node_modules are ignored. lint, test, and build run
before the commit when a folder defines that script.
`;

export function repoUrl(template, app) {
  if (!APP_NAME.test(app)) throw new Error(`Invalid app name: ${app}`);
  const placeholders = template.match(/\{app\}/g) ?? [];
  if (placeholders.length !== 1) throw new Error('git URL must contain {app} exactly once');
  if (!template.startsWith('https://') && !template.startsWith('git@')) {
    throw new Error('git URL must start with https:// or git@');
  }
  return template.replace('{app}', app);
}

export function assertSafeBranch(branch, baseBranch) {
  if (typeof branch !== 'string' || branch.length === 0 || branch === 'HEAD') {
    throw new Error(`Refusing to use branch ${String(branch)}`);
  }
  if (BLOCKED_BRANCHES.has(branch) || branch === baseBranch) {
    throw new Error(`Refusing to commit or push branch ${branch}`);
  }
}

export function pushRefspec(updateBranch, baseBranch) {
  assertSafeBranch(updateBranch, baseBranch);
  if (updateBranch.includes('..') || updateBranch.startsWith('-') || /\s/.test(updateBranch)) {
    throw new Error(`Invalid update branch: ${updateBranch}`);
  }
  return `HEAD:refs/heads/${updateBranch}`;
}

export function updateBranchName(date = new Date(), withTime = false) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const branch = `chore/deps-update-${year}${month}${day}`;
  if (!withTime) return branch;
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${branch}-${hours}${minutes}${seconds}`;
}

export function isExactPin(spec) {
  return EXACT_PIN.test(String(spec));
}

export function pinRange(current) {
  const match = String(current).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid version: ${current}`);
  if (Number(match[1]) === 0) return `~${match[1]}.${match[2]}.${match[3]}`;
  return `^${match[1]}.${match[2]}.${match[3]}`;
}

export function classifyOutdated(manifest, outdated, { includePins = false } = {}) {
  const specs = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  const ranged = [];
  const pins = [];
  for (const [name, info] of Object.entries(outdated ?? {})) {
    if (!Object.hasOwn(specs, name)) continue;
    const spec = specs[name];
    if (typeof spec !== 'string' || spec.includes(':')) continue;
    if (isExactPin(spec)) {
      if (includePins && info?.current) pins.push({ name, current: info.current });
      continue;
    }
    if (info?.current !== info?.wanted) ranged.push(name);
  }
  ranged.sort();
  pins.sort((left, right) => left.name.localeCompare(right.name));
  return { ranged, pins };
}

export function parseViewVersion(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) return '';
  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) return String(parsed.at(-1) ?? '');
  return String(parsed);
}

export function qualityScripts(manifest) {
  const scripts = manifest.scripts ?? {};
  const run = [];
  const skipped = [];
  for (const name of QUALITY_SCRIPT_NAMES) {
    if (typeof scripts[name] === 'string' && scripts[name].length > 0) run.push(name);
    else skipped.push(name);
  }
  return { run, skipped };
}

export async function discoverLockfiles(root) {
  const locks = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name === 'package-lock.json') locks.push(full);
    }
  }
  await walk(root);
  return locks.sort().map((lockPath) => {
    const dirRel = toPosix(path.relative(root, path.dirname(lockPath)));
    const folder = dirRel === '' ? '' : dirRel;
    return {
      dirRel: folder,
      lockRel: toPosix(path.relative(root, lockPath)),
      manifestRel: folder ? `${folder}/package.json` : 'package.json',
    };
  });
}

export function changedManifests(porcelain, projects) {
  const allowed = new Set();
  for (const project of projects) {
    allowed.add(project.manifestRel);
    allowed.add(project.lockRel);
  }
  const changed = [];
  for (const line of String(porcelain).split('\n')) {
    if (line.length < 4) continue;
    let filePath = line.slice(3).trim();
    const arrow = filePath.indexOf(' -> ');
    if (arrow !== -1) filePath = filePath.slice(arrow + 4).trim();
    if (allowed.has(filePath)) changed.push(filePath);
  }
  return changed;
}

export async function mapPool(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('concurrency must be a positive integer');
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createProgress(apps, { stream, isTTY = false } = {}) {
  const states = new Map(apps.map((app) => [app, 'queued']));
  let drawn = 0;

  function paint(app) {
    const state = states.get(app);
    const text = isTTY ? colorState(state) : state;
    return `${app.padEnd(28)} ${text}`;
  }

  function draw(app) {
    if (!isTTY) {
      stream.write(`${app}  ${states.get(app)}\n`);
      return;
    }
    if (drawn > 0) stream.write(`\x1b[${drawn}A\x1b[J`);
    stream.write(`${apps.map(paint).join('\n')}\n`);
    drawn = apps.length;
  }

  if (apps.length > 0) {
    if (isTTY) draw(apps[0]);
    else {
      for (const app of apps) stream.write(`${app}  queued\n`);
    }
  }

  return {
    set(app, state) {
      states.set(app, state);
      draw(app);
    },
  };
}

export function parseAppsList(values) {
  return [...new Set(
    (values ?? [])
      .flatMap((item) => String(item).split(','))
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

export function parsePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

export function parseCli(argv, { allowServe = false } = {}) {
  const args = [...argv];
  let mode = 'cli';
  if (allowServe && args[0] === 'serve') {
    mode = 'serve';
    args.shift();
  }

  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        'git-url': { type: 'string' },
        apps: { type: 'string', multiple: true },
        'base-branch': { type: 'string' },
        'include-pins': { type: 'boolean', default: false },
        concurrency: { type: 'string', default: '3' },
        timeout: { type: 'string', default: '1200000' },
        'work-dir': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        port: { type: 'string', default: '3847' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new Error(error.message);
  }
  if (values.help) return { help: true, mode };
  if (!values['git-url']) throw new Error('--git-url is required');
  if (!values['base-branch']) throw new Error('--base-branch is required');
  const apps = parseAppsList(values.apps);
  if (apps.length === 0) throw new Error('--apps is required');
  for (const app of apps) repoUrl(values['git-url'], app);
  const concurrency = parsePositiveInt(values.concurrency, '--concurrency');
  const timeoutMs = parsePositiveInt(values.timeout, '--timeout');
  const port = parsePositiveInt(values.port, '--port');
  if (mode === 'cli' && values['dry-run'] === undefined) {
    // keep default
  }
  return {
    help: false,
    mode,
    gitUrl: values['git-url'],
    baseBranch: values['base-branch'],
    apps,
    includePins: Boolean(values['include-pins']),
    concurrency,
    timeoutMs,
    workDir: values['work-dir'],
    dryRun: Boolean(values['dry-run']),
    port,
  };
}

export function summarize(results) {
  const counts = { pushed: 0, 'up to date': 0, 'dry-run': 0, failed: 0 };
  const lines = [];
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    if (result.status === 'failed') {
      const message = result.error?.message?.split('\n')[0] ?? 'failed';
      lines.push(`${result.app}: failed: ${message}`);
      if (result.clonePath) lines.push(`  clone kept at ${result.clonePath}`);
    } else if (result.status === 'pushed') {
      lines.push(`${result.app}: pushed ${result.branch}`);
    } else if (result.status === 'dry-run') {
      lines.push(`${result.app}: dry-run`);
      for (const item of result.planned ?? []) {
        const folder = item.project.dirRel || '.';
        const ranged = item.ranged.join(', ') || '(none)';
        const pins = item.pinInstalls.join(', ') || '(none)';
        lines.push(`  ${folder}: update ${ranged}; pins ${pins}`);
      }
    } else {
      lines.push(`${result.app}: up to date`);
    }
    for (const skip of result.skippedScripts ?? []) {
      lines.push(`  skipped ${skip.folder}: ${skip.script}`);
    }
  }
  lines.push(
    `pushed ${counts.pushed}, up to date ${counts['up to date']}, dry-run ${counts['dry-run']}, failed ${counts.failed}`,
  );
  return `${lines.join('\n')}\n`;
}

export function runCommand(command, args, { cwd, signal, env } = {}) {
  if (signal?.aborted) return Promise.reject(commandError(command, args, `${command} timed out`, null));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      killChild(child);
      finish(commandError(command, args, `${command} timed out`, null, stdout, stderr));
    };
    signal?.addEventListener('abort', onAbort);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = tail(stdout + chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr + chunk);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr, code });
      else finish(commandError(command, args, `${command} ${args.join(' ')} failed (${code})`, code, stdout, stderr));
    });
  });
}

export function colorState(state) {
  if (state === 'failed') return styleText('red', state);
  if (state === 'pushed' || state === 'up to date' || state === 'done') return styleText('green', state);
  if (state === 'queued' || state === 'dry-run') return styleText('dim', state);
  return styleText('cyan', state);
}

export function toPosix(value) {
  const normalized = value.split(path.sep).join('/');
  return normalized === '.' ? '' : normalized;
}

export function tail(value) {
  return value.length > OUTPUT_LIMIT ? value.slice(-OUTPUT_LIMIT) : value;
}

export function commandError(command, args, message, code, stdout = '', stderr = '') {
  const detail = stderr.trim();
  const error = new Error(detail ? `${message}\n${detail}` : message);
  error.code = code;
  error.stdout = stdout;
  error.stderr = stderr;
  error.command = command;
  error.args = args;
  return error;
}

export function killChild(child) {
  if (child.pid == null) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // The process may already have exited.
    }
  }
  child.kill('SIGTERM');
}

export async function refExists(cwd, branch, exec) {
  try {
    await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

export async function readManifest(clonePath, project) {
  try {
    return JSON.parse(await readFile(path.join(clonePath, project.manifestRel), 'utf8'));
  } catch {
    throw new Error(`Missing package.json next to ${project.lockRel}`);
  }
}

export async function readOutdated(cwd, exec) {
  try {
    const { stdout } = await exec('npm', ['outdated', '--json'], cwd);
    return parseJsonObject(stdout);
  } catch (error) {
    if (error.code === 1) return parseJsonObject(error.stdout);
    throw error;
  }
}

export function parseJsonObject(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) return {};
  const value = JSON.parse(trimmed);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

export function commitMessage(includePins) {
  if (includePins) return 'Update npm dependencies within the current major version.';
  return 'Update npm dependencies within the current allowed ranges.';
}

export function isSuccess(result) {
  return result.status === 'pushed' || result.status === 'up to date' || result.status === 'dry-run';
}

/** Keep enough of git/npm stderr for operators without flooding SSE. */
export function formatError(error, { max = 4_000 } = {}) {
  if (!error) return 'failed';
  const parts = [];
  if (error.message) parts.push(String(error.message));
  if (error.stderr && !String(error.message).includes(String(error.stderr).trim())) {
    parts.push(String(error.stderr).trim());
  }
  if (error.stdout && error.code === 1) {
    const out = String(error.stdout).trim();
    if (out && !parts.join('\n').includes(out)) parts.push(out);
  }
  const text = parts.join('\n').trim() || 'failed';
  return text.length > max ? `…${text.slice(-max)}` : text;
}

export function createLogger({ stream, onEntry, limit = 500 } = {}) {
  const entries = [];
  let seq = 0;

  function write(level, message, extra = {}) {
    const entry = {
      id: ++seq,
      ts: new Date().toISOString(),
      level,
      message: String(message),
      app: extra.app ?? null,
      ...extra.fields,
    };
    entries.push(entry);
    while (entries.length > limit) entries.shift();
    const line = `[${entry.ts}] ${level.toUpperCase()}${entry.app ? ` ${entry.app}` : ''} ${entry.message}\n`;
    stream?.write?.(line);
    onEntry?.(entry);
    return entry;
  }

  return {
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    entries: () => [...entries],
  };
}

export function normalizeSelections(selections) {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
    throw new Error('selections must be an object of app -> lockRel -> package names');
  }
  const normalized = {};
  for (const [app, locks] of Object.entries(selections)) {
    if (!APP_NAME.test(app)) throw new Error(`Invalid app name: ${app}`);
    if (!locks || typeof locks !== 'object' || Array.isArray(locks)) {
      throw new Error(`selections.${app} must be an object of lockRel -> package names`);
    }
    const lockMap = {};
    for (const [lockRel, packages] of Object.entries(locks)) {
      if (!Array.isArray(packages)) {
        throw new Error(`selections.${app}[${lockRel}] must be an array of package names`);
      }
      const names = [...new Set(packages.map((name) => String(name).trim()).filter(Boolean))].sort();
      if (names.length > 0) lockMap[lockRel] = names;
    }
    if (Object.keys(lockMap).length > 0) normalized[app] = lockMap;
  }
  return normalized;
}

export function selectionAppList(selections) {
  return Object.keys(selections).sort();
}

export function inventoryLibKey(app, lockRel, name) {
  return `${app}\0${lockRel}\0${name}`;
}

export async function resolvePinInstalls(pins, cwd, exec) {
  const pinInstalls = [];
  for (const pin of pins) {
    const viewed = await exec('npm', ['view', `${pin.name}@${pinRange(pin.current)}`, 'version', '--json'], cwd);
    const next = parseViewVersion(viewed.stdout);
    if (next && next !== pin.current) pinInstalls.push({ name: pin.name, current: pin.current, available: next });
  }
  return pinInstalls;
}
