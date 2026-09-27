import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertSafeBranch,
  changedManifests,
  classifyOutdated,
  createAppState,
  createProgress,
  createSseHub,
  discoverLockfiles,
  formatError,
  isExactPin,
  isSuccess,
  mapPool,
  normalizeSelections,
  parseCli,
  parseViewVersion,
  pinRange,
  pushRefspec,
  qualityScripts,
  repoUrl,
  runCommand,
  runRepo,
  startServer,
  scanAllApps,
  scanApp,
  selectionAppList,
  serializeState,
  summarize,
  updateBranchName,
  updateSelectedApp,
} from './update-deps.mjs';

const template = 'https://github.com/org/{app}.git';

test('repoUrl substitutes the app name once', () => {
  assert.equal(repoUrl(template, 'checkout-ui'), 'https://github.com/org/checkout-ui.git');
  assert.equal(repoUrl('git@github.com:org/{app}.git', 'cart-ui'), 'git@github.com:org/cart-ui.git');
});

test('repoUrl rejects unsafe app names and bad templates', () => {
  assert.throws(() => repoUrl(template, '../secret'), /Invalid app name/);
  assert.throws(() => repoUrl(template, 'app/name'), /Invalid app name/);
  assert.throws(() => repoUrl('https://github.com/org/app.git', 'checkout-ui'), /exactly once/);
  assert.throws(() => repoUrl('https://github.com/{app}/{app}.git', 'checkout-ui'), /exactly once/);
  assert.throws(() => repoUrl('http://github.com/{app}.git', 'checkout-ui'), /https:\/\/ or git@/);
});

test('branch gate rejects master, main, and the base branch', () => {
  assert.throws(() => assertSafeBranch('master', 'develop'), /Refusing to commit or push/);
  assert.throws(() => assertSafeBranch('main', 'develop'), /Refusing to commit or push/);
  assert.throws(() => assertSafeBranch('develop', 'develop'), /Refusing to commit or push/);
  assert.throws(() => assertSafeBranch('HEAD', 'develop'), /Refusing to use branch/);
  assert.doesNotThrow(() => assertSafeBranch('chore/deps-update-20260923', 'main'));
});

test('push refspec targets only the update branch', () => {
  assert.equal(
    pushRefspec('chore/deps-update-20260923', 'main'),
    'HEAD:refs/heads/chore/deps-update-20260923',
  );
  assert.throws(() => pushRefspec('master', 'develop'), /Refusing to commit or push/);
  assert.throws(() => pushRefspec('main', 'main'), /Refusing to commit or push/);
  assert.throws(() => pushRefspec('release', 'release'), /Refusing to commit or push/);
});

test('classifyOutdated updates wanted ranges and ignores nested packages', () => {
  const manifest = {
    dependencies: { react: '^19.0.0', leftpad: '1.0.1' },
    devDependencies: { vite: '^6.0.0' },
  };
  const outdated = {
    react: { current: '19.0.0', wanted: '19.1.0', latest: '19.1.0' },
    leftpad: { current: '1.0.1', wanted: '1.0.1', latest: '1.0.3' },
    vite: { current: '6.0.0', wanted: '6.0.0', latest: '7.0.0' },
    nested: { current: '1.0.0', wanted: '1.2.0', latest: '2.0.0' },
  };
  const result = classifyOutdated(manifest, outdated, { includePins: false });
  assert.deepEqual(result.ranged, ['react']);
  assert.deepEqual(result.pins, []);
});

test('classifyOutdated keeps exact pins unless requested', () => {
  const manifest = { dependencies: { leftpad: '1.0.1', zero: '0.2.5' } };
  const outdated = {
    leftpad: { current: '1.0.1', wanted: '1.0.1', latest: '1.4.0' },
    zero: { current: '0.2.5', wanted: '0.2.5', latest: '0.3.0' },
  };
  const result = classifyOutdated(manifest, outdated, { includePins: true });
  assert.deepEqual(result.pins, [
    { name: 'leftpad', current: '1.0.1' },
    { name: 'zero', current: '0.2.5' },
  ]);
  assert.equal(pinRange('1.0.1'), '^1.0.1');
  assert.equal(pinRange('0.2.5'), '~0.2.5');
});

