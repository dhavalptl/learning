import path from 'node:path';
import { rm } from 'node:fs/promises';
import {
  classifyOutdated,
  discoverLockfiles,
  formatError,
  mapPool,
  readManifest,
  readOutdated,
  repoUrl,
  resolvePinInstalls,
  runCommand,
} from './core.mjs';

/**
 * Clone an app (if needed) and build an outdated inventory for every lockfile.
 * Does not mutate package files.
 */
export async function scanApp({
  app,
  gitUrl,
  baseBranch,
  includePins = false,
  timeoutMs,
  workRoot,
  clonePath: existingClone,
  onStatus = () => {},
  run = runCommand,
  signal,
}) {
  const url = repoUrl(gitUrl, app);
  const clonePath = existingClone ?? path.join(workRoot, app);
  const repoSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const exec = (command, args, cwd = clonePath) => run(command, args, { cwd, signal: repoSignal });

  onStatus(app, 'cloning');
  // Drop any leftover clone, including an update branch from a previous run, then clone the base branch.
  await rm(clonePath, { recursive: true, force: true });
  await exec('git', ['clone', '--branch', baseBranch, '--single-branch', '--depth', '1', url, clonePath], workRoot);

  const projects = await discoverLockfiles(clonePath);
  if (projects.length === 0) throw new Error(`No package-lock.json found in ${app}`);

  onStatus(app, 'scanning');
  const locks = [];
  for (const project of projects) {
    const cwd = path.join(clonePath, project.dirRel);
    const manifest = await readManifest(clonePath, project);
    await exec('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], cwd);
    const outdated = await readOutdated(cwd, exec);
    const { ranged, pins } = classifyOutdated(manifest, outdated, { includePins });

    const libs = [];
    for (const name of ranged) {
      const info = outdated[name] ?? {};
      libs.push({
        name,
        current: String(info.current ?? ''),
        available: String(info.wanted ?? ''),
        kind: 'ranged',
      });
    }

    if (includePins) {
      const pinInstalls = await resolvePinInstalls(pins, cwd, exec);
      for (const pin of pinInstalls) {
        libs.push({
          name: pin.name,
          current: pin.current,
          available: pin.available,
          kind: 'pin',
        });
      }
    }

    libs.sort((left, right) => left.name.localeCompare(right.name));
    locks.push({
      dirRel: project.dirRel,
      lockRel: project.lockRel,
      manifestRel: project.manifestRel,
      libs,
    });
  }

  onStatus(app, 'ready');
  return {
    app,
    status: 'ready',
    clonePath,
    locks,
  };
}

/**
 * Delete the existing clone and scan again from the base branch.
 */
export async function rescanApp({
  app,
  gitUrl,
  baseBranch,
  includePins = false,
  timeoutMs,
  workRoot,
  onStatus = () => {},
  run = runCommand,
  signal,
}) {
  const clonePath = path.join(workRoot, app);
  // Remove stale clone quietly; scanApp owns cloning/scanning status events.
  await rm(clonePath, { recursive: true, force: true });
  return scanApp({
    app,
    gitUrl,
    baseBranch,
    includePins,
    timeoutMs,
    workRoot,
    clonePath,
    onStatus,
    run,
    signal,
  });
}

export async function scanAllApps({
  apps,
  gitUrl,
  baseBranch,
  includePins = false,
  timeoutMs,
  workRoot,
  concurrency = apps.length || 1,
  onApp = () => {},
  onStatus = () => {},
  run = runCommand,
  signal,
}) {
  return mapPool(apps, concurrency, async (app) => {
    try {
      const result = await scanApp({
        app,
        gitUrl,
        baseBranch,
        includePins,
        timeoutMs,
        workRoot,
        onStatus,
        run,
        signal,
      });
      onApp(result);
      return result;
    } catch (error) {
      const failed = {
        app,
        status: 'failed',
        error,
        clonePath: path.join(workRoot, app),
        locks: [],
        message: formatError(error),
      };
      onStatus(app, 'failed');
      onApp(failed);
      return failed;
    }
  });
}
