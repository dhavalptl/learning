import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertSafeBranch,
  changedManifests,
  classifyOutdated,
  createProgress,
  discoverLockfiles,
  mapPool,
  parseCli,
  pinRange,
  pushRefspec,
  qualityScripts,
  repoUrl,
  runRepo,
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