test('discoverLockfiles skips node_modules and returns nested locks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'update-deps-discover-'));
  try {
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    await writeFile(path.join(root, 'package.json'), '{}');
    await mkdir(path.join(root, 'packages', 'ui'), { recursive: true });
    await writeFile(path.join(root, 'packages', 'ui', 'package-lock.json'), '{}');
    await mkdir(path.join(root, 'node_modules', 'leftpad'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'leftpad', 'package-lock.json'), '{}');

    const found = await discoverLockfiles(root);
    assert.deepEqual(found.map((project) => project.lockRel), [
      'package-lock.json',
      'packages/ui/package-lock.json',
    ]);
    assert.equal(found[1].manifestRel, 'packages/ui/package.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('qualityScripts skips scripts that are not defined', () => {
  const selected = qualityScripts({ scripts: { lint: 'eslint .', build: 'vite build' } });
  assert.deepEqual(selected.run, ['lint', 'build']);
  assert.deepEqual(selected.skipped, ['test']);
});

test('changedManifests adds only discovered manifest and lock files', () => {
  const projects = [
    { manifestRel: 'package.json', lockRel: 'package-lock.json' },
    { manifestRel: 'packages/ui/package.json', lockRel: 'packages/ui/package-lock.json' },
  ];
  const porcelain = [
    ' M package.json',
    ' M package-lock.json',
    ' M README.md',
    ' M packages/ui/package-lock.json',
  ].join('\n');
  assert.deepEqual(changedManifests(porcelain, projects), [
    'package.json',
    'package-lock.json',
    'packages/ui/package-lock.json',
  ]);
});

test('parseCli accepts repeated and comma-separated app names', () => {
  const options = parseCli([
    '--git-url', template,
    '--base-branch', 'main',
    '--apps', 'checkout-ui,cart-ui',
    '--apps', 'catalog-ui',
    '--include-pins',
    '--concurrency', '4',
  ]);
  assert.deepEqual(options.apps, ['checkout-ui', 'cart-ui', 'catalog-ui']);
  assert.equal(options.includePins, true);
  assert.equal(options.concurrency, 4);
  assert.equal(options.timeoutMs, 1_200_000);
  assert.equal(options.dryRun, false);
  assert.equal(options.mode, 'cli');
});

test('parseCli serve mode reads port', () => {
  const options = parseCli([
    'serve',
    '--git-url', template,
    '--base-branch', 'develop',
    '--apps', 'checkout-ui',
    '--port', '4123',
  ], { allowServe: true });
  assert.equal(options.mode, 'serve');
  assert.equal(options.port, 4123);
  assert.equal(options.baseBranch, 'develop');
});

test('mapPool never exceeds the concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  await mapPool([1, 2, 3, 4, 5], 2, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
  });
  assert.equal(maxActive, 2);
});

