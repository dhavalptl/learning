#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  HELP,
  createProgress,
  isSuccess,
  mapPool,
  parseCli,
  summarize,
} from './lib/core.mjs';
import { runRepo } from './lib/update.mjs';
import { startServer } from './lib/server.mjs';

export * from './lib/core.mjs';
export { scanApp, scanAllApps, rescanApp } from './lib/scan.mjs';
export { runRepo, updateSelectedApp } from './lib/update.mjs';
export { startServer, createAppState, serializeState, createSseHub } from './lib/server.mjs';

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  try {
    options = parseCli(argv, { allowServe: true });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }

  if (options.mode === 'serve') {
    const createdTemp = !options.workDir;
    const workRoot = options.workDir ?? await mkdtemp(path.join(tmpdir(), 'update-deps-'));
    const server = await startServer({
      ...options,
      workRoot,
      createdTemp,
      stdout,
      stderr,
    });
    stdout.write(`update-deps UI listening on http://127.0.0.1:${server.port}\n`);
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

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
