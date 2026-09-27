import path from 'node:path';
import {
  assertSafeBranch,
  changedManifests,
  classifyOutdated,
  commitMessage,
  discoverLockfiles,
  isExactPin,
  parseViewVersion,
  pinRange,
  pushRefspec,
  qualityScripts,
  readManifest,
  pickUpdateBranch,
  readOutdated,
  repoUrl,
  resolvePinInstalls,
  runCommand,
} from './core.mjs';

/**
 * Full CLI path: clone, update all outdated packages, quality, commit, push.
 */
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

  const branch = await pickUpdateBranch(clonePath, baseBranch, exec);
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
    let pinInstalls = [];
    if (includePins) {
      const resolved = await resolvePinInstalls(pins, cwd, exec);
      pinInstalls = resolved.map((pin) => `${pin.name}@${pin.available}`);
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
    // After npm update/install, package.json and the lockfile can diverge enough
    // that `npm ci` rejects them. Reinstall with `npm install` to sync + run scripts.
    await exec('npm', ['install', '--no-audit', '--no-fund'], cwd);
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

/**
 * Update only selected packages in an already-cloned app, then quality/commit/push.
 */
export async function updateSelectedApp({
  app,
  baseBranch,
  includePins = false,
  timeoutMs,
  clonePath,
  selections,
  onStage = () => {},
  run = runCommand,
  signal,
}) {
  if (!clonePath) throw new Error(`Missing clone for ${app}`);
  const lockSelections = selections?.[app];
  if (!lockSelections || Object.keys(lockSelections).length === 0) {
    throw new Error(`No packages selected for ${app}`);
  }

  const repoSignal = signal ?? AbortSignal.timeout(timeoutMs);
  const exec = (command, args, cwd = clonePath) => run(command, args, { cwd, signal: repoSignal });

  onStage(app, 'branching');
  await exec('git', ['checkout', baseBranch]);
  await exec('git', ['reset', '--hard', 'HEAD']);
  await exec('git', ['clean', '-fd']);

  const branch = await pickUpdateBranch(clonePath, baseBranch, exec);
  await exec('git', ['checkout', '-b', branch]);
  const head = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  assertSafeBranch(head, baseBranch);

  const projects = await discoverLockfiles(clonePath);
  const byLock = new Map(projects.map((project) => [project.lockRel, project]));
  const touchedProjects = [];

  onStage(app, 'updating');
  for (const [lockRel, packageNames] of Object.entries(lockSelections)) {
    const project = byLock.get(lockRel);
    if (!project) throw new Error(`Unknown lockfile ${lockRel} in ${app}`);
    const cwd = path.join(clonePath, project.dirRel);
    const manifest = await readManifest(clonePath, project);
    const specs = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    };

    const ranged = [];
    const pinInstalls = [];
    for (const name of packageNames) {
      const spec = specs[name];
      if (typeof spec !== 'string') throw new Error(`Package ${name} is not a direct dependency in ${lockRel}`);
      if (spec.includes(':')) throw new Error(`Package ${name} uses a non-registry spec`);
      if (isExactPin(spec)) {
        if (!includePins) throw new Error(`Exact pin ${name} requires includePins`);
        const currentMatch = String(spec).replace(/^=/, '');
        const viewed = await exec('npm', ['view', `${name}@${pinRange(currentMatch)}`, 'version', '--json'], cwd);
        const next = parseViewVersion(viewed.stdout);
        if (next && next !== currentMatch) pinInstalls.push(`${name}@${next}`);
      } else {
        ranged.push(name);
      }
    }

    await exec('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], cwd);
    if (pinInstalls.length > 0) {
      await exec('npm', ['install', '--save-exact', '--no-audit', '--no-fund', '--ignore-scripts', ...pinInstalls], cwd);
    }
    if (ranged.length > 0) {
      await exec('npm', ['update', '--save', '--no-audit', '--no-fund', '--ignore-scripts', ...ranged], cwd);
    }
    touchedProjects.push(project);
  }

  const porcelain = (await exec('git', ['status', '--porcelain'])).stdout;
  const files = changedManifests(porcelain, touchedProjects);
  if (files.length === 0) {
    onStage(app, 'done', { status: 'up to date' });
    return { app, status: 'up to date', branch, clonePath, skippedScripts: [] };
  }

  const skippedScripts = [];
  onStage(app, 'installing');
  for (const project of touchedProjects) {
    const cwd = path.join(clonePath, project.dirRel);
    const manifest = await readManifest(clonePath, project);
    // After npm update/install, package.json and the lockfile can diverge enough
    // that `npm ci` rejects them. Reinstall with `npm install` to sync + run scripts.
    await exec('npm', ['install', '--no-audit', '--no-fund'], cwd);
    const selected = qualityScripts(manifest);
    for (const name of selected.skipped) {
      skippedScripts.push({ folder: project.dirRel || '.', script: name });
    }
    for (const name of selected.run) {
      onStage(app, name);
      await exec('npm', ['run', name], cwd);
    }
  }

  onStage(app, 'committing');
  const current = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  assertSafeBranch(current, baseBranch);
  const refspec = pushRefspec(branch, baseBranch);
  await exec('git', ['add', '--', ...files]);
  await exec('git', ['commit', '-m', commitMessage(includePins)]);
  onStage(app, 'pushing');
  await exec('git', ['push', 'origin', refspec]);
  onStage(app, 'done', { status: 'pushed', branch, files });
  return {
    app,
    status: 'pushed',
    branch,
    clonePath,
    skippedScripts,
    files,
  };
}