test('runRepo updates every lockfile, runs quality scripts, and pushes a new branch', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-run-'));
  const calls = [];
  const run = async (command, args, { cwd } = {}) => {
    calls.push([command, args]);
    if (command === 'git' && args[0] === 'clone') {
      const dest = args.at(-1);
      await mkdir(path.join(dest, 'packages', 'ui'), { recursive: true });
      await writeFile(path.join(dest, 'package.json'), JSON.stringify({
        scripts: { lint: 'true', test: 'true' },
        dependencies: { react: '^19.0.0', leftpad: '1.0.1' },
      }));
      await writeFile(path.join(dest, 'package-lock.json'), '{}');
      await writeFile(path.join(dest, 'packages', 'ui', 'package.json'), JSON.stringify({
        scripts: { build: 'true' },
        dependencies: { vite: '^6.0.0' },
      }));
      await writeFile(path.join(dest, 'packages', 'ui', 'package-lock.json'), '{}');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (command === 'git' && args[0] === 'show-ref') {
      const error = new Error('missing');
      error.code = 1;
      throw error;
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'chore/deps-update-20260923\n', stderr: '', code: 0 };
    }
    if (command === 'npm' && args[0] === 'outdated') {
      const nested = cwd.endsWith(`${path.sep}packages${path.sep}ui`);
      const error = new Error('outdated');
      error.code = 1;
      error.stdout = JSON.stringify(nested
        ? { vite: { current: '6.0.0', wanted: '6.2.0', latest: '7.0.0' } }
        : {
          react: { current: '19.0.0', wanted: '19.1.0', latest: '19.1.0' },
          leftpad: { current: '1.0.1', wanted: '1.0.1', latest: '1.0.3' },
        });
      throw error;
    }
    if (command === 'git' && args[0] === 'status') {
      return {
        stdout: ' M package.json\n M package-lock.json\n M packages/ui/package-lock.json\n',
        stderr: '',
        code: 0,
      };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await runRepo({
      app: 'checkout-ui',
      gitUrl: template,
      baseBranch: 'main',
      timeoutMs: 1000,
      workRoot,
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 'pushed');
    const updates = calls.filter((call) => call[0] === 'npm' && call[1][0] === 'update');
    assert.equal(updates.length, 2);
    assert.ok(updates.some((call) => call[1].includes('react') && !call[1].includes('leftpad')));
    assert.ok(updates.some((call) => call[1].includes('vite')));
    assert.ok(calls.some((call) => call[0] === 'npm' && call[1][0] === 'run' && call[1][1] === 'lint'));
    assert.ok(calls.some((call) => call[0] === 'npm' && call[1][1] === 'test'));
    assert.ok(calls.some((call) => call[0] === 'npm' && call[1][1] === 'build'));
    const qualityInstalls = calls.filter((call) => (
      call[0] === 'npm'
      && call[1][0] === 'install'
      && !call[1].includes('--ignore-scripts')
      && !call[1].includes('--save-exact')
    ));
    assert.ok(qualityInstalls.length >= 1);
    const push = calls.find((call) => call[0] === 'git' && call[1][0] === 'push');
    assert.match(push[1].at(-1), /^HEAD:refs\/heads\/chore\/deps-update-/);
    assert.equal(push[1].includes('--force'), false);
    assert.equal(push[1].includes('master'), false);
    assert.equal(push[1].includes('main'), false);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('progress writes one line per state when stdout is not a TTY', () => {
  let output = '';
  const progress = createProgress(['checkout-ui'], {
    stream: { write(chunk) { output += chunk; } },
    isTTY: false,
  });
  progress.set('checkout-ui', 'cloning');
  assert.match(output, /checkout-ui {2}queued/);
  assert.match(output, /checkout-ui {2}cloning/);
});

test('scanApp returns lockfile inventory with current and available versions', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-scan-'));
  const run = async (command, args, { cwd } = {}) => {
    if (command === 'git' && args[0] === 'clone') {
      const dest = args.at(-1);
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'package.json'), JSON.stringify({
        dependencies: { react: '^19.0.0', leftpad: '1.0.1' },
      }));
      await writeFile(path.join(dest, 'package-lock.json'), '{}');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (command === 'npm' && args[0] === 'outdated') {
      const error = new Error('outdated');
      error.code = 1;
      error.stdout = JSON.stringify({
        react: { current: '19.0.0', wanted: '19.1.0', latest: '19.1.0' },
        leftpad: { current: '1.0.1', wanted: '1.0.1', latest: '1.0.3' },
      });
      throw error;
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await scanApp({
      app: 'checkout-ui',
      gitUrl: template,
      baseBranch: 'main',
      timeoutMs: 5000,
      workRoot,
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.locks.length, 1);
    assert.deepEqual(result.locks[0].libs, [
      { name: 'react', current: '19.0.0', available: '19.1.0', kind: 'ranged' },
    ]);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('updateSelectedApp updates only selected packages', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-sel-'));
  const clonePath = path.join(workRoot, 'checkout-ui');
  await mkdir(clonePath, { recursive: true });
  await writeFile(path.join(clonePath, 'package.json'), JSON.stringify({
    scripts: { lint: 'true' },
    dependencies: { react: '^19.0.0', lodash: '^4.0.0' },
  }));
  await writeFile(path.join(clonePath, 'package-lock.json'), '{}');

  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git' && args[0] === 'show-ref') {
      const error = new Error('missing');
      error.code = 1;
      throw error;
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'chore/deps-update-20260927\n', stderr: '', code: 0 };
    }
    if (command === 'git' && args[0] === 'status') {
      return { stdout: ' M package.json\n M package-lock.json\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await updateSelectedApp({
      app: 'checkout-ui',
      baseBranch: 'main',
      timeoutMs: 5000,
      clonePath,
      selections: {
        'checkout-ui': {
          'package-lock.json': ['react'],
        },
      },
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 'pushed');
    const updates = calls.filter((call) => call[0] === 'npm' && call[1][0] === 'update');
    assert.equal(updates.length, 1);
    assert.ok(updates[0][1].includes('react'));
    assert.equal(updates[0][1].includes('lodash'), false);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('normalizeSelections and selectionAppList', () => {
  const normalized = normalizeSelections({
    'checkout-ui': {
      'package-lock.json': ['react', 'react', ' lodash '],
      'packages/ui/package-lock.json': [],
    },
    'cart-ui': {
      'package-lock.json': ['vite'],
    },
  });
  assert.deepEqual(normalized, {
    'cart-ui': { 'package-lock.json': ['vite'] },
    'checkout-ui': { 'package-lock.json': ['lodash', 'react'] },
  });
  assert.deepEqual(selectionAppList(normalized), ['cart-ui', 'checkout-ui']);
  assert.throws(() => normalizeSelections([]), /must be an object/);
});

test('serializeState exposes scan inventory snapshot', () => {
  const state = createAppState({
    apps: ['checkout-ui'],
    gitUrl: template,
    baseBranch: 'develop',
    concurrency: 3,
    includePins: false,
    timeoutMs: 1000,
    port: 3847,
    workRoot: '/tmp/work',
  });
  state.apps['checkout-ui'].status = 'ready';
  state.apps['checkout-ui'].locks = [{
    lockRel: 'package-lock.json',
    dirRel: '',
    manifestRel: 'package.json',
    libs: [{ name: 'react', current: '19.0.0', available: '19.1.0', kind: 'ranged' }],
  }];
  state.phase = 'ready';
  const snap = serializeState(state);
  assert.equal(snap.phase, 'ready');
  assert.equal(snap.apps[0].locks[0].libs[0].name, 'react');
  assert.equal(snap.config.concurrency, 3);
  assert.equal(snap.job, null);
  assert.deepEqual(snap.logs, []);
});

test('formatError keeps stderr detail for operators', async () => {
  const { formatError, createLogger } = await import('./update-deps.mjs');
  const error = new Error('npm ci failed (1)');
  error.stderr = 'ERESOLVE unable to resolve dependency tree\n';
  assert.match(formatError(error), /ERESOLVE/);
  assert.match(formatError(error), /npm ci failed/);

  let written = '';
  const entries = [];
  const log = createLogger({
    stream: { write(chunk) { written += chunk; } },
    onEntry: (entry) => entries.push(entry),
  });
  log.error('boom', { app: 'checkout-ui' });
  assert.match(written, /ERROR checkout-ui boom/);
  assert.equal(entries[0].level, 'error');
  assert.equal(entries[0].app, 'checkout-ui');
});

test('rescanApp removes the previous clone before scanning again', async () => {
  const { rescanApp } = await import('./update-deps.mjs');
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-rescan-'));
  const clonePath = path.join(workRoot, 'checkout-ui');
  await mkdir(clonePath, { recursive: true });
  await writeFile(path.join(clonePath, 'stale.txt'), 'old');

  const run = async (command, args) => {
    if (command === 'git' && args[0] === 'clone') {
      const dest = args.at(-1);
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'package.json'), JSON.stringify({
        dependencies: { react: '^19.0.0' },
      }));
      await writeFile(path.join(dest, 'package-lock.json'), '{}');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (command === 'npm' && args[0] === 'outdated') {
      const error = new Error('outdated');
      error.code = 1;
      error.stdout = JSON.stringify({
        react: { current: '19.0.0', wanted: '19.1.0', latest: '19.1.0' },
      });
      throw error;
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await rescanApp({
      app: 'checkout-ui',
      gitUrl: template,
      baseBranch: 'main',
      timeoutMs: 5000,
      workRoot,
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.locks[0].libs[0].name, 'react');
    await assert.rejects(async () => {
      await readFile(path.join(clonePath, 'stale.txt'));
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('isExactPin, parseViewVersion, updateBranchName, commit helpers', async () => {
  const { commitMessage } = await import('./update-deps.mjs');
  assert.equal(isExactPin('1.2.3'), true);
  assert.equal(isExactPin('=1.2.3'), true);
  assert.equal(isExactPin('^1.2.3'), false);
  assert.equal(parseViewVersion('"1.4.0"\n'), '1.4.0');
  assert.equal(parseViewVersion('["1.0.0","1.4.0"]'), '1.4.0');
  assert.match(updateBranchName(new Date('2026-09-27T00:00:00Z')), /^chore\/deps-update-20260927$/);
  assert.match(
    updateBranchName(new Date('2026-09-27T12:34:56Z'), true),
    /^chore\/deps-update-20260927-123456$/,
  );
  assert.match(commitMessage(false), /allowed ranges/);
  assert.match(commitMessage(true), /current major/);
  assert.equal(isSuccess({ status: 'pushed' }), true);
  assert.equal(isSuccess({ status: 'failed' }), false);
});

test('parseCli rejects missing required flags and bad numbers', () => {
  assert.throws(() => parseCli(['--base-branch', 'develop', '--apps', 'a']), /--git-url/);
  assert.throws(() => parseCli(['--git-url', template, '--apps', 'a']), /--base-branch/);
  assert.throws(
    () => parseCli(['--git-url', template, '--base-branch', 'develop']),
    /--apps/,
  );
  assert.throws(
    () => parseCli([
      '--git-url', template,
      '--base-branch', 'develop',
      '--apps', 'a',
      '--concurrency', '0',
    ]),
    /concurrency/,
  );
});

test('summarize reports pushed, up to date, dry-run, and failed apps', () => {
  const text = summarize([
    { app: 'a', status: 'pushed', branch: 'chore/deps-update-20260927' },
    { app: 'b', status: 'up to date' },
    {
      app: 'c',
      status: 'dry-run',
      planned: [{
        project: { dirRel: '' },
        ranged: ['react'],
        pinInstalls: [],
      }],
    },
    { app: 'd', status: 'failed', error: new Error('boom\nmore'), clonePath: '/tmp/d' },
  ]);
  assert.match(text, /a: pushed chore\/deps-update-20260927/);
  assert.match(text, /b: up to date/);
  assert.match(text, /c: dry-run/);
  assert.match(text, /d: failed: boom/);
  assert.match(text, /pushed 1, up to date 1, dry-run 1, failed 1/);
});

test('scanApp includes pin libs when includePins is enabled', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-pins-'));
  const run = async (command, args) => {
    if (command === 'git' && args[0] === 'clone') {
      const dest = args.at(-1);
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'package.json'), JSON.stringify({
        dependencies: { leftpad: '1.0.1', react: '^19.0.0' },
      }));
      await writeFile(path.join(dest, 'package-lock.json'), '{}');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (command === 'npm' && args[0] === 'outdated') {
      const error = new Error('outdated');
      error.code = 1;
      error.stdout = JSON.stringify({
        leftpad: { current: '1.0.1', wanted: '1.0.1', latest: '1.4.0' },
        react: { current: '19.0.0', wanted: '19.1.0', latest: '19.1.0' },
      });
      throw error;
    }
    if (command === 'npm' && args[0] === 'view') {
      return { stdout: '"1.4.0"\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await scanApp({
      app: 'checkout-ui',
      gitUrl: template,
      baseBranch: 'main',
      includePins: true,
      timeoutMs: 5000,
      workRoot,
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.deepEqual(
      result.locks[0].libs.map((lib) => ({ name: lib.name, kind: lib.kind })),
      [
        { name: 'leftpad', kind: 'pin' },
        { name: 'react', kind: 'ranged' },
      ],
    );
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('updateSelectedApp reports up to date when nothing changed', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-uptodate-'));
  const clonePath = path.join(workRoot, 'checkout-ui');
  await mkdir(clonePath, { recursive: true });
  await writeFile(path.join(clonePath, 'package.json'), JSON.stringify({
    dependencies: { react: '^19.0.0' },
  }));
  await writeFile(path.join(clonePath, 'package-lock.json'), '{}');

  const run = async (command, args) => {
    if (command === 'git' && args[0] === 'show-ref') {
      const error = new Error('missing');
      error.code = 1;
      throw error;
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'chore/deps-update-20260927\n', stderr: '', code: 0 };
    }
    if (command === 'git' && args[0] === 'status') {
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await updateSelectedApp({
      app: 'checkout-ui',
      baseBranch: 'main',
      timeoutMs: 5000,
      clonePath,
      selections: { 'checkout-ui': { 'package-lock.json': ['react'] } },
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 'up to date');
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('updateSelectedApp uses npm install after updates instead of npm ci', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-install-'));
  const clonePath = path.join(workRoot, 'checkout-ui');
  await mkdir(clonePath, { recursive: true });
  await writeFile(path.join(clonePath, 'package.json'), JSON.stringify({
    scripts: { lint: 'true' },
    dependencies: { react: '^19.0.0' },
  }));
  await writeFile(path.join(clonePath, 'package-lock.json'), '{}');

  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git' && args[0] === 'show-ref') {
      const error = new Error('missing');
      error.code = 1;
      throw error;
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'chore/deps-update-20260927\n', stderr: '', code: 0 };
    }
    if (command === 'git' && args[0] === 'status') {
      return { stdout: ' M package.json\n M package-lock.json\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    await updateSelectedApp({
      app: 'checkout-ui',
      baseBranch: 'main',
      timeoutMs: 5000,
      clonePath,
      selections: { 'checkout-ui': { 'package-lock.json': ['react'] } },
      run,
      signal: AbortSignal.timeout(5000),
    });
    const qualityInstall = calls.find((call) => (
      call[0] === 'npm'
      && call[1][0] === 'install'
      && !call[1].includes('--ignore-scripts')
      && !call[1].includes('--save-exact')
    ));
    assert.ok(qualityInstall);
    assert.equal(
      calls.some((call) => call[0] === 'npm' && call[1][0] === 'ci' && !call[1].includes('--ignore-scripts')),
      false,
    );
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('scanApp deletes a leftover clone before cloning the base branch', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-leftover-'));
  const clonePath = path.join(workRoot, 'checkout-ui');
  await mkdir(path.join(clonePath, 'dist'), { recursive: true });
  await writeFile(path.join(clonePath, 'dist', 'package-lock.json'), '{}');

  const run = async (command, args) => {
    if (command === 'git' && args[0] === 'clone') {
      const dest = args.at(-1);
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'package.json'), JSON.stringify({
        dependencies: { react: '^19.0.0' },
      }));
      await writeFile(path.join(dest, 'package-lock.json'), '{}');
      assert.equal(args.includes('--branch'), true);
      assert.equal(args[args.indexOf('--branch') + 1], 'main');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (command === 'npm' && args[0] === 'outdated') {
      const error = new Error('outdated');
      error.code = 1;
      error.stdout = JSON.stringify({
        react: { current: '19.0.0', wanted: '19.1.0', latest: '19.1.0' },
      });
      throw error;
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await scanApp({
      app: 'checkout-ui',
      gitUrl: template,
      baseBranch: 'main',
      timeoutMs: 5000,
      workRoot,
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.locks[0].libs[0].name, 'react');
    await assert.rejects(() => readFile(path.join(clonePath, 'dist', 'package-lock.json')));
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('scanAllApps never exceeds the concurrency limit', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-scan-pool-'));
  let active = 0;
  let max = 0;
  const run = async (command, args) => {
    active += 1;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    if (command === 'git' && args[0] === 'clone') {
      const dest = args.at(-1);
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'package.json'), JSON.stringify({
        dependencies: { react: '^19.0.0' },
      }));
      await writeFile(path.join(dest, 'package-lock.json'), '{}');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (command === 'npm' && args[0] === 'outdated') {
      const error = new Error('outdated');
      error.code = 1;
      error.stdout = JSON.stringify({
        react: { current: '19.0.0', wanted: '19.1.0', latest: '19.1.0' },
      });
      throw error;
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const results = await scanAllApps({
      apps: ['a', 'b', 'c'],
      gitUrl: template,
      baseBranch: 'main',
      timeoutMs: 5000,
      workRoot,
      concurrency: 2,
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(results.length, 3);
    assert.equal(results.every((result) => result.status === 'ready'), true);
    assert.equal(max, 2);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('updateSelectedApp suffixes the branch when the remote already has today’s name', async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-remote-branch-'));
  const clonePath = path.join(workRoot, 'checkout-ui');
  await mkdir(clonePath, { recursive: true });
  await writeFile(path.join(clonePath, 'package.json'), JSON.stringify({
    dependencies: { react: '^19.0.0' },
  }));
  await writeFile(path.join(clonePath, 'package-lock.json'), '{}');

  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git' && args[0] === 'show-ref') {
      const error = new Error('missing');
      error.code = 1;
      throw error;
    }
    if (command === 'git' && args[0] === 'ls-remote') {
      const ref = String(args.at(-1));
      if (/refs\/heads\/chore\/deps-update-\d{8}$/.test(ref)) {
        return { stdout: `deadbeef\t${ref}\n`, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'chore/deps-update-20260927-120000\n', stderr: '', code: 0 };
    }
    if (command === 'git' && args[0] === 'status') {
      return { stdout: ' M package.json\n M package-lock.json\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await updateSelectedApp({
      app: 'checkout-ui',
      baseBranch: 'main',
      timeoutMs: 5000,
      clonePath,
      selections: { 'checkout-ui': { 'package-lock.json': ['react'] } },
      run,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 'pushed');
    const created = calls.find((call) => call[0] === 'git' && call[1][0] === 'checkout' && call[1][1] === '-b');
    assert.match(created[1][2], /^chore\/deps-update-\d{8}-\d{6}$/);
    const push = calls.find((call) => call[0] === 'git' && call[1][0] === 'push');
    assert.match(push[1].at(-1), /^HEAD:refs\/heads\/chore\/deps-update-\d{8}-\d{6}$/);
    assert.equal(push[1].includes('--force'), false);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('runCommand reports cancel and timeout separately', async () => {
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(
    runCommand(process.execPath, ['-e', '0'], { signal: cancel.signal }),
    /cancelled/,
  );

  const controller = new AbortController();
  const pending = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);

  await assert.rejects(
    runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: AbortSignal.timeout(30),
    }),
    /timed out/,
  );
});

test('serve shutdown removes a temporary work dir and keeps a user work dir', async () => {
  const quiet = { write() {} };

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-temp-'));
  const tempServer = await startServer({
    gitUrl: template,
    baseBranch: 'main',
    apps: [],
    concurrency: 1,
    includePins: false,
    timeoutMs: 1000,
    port: 0,
    workRoot: tempRoot,
    createdTemp: true,
    stderr: quiet,
  });
  await tempServer.shutdown();
  await assert.rejects(() => access(tempRoot));

  const keptRoot = await mkdtemp(path.join(tmpdir(), 'update-deps-kept-'));
  const keptServer = await startServer({
    gitUrl: template,
    baseBranch: 'main',
    apps: [],
    concurrency: 1,
    includePins: false,
    timeoutMs: 1000,
    port: 0,
    workRoot: keptRoot,
    createdTemp: false,
    stderr: quiet,
  });
  try {
    await keptServer.shutdown();
    await access(keptRoot);
  } finally {
    await rm(keptRoot, { recursive: true, force: true });
  }
});

test('createSseHub broadcasts events to subscribers', () => {
  const hub = createSseHub();
  const chunks = [];
  const res = {
    write(chunk) {
      chunks.push(String(chunk));
    },
  };
  const unsubscribe = hub.subscribe(res);
  hub.broadcast('log', { level: 'info', message: 'hello' });
  assert.ok(chunks.some((chunk) => chunk.includes('event: log')));
  assert.ok(chunks.some((chunk) => chunk.includes('"hello"')));
  unsubscribe();
  const before = chunks.length;
  hub.broadcast('log', { level: 'info', message: 'ignored' });
  assert.equal(chunks.length, before);
});
