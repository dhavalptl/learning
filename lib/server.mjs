import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapPool, normalizeSelections, selectionAppList, createLogger, formatError } from './core.mjs';
import { rescanApp, scanAllApps } from './scan.mjs';
import { updateSelectedApp } from './update.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export function createAppState(options) {
  const apps = {};
  for (const app of options.apps) {
    apps[app] = {
      app,
      status: 'queued',
      locks: [],
      message: '',
      clonePath: path.join(options.workRoot, app),
    };
  }
  return {
    phase: 'scanning',
    config: {
      gitUrl: options.gitUrl,
      baseBranch: options.baseBranch,
      apps: [...options.apps],
      concurrency: options.concurrency,
      includePins: options.includePins,
      timeoutMs: options.timeoutMs,
      port: options.port,
    },
    apps,
    job: null,
    logs: [],
  };
}

export function serializeState(state) {
  return {
    phase: state.phase,
    config: state.config,
    apps: Object.values(state.apps).map((app) => ({
      app: app.app,
      status: app.status,
      locks: app.locks,
      message: app.message ?? '',
      clonePath: app.clonePath,
    })),
    job: state.job
      ? {
          id: state.job.id,
          status: state.job.status,
          concurrency: state.job.concurrency,
          apps: state.job.apps,
          results: state.job.results,
          error: state.job.error ?? null,
        }
      : null,
    logs: state.logs ?? [],
  };
}

export function createSseHub() {
  const clients = new Set();

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  return {
    subscribe(res) {
      clients.add(res);
      res.write(': connected\n\n');
      return () => clients.delete(res);
    },
    broadcast(event, data) {
      for (const res of clients) {
        try {
          send(res, event, data);
        } catch {
          clients.delete(res);
        }
      }
    },
    heartbeat() {
      for (const res of clients) {
        try {
          res.write(': ping\n\n');
        } catch {
          clients.delete(res);
        }
      }
    },
    size() {
      return clients.size;
    },
  };
}

