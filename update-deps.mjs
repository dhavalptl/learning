#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, styleText } from 'node:util';
import { pathToFileURL } from 'node:url';

const APP_NAME = /^[A-Za-z0-9._-]+$/;
const EXACT_PIN = /^=?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const BLOCKED_BRANCHES = new Set(['master', 'main']);
const QUALITY_SCRIPT_NAMES = ['lint', 'test', 'build'];
const OUTPUT_LIMIT = 120_000;

const HELP = `Update direct dependencies in many app repos and push a new branch.

Usage:
  node update-deps.mjs --git-url <template> --base-branch <name> --apps <name> [--apps <name>]

Required:
  --git-url <template>     Clone URL containing {app} once.
                           Example: https://github.com/org/{app}.git
  --base-branch <name>     Branch to clone. Commits never land on this branch,
                           master, or main.
  --apps <name>            App name, repeatable. Comma-separated values are also accepted.

Options:
  --include-pins           Move exact pins to the newest same-major version.
  --concurrency <n>        Repos running at once. Default: 3.
  --timeout <ms>           Time budget for one repo. Default: 1200000.
  --work-dir <path>        Clone root. Default: a temporary directory.
  --dry-run                Show the update list. Do not write, check, commit, or push.
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

export function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
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
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new Error(error.message);
  }
  if (values.help) return { help: true };
  if (!values['git-url']) throw new Error('--git-url is required');
  if (!values['base-branch']) throw new Error('--base-branch is required');
  const apps = [...new Set(
    (values.apps ?? [])
      .flatMap((item) => item.split(','))
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  if (apps.length === 0) throw new Error('--apps is required');
  for (const app of apps) repoUrl(values['git-url'], app);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  const timeoutMs = Number(values.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('--timeout must be a positive integer');
  }
  return {
    help: false,
    gitUrl: values['git-url'],
    baseBranch: values['base-branch'],
    apps,
    includePins: Boolean(values['include-pins']),
    concurrency,
    timeoutMs,
    workDir: values['work-dir'],
    dryRun: Boolean(values['dry-run']),
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

export async function runRepo({
  app,
  gitUrl,
  baseBranch,
  includePins = false,
  timeoutMs,
  workRoot,
  dryRun = false,
  onStatus = () => {},
  run = runCommand,
  signal,
}) {
  const url = repoUrl(gitUrl, app);
  const clonePath = path.join(workRoot, app);
  const repoSignal = signal ?? AbortSignal.timeout(timeoutMs);
  const exec = (command, args, cwd = clonePath) => run(command, args, { cwd, signal: repoSignal });

  onStatus(app, 'cloning');
  await exec('git', ['clone', '--branch', baseBranch, '--single-branch', '--depth', '1', url, clonePath], workRoot);

  let branch = updateBranchName(new Date());
  if (await refExists(clonePath, branch, exec)) branch = updateBranchName(new Date(), true);
  assertSafeBranch(branch, baseBranch);
  await exec('git', ['checkout', '-b', branch]);
  const head = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  assertSafeBranch(head, baseBranch);

  const projects = await discoverLockfiles(clonePath);
  if (projects.length === 0) throw new Error(`No package-lock.json found in ${app}`);

  const planned = [];
  for (const project of projects) {
    const cwd = path.join(clonePath, project.dirRel);
    const manifest = await readManifest(clonePath, project);
    onStatus(app, `updating ${project.dirRel || '.'}`);
    await exec('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], cwd);
    const outdated = await readOutdated(cwd, exec);
    const { ranged, pins } = classifyOutdated(manifest, outdated, { includePins });
    const pinInstalls = [];
    if (includePins) {
      for (const pin of pins) {
        const viewed = await exec('npm', ['view', `${pin.name}@${pinRange(pin.current)}`, 'version', '--json'], cwd);
        const next = parseViewVersion(viewed.stdout);
        if (next && next !== pin.current) pinInstalls.push(`${pin.name}@${next}`);
      }
    }
    planned.push({ project, ranged, pinInstalls });
    if (dryRun) continue;
    if (pinInstalls.length > 0) {
      await exec('npm', ['install', '--save-exact', '--no-audit', '--no-fund', '--ignore-scripts', ...pinInstalls], cwd);
    }
    if (ranged.length > 0) {
      await exec('npm', ['update', '--save', '--no-audit', '--no-fund', '--ignore-scripts', ...ranged], cwd);
    }
  }

  if (dryRun) {
    onStatus(app, 'dry-run');
    return { app, status: 'dry-run', branch, planned, clonePath, skippedScripts: [] };
  }

  const porcelain = (await exec('git', ['status', '--porcelain'])).stdout;
  const files = changedManifests(porcelain, projects);
  if (files.length === 0) {
    onStatus(app, 'up to date');
    return { app, status: 'up to date', branch, clonePath, skippedScripts: [] };
  }

  const skippedScripts = [];
  for (const project of projects) {
    const cwd = path.join(clonePath, project.dirRel);
    const manifest = await readManifest(clonePath, project);
    onStatus(app, `installing ${project.dirRel || '.'}`);
    await exec('npm', ['ci', '--no-audit', '--no-fund'], cwd);
    const selected = qualityScripts(manifest);
    for (const name of selected.skipped) skippedScripts.push({ folder: project.dirRel || '.', script: name });
    for (const name of selected.run) {
      onStatus(app, `checking ${name} ${project.dirRel || '.'}`);
      await exec('npm', ['run', name], cwd);
    }
  }

  const current = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  assertSafeBranch(current, baseBranch);
  const refspec = pushRefspec(branch, baseBranch);
  await exec('git', ['add', '--', ...files]);
  await exec('git', ['commit', '-m', commitMessage(includePins)]);
  onStatus(app, 'pushing');
  await exec('git', ['push', 'origin', refspec]);
  onStatus(app, 'pushed');
  return { app, status: 'pushed', branch, clonePath, skippedScripts, files };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  try {
    options = parseCli(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }

  const createdTemp = !options.workDir;
  const workRoot = options.workDir ?? await mkdtemp(path.join(tmpdir(), 'update-deps-'));
  const progress = createProgress(options.apps, { stream: stderr, isTTY: Boolean(stderr.isTTY) });
  const results = await mapPool(options.apps, options.concurrency, async (app) => {
    const clonePath = path.join(workRoot, app);
    try {
      const result = await runRepo({
        app,
        gitUrl: options.gitUrl,
        baseBranch: options.baseBranch,
        includePins: options.includePins,
        timeoutMs: options.timeoutMs,
        workRoot,
        dryRun: options.dryRun,
        onStatus: (name, state) => progress.set(name, state),
      });
      await rm(result.clonePath, { recursive: true, force: true });
      return result;
    } catch (error) {
      progress.set(app, 'failed');
      return { app, status: 'failed', error, clonePath };
    }
  });

  stdout.write(summarize(results));
  if (createdTemp && results.every(isSuccess)) await rm(workRoot, { recursive: true, force: true });
  return results.every(isSuccess) ? 0 : 1;
}

function colorState(state) {
  if (state === 'failed') return styleText('red', state);
  if (state === 'pushed' || state === 'up to date') return styleText('green', state);
  if (state === 'queued' || state === 'dry-run') return styleText('dim', state);
  return styleText('cyan', state);
}

function toPosix(value) {
  const normalized = value.split(path.sep).join('/');
  return normalized === '.' ? '' : normalized;
}

function tail(value) {
  return value.length > OUTPUT_LIMIT ? value.slice(-OUTPUT_LIMIT) : value;
}

function commandError(command, args, message, code, stdout = '', stderr = '') {
  const detail = stderr.trim();
  const error = new Error(detail ? `${message}\n${detail}` : message);
  error.code = code;
  error.stdout = stdout;
  error.stderr = stderr;
  error.command = command;
  error.args = args;
  return error;
}

function killChild(child) {
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

async function refExists(cwd, branch, exec) {
  try {
    await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function readManifest(clonePath, project) {
  try {
    return JSON.parse(await readFile(path.join(clonePath, project.manifestRel), 'utf8'));
  } catch {
    throw new Error(`Missing package.json next to ${project.lockRel}`);
  }
}

async function readOutdated(cwd, exec) {
  try {
    const { stdout } = await exec('npm', ['outdated', '--json'], cwd);
    return parseJsonObject(stdout);
  } catch (error) {
    if (error.code === 1) return parseJsonObject(error.stdout);
    throw error;
  }
}

function parseJsonObject(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) return {};
  const value = JSON.parse(trimmed);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function commitMessage(includePins) {
  if (includePins) return 'Update npm dependencies within the current major version.';
  return 'Update npm dependencies within the current allowed ranges.';
}

function isSuccess(result) {
  return result.status === 'pushed' || result.status === 'up to date' || result.status === 'dry-run';
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