function initialJobApps(selections) {
  const apps = {};
  for (const app of selectionAppList(selections)) {
    apps[app] = {
      app,
      stage: 'queued',
      completed: [],
      status: 'queued',
      message: '',
      branch: null,
    };
  }
  return apps;
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(urlPath, res) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel.includes('..')) {
    res.writeHead(400).end('Bad path');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, rel.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(400).end('Bad path');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

export async function startServer(options) {
  const state = createAppState(options);
  const hub = createSseHub();
  let jobAbort = null;
  let jobRunning = false;
  const rescanning = new Set();
  const log = createLogger({
    stream: options.stderr ?? process.stderr,
    onEntry(entry) {
      state.logs.push(entry);
      while (state.logs.length > 500) state.logs.shift();
      hub.broadcast('log', entry);
    },
  });

  const heartbeat = setInterval(() => hub.heartbeat(), 15_000);
  heartbeat.unref?.();

  function applyScanResult(result) {
    const entry = state.apps[result.app] ?? {
      app: result.app,
      locks: [],
      status: result.status,
      message: '',
      clonePath: result.clonePath,
    };
    entry.status = result.status;
    entry.locks = result.locks ?? [];
    entry.clonePath = result.clonePath;
    entry.message = result.message ?? (result.error ? formatError(result.error) : '');
    state.apps[result.app] = entry;
    if (entry.status === 'failed') {
      log.error(entry.message || 'scan failed', { app: entry.app });
    } else {
      const libCount = entry.locks.reduce((sum, lock) => sum + (lock.libs?.length ?? 0), 0);
      log.info(`ready · ${entry.locks.length} lockfile(s) · ${libCount} outdated`, { app: entry.app });
    }
    hub.broadcast('scan.app', {
      app: entry.app,
      status: entry.status,
      locks: entry.locks,
      message: entry.message,
      clonePath: entry.clonePath,
    });
    return entry;
  }

  async function runScan() {
    state.phase = 'scanning';
    log.info(`Scanning ${options.apps.length} app(s) in parallel (concurrency ignored for scan)`);
    hub.broadcast('phase', { phase: 'scanning' });
    hub.broadcast('state', serializeState(state));

    await scanAllApps({
      apps: options.apps,
      gitUrl: options.gitUrl,
      baseBranch: options.baseBranch,
      includePins: options.includePins,
      timeoutMs: options.timeoutMs,
      workRoot: options.workRoot,
      onStatus(app, status) {
        if (state.apps[app]) {
          state.apps[app].status = status;
          if (status !== 'ready' && status !== 'failed') {
            log.info(status, { app });
          }
          hub.broadcast('scan.app', { app, status });
        }
      },
      onApp(result) {
        applyScanResult(result);
      },
    });

    const failed = Object.values(state.apps).filter((app) => app.status === 'failed').length;
    state.phase = 'ready';
    log.info(failed ? `Scan finished with ${failed} failure(s)` : 'Scan finished');
    hub.broadcast('scan.done', { phase: 'ready' });
    hub.broadcast('state', serializeState(state));
  }

  async function runRescan(app) {
    rescanning.add(app);
    const entry = state.apps[app];
    if (entry) {
      entry.status = 'cloning';
      entry.message = '';
      entry.locks = [];
    }
    log.info('Rescan started', { app });
    // Drop stale progress for this app — previous job results no longer apply.
    if (state.job?.apps?.[app]) {
      delete state.job.apps[app];
      if (state.job.results) {
        state.job.results = state.job.results.filter((result) => result.app !== app);
      }
      if (Object.keys(state.job.apps).length === 0) {
        state.job = null;
      }
      hub.broadcast('state', serializeState(state));
    }
    // Immediate UI feedback only — do not log "cloning" here; scanApp emits it once.
    hub.broadcast('scan.app', {
      app,
      status: 'cloning',
      locks: [],
      message: '',
      clonePath: entry?.clonePath ?? path.join(options.workRoot, app),
    });
    hub.broadcast('rescan.start', { app });

    try {
      const result = await rescanApp({
        app,
        gitUrl: options.gitUrl,
        baseBranch: options.baseBranch,
        includePins: options.includePins,
        timeoutMs: options.timeoutMs,
        workRoot: options.workRoot,
        onStatus(name, status) {
          if (state.apps[name]) {
            state.apps[name].status = status;
            // ready/failed are logged with detail in applyScanResult
            if (status !== 'ready' && status !== 'failed') {
              log.info(status, { app: name });
            }
            hub.broadcast('scan.app', { app: name, status });
          }
        },
      });
      applyScanResult(result);
      hub.broadcast('rescan.done', { app, status: 'ready' });
    } catch (error) {
      const failed = {
        app,
        status: 'failed',
        error,
        clonePath: path.join(options.workRoot, app),
        locks: [],
        message: formatError(error),
      };
      applyScanResult(failed);
      hub.broadcast('rescan.done', { app, status: 'failed', message: failed.message });
    } finally {
      rescanning.delete(app);
    }
  }

  async function runJob(selections) {
    const id = `job-${Date.now()}`;
    const apps = initialJobApps(selections);
    state.job = {
      id,
      status: 'running',
      concurrency: options.concurrency,
      apps,
      results: [],
      error: null,
    };
    state.phase = 'updating';
    jobRunning = true;
    jobAbort = new AbortController();
    log.info(`Job ${id} started · ${Object.keys(apps).length} app(s) · concurrency ${options.concurrency}`);
    hub.broadcast('job.start', { id, apps: Object.keys(apps), concurrency: options.concurrency });
    hub.broadcast('state', serializeState(state));

    const appNames = selectionAppList(selections);
    try {
      const results = await mapPool(appNames, options.concurrency, async (app) => {
        const jobApp = state.job.apps[app];
        const onStage = (name, stage, extra = {}) => {
          if (jobApp.stage && jobApp.stage !== stage) {
            if (!jobApp.completed.includes(jobApp.stage)) jobApp.completed.push(jobApp.stage);
          }
          jobApp.stage = stage;
          if (stage === 'done') {
            jobApp.status = extra.status ?? 'pushed';
            if (!jobApp.completed.includes('done')) jobApp.completed.push('done');
          } else {
            jobApp.status = stage;
          }
          if (extra.message) jobApp.message = extra.message;
          if (extra.branch) jobApp.branch = extra.branch;
          log.info(`${stage}${extra.status ? ` (${extra.status})` : ''}`, { app: name });
          hub.broadcast('job.app', {
            id,
            app: name,
            stage: jobApp.stage,
            completed: [...jobApp.completed],
            status: jobApp.status,
            message: jobApp.message,
            branch: jobApp.branch,
          });
        };

        // Explicit queued until worker picks up
        hub.broadcast('job.app', {
          id,
          app,
          stage: 'queued',
          completed: [],
          status: 'queued',
          message: '',
          branch: null,
        });

        try {
          const result = await updateSelectedApp({
            app,
            baseBranch: options.baseBranch,
            includePins: options.includePins,
            timeoutMs: options.timeoutMs,
            clonePath: state.apps[app]?.clonePath,
            selections,
            onStage,
            signal: AbortSignal.any([
              jobAbort.signal,
              AbortSignal.timeout(options.timeoutMs),
            ]),
          });
          if (result.status === 'up to date') {
            jobApp.status = 'up to date';
            jobApp.stage = 'done';
            if (!jobApp.completed.includes('done')) jobApp.completed.push('done');
          } else {
            jobApp.status = 'pushed';
            jobApp.stage = 'done';
            jobApp.branch = result.branch;
            if (!jobApp.completed.includes('done')) jobApp.completed.push('done');
          }
          log.info(`${jobApp.status}${jobApp.branch ? ` · ${jobApp.branch}` : ''}`, { app });
          hub.broadcast('job.app', {
            id,
            app,
            stage: jobApp.stage,
            completed: [...jobApp.completed],
            status: jobApp.status,
            message: jobApp.message,
            branch: jobApp.branch,
          });
          return result;
        } catch (error) {
          const message = formatError(error);
          jobApp.stage = 'failed';
          jobApp.status = 'failed';
          jobApp.message = message;
          log.error(message, { app });
          hub.broadcast('job.app', {
            id,
            app,
            stage: 'failed',
            completed: [...jobApp.completed],
            status: 'failed',
            message: jobApp.message,
            branch: null,
          });
          return { app, status: 'failed', error, clonePath: state.apps[app]?.clonePath };
        }
      });

      state.job.results = results.map((result) => ({
        app: result.app,
        status: result.status,
        branch: result.branch ?? null,
        message: result.error ? formatError(result.error) : '',
      }));
      state.job.status = results.every((r) => r.status === 'pushed' || r.status === 'up to date')
        ? 'done'
        : 'done_with_errors';
      state.phase = 'ready';
      log.info(`Job ${id} ${state.job.status}`);
      hub.broadcast('job.done', {
        id,
        status: state.job.status,
        results: state.job.results,
      });
      hub.broadcast('state', serializeState(state));
    } catch (error) {
      const message = formatError(error);
      state.job.status = 'failed';
      state.job.error = message;
      state.phase = 'ready';
      log.error(`Job ${id} failed: ${message}`);
      hub.broadcast('job.done', { id, status: 'failed', error: message });
      hub.broadcast('state', serializeState(state));
    } finally {
      jobRunning = false;
      jobAbort = null;
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === '/api/state') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(serializeState(state)));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        const unsubscribe = hub.subscribe(res);
        res.write(`event: state\ndata: ${JSON.stringify(serializeState(state))}\n\n`);
        req.on('close', unsubscribe);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/run') {
        if (state.phase === 'scanning') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Scan still running' }));
          return;
        }
        if (jobRunning) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Update job already running' }));
          return;
        }
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        let selections;
        try {
          selections = normalizeSelections(body.selections ?? {});
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        if (selectionAppList(selections).length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Select at least one package' }));
          return;
        }
        for (const app of selectionAppList(selections)) {
          if (rescanning.has(app)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `App ${app} is still rescanning` }));
            return;
          }
          if (state.apps[app]?.status !== 'ready') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `App ${app} is not ready` }));
            return;
          }
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        queueMicrotask(() => {
          runJob(selections).catch((error) => {
            log.error(formatError(error));
          });
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/rescan') {
        if (jobRunning || state.phase === 'updating') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot rescan while an update job is running' }));
          return;
        }
        if (state.phase === 'scanning') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Initial scan still running' }));
          return;
        }
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        const app = String(body.app ?? '').trim();
        if (!options.apps.includes(app)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown app' }));
          return;
        }
        if (rescanning.has(app)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `App ${app} is already rescanning` }));
          return;
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, app }));
        queueMicrotask(() => {
          runRescan(app).catch((error) => {
            log.error(formatError(error), { app });
          });
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/cancel') {
        if (!jobRunning || !jobAbort) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No running job' }));
          return;
        }
        log.warn('Cancel requested');
        jobAbort.abort();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'GET') {
        await serveStatic(url.pathname, res);
        return;
      }

      res.writeHead(405).end('Method not allowed');
    } catch (error) {
      log.error(formatError(error));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message ?? 'Server error' }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  log.info(`UI listening on http://127.0.0.1:${port}`);
  log.info(`work-dir ${options.workRoot}`);

  // Kick off scan without blocking listen
  queueMicrotask(() => {
    runScan().catch((error) => {
      state.phase = 'ready';
      const message = formatError(error);
      log.error(`scan failed: ${message}`);
      hub.broadcast('scan.done', { phase: 'ready', error: message });
      hub.broadcast('state', serializeState(state));
    });
  });

  const shutdown = async () => {
    clearInterval(heartbeat);
    jobAbort?.abort();
    await new Promise((resolve) => server.close(resolve));
  };

  return { server, port, state, hub, shutdown, log };
}
