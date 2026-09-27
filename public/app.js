const STAGES = [
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

const STAGE_LABELS = {
  queued: 'Queued',
  branching: 'Branching',
  updating: 'Updating packages',
  installing: 'Installing',
  lint: 'Lint',
  test: 'Test',
  build: 'Build',
  committing: 'Committing',
  pushing: 'Pushing',
  done: 'Done',
  failed: 'Failed',
};

const state = {
  phase: 'connecting',
  config: null,
  apps: new Map(),
  selection: new Set(),
  openApps: new Set(),
  openLocks: new Set(),
  job: null,
  logs: [],
  logsOpen: false,
};

const els = {
  phasePill: document.getElementById('phase-pill'),
  metaApps: document.getElementById('meta-apps'),
  metaConcurrency: document.getElementById('meta-concurrency'),
  inventoryHint: document.getElementById('inventory-hint'),
  apps: document.getElementById('apps'),
  progressHint: document.getElementById('progress-hint'),
  jobApps: document.getElementById('job-apps'),
  selectionCount: document.getElementById('selection-count'),
  clearBtn: document.getElementById('clear-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  runBtn: document.getElementById('run-btn'),
  logView: document.getElementById('log-view'),
  clearLogsBtn: document.getElementById('clear-logs-btn'),
  logsToggle: document.getElementById('logs-toggle'),
  logsPanel: document.getElementById('logs-panel'),
};

function libKey(app, lockRel, name) {
  return `${app}\0${lockRel}\0${name}`;
}

function parseKey(key) {
  const [app, lockRel, name] = key.split('\0');
  return { app, lockRel, name };
}

function badgeEl(text, tone) {
  const el = document.createElement('span');
  el.className = `badge badge-${tone}`;
  el.textContent = text;
  return el;
}

function setBadge(el, text, tone, { busy = false, hidden = false, status = false } = {}) {
  if (!el) return;
  el.hidden = hidden;
  el.textContent = text;
  el.className = status
    ? `badge badge-status badge-${tone}`
    : `badge badge-${tone}`;
  if (busy) el.dataset.busy = 'true';
  else delete el.dataset.busy;
}

function applySnapshot(snapshot) {
  state.phase = snapshot.phase;
  state.config = snapshot.config;
  state.apps = new Map((snapshot.apps ?? []).map((app) => [app.app, app]));
  state.job = snapshot.job;
  if (Array.isArray(snapshot.logs)) state.logs = snapshot.logs;
  for (const app of state.apps.values()) {
    if (app.status === 'failed') state.openApps.add(app.app);
    if (app.status === 'ready' || app.status === 'failed') {
      for (const lock of app.locks ?? []) {
        state.openLocks.add(lockKey(app.app, lock.lockRel));
      }
    }
  }
  renderAll();
}

function phaseTone(phase) {
  if (phase === 'ready') return 'success';
  if (phase === 'updating' || phase === 'scanning' || phase === 'connecting') return 'warn';
  if (phase === 'failed') return 'error';
  return 'neutral';
}

function setPhase(phase) {
  state.phase = phase;
  setBadge(els.phasePill, labelPhase(phase), phaseTone(phase), {
    busy: phase === 'scanning' || phase === 'updating' || phase === 'connecting',
    status: true,
  });
}

function labelPhase(phase) {
  if (phase === 'scanning') return 'Scanning';
  if (phase === 'ready') return 'Ready';
  if (phase === 'updating') return 'Updating';
  if (phase === 'connecting') return 'Connecting';
  return phase;
}

function countLibs(app) {
  return (app.locks ?? []).reduce((sum, lock) => sum + (lock.libs?.length ?? 0), 0);
}

function appLibKeys(app) {
  const keys = [];
  for (const lock of app.locks ?? []) {
    for (const lib of lock.libs ?? []) {
      keys.push(libKey(app.app, lock.lockRel, lib.name));
    }
  }
  return keys;
}

function lockKey(app, lockRel) {
  return `${app}\0${lockRel}`;
}

function lockPathLabel(lock) {
  const dir = lock.dirRel ?? '';
  const file = (() => {
    const rel = lock.lockRel || 'package-lock.json';
    const parts = rel.split('/');
    return parts.at(-1) || 'package-lock.json';
  })();
  if (!dir) return `Root / ${file}`;
  return `${dir} / ${file}`;
}

function lockLibKeys(appName, lock) {
  return (lock.libs ?? []).map((lib) => libKey(appName, lock.lockRel, lib.name));
}

function checkboxState(keys) {
  if (keys.length === 0) return { checked: false, indeterminate: false };
  let selected = 0;
  for (const key of keys) if (state.selection.has(key)) selected += 1;
  if (selected === 0) return { checked: false, indeterminate: false };
  if (selected === keys.length) return { checked: true, indeterminate: false };
  return { checked: false, indeterminate: true };
}

function jobStatusTone(status) {
  if (status === 'pushed' || status === 'up to date' || status === 'done') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'queued') return 'neutral';
  return 'warn';
}

function jobStatusLabel(status) {
  if (status === 'up to date') return 'Up to date';
  if (status === 'pushed') return 'Pushed';
  if (status === 'failed') return 'Failed';
  if (status === 'queued') return 'Queued';
  if (!status) return 'Unknown';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function renderMeta() {
  const cfg = state.config;
  if (cfg) {
    setBadge(els.metaApps, `Total apps : ${cfg.apps.length}`, 'info');
    setBadge(els.metaConcurrency, `Parallel updates : ${cfg.concurrency}`, 'info');
  } else {
    setBadge(els.metaApps, '', 'info', { hidden: true });
    setBadge(els.metaConcurrency, '', 'info', { hidden: true });
  }
  setPhase(state.phase);
  renderLogsToggle();

  if (state.phase === 'scanning') {
    els.inventoryHint.textContent = 'Cloning apps and reading outdated packages…';
  } else if (state.phase === 'ready') {
    els.inventoryHint.textContent = 'Select packages by app, lockfile, or individually.';
  } else if (state.phase === 'updating') {
    els.inventoryHint.textContent = 'Update job in progress. Selection is locked.';
  }
}

function renderLogsToggle() {
  if (!els.logsToggle || !els.logsPanel) return;
  els.logsToggle.setAttribute('aria-pressed', state.logsOpen ? 'true' : 'false');
  els.logsToggle.textContent = 'Logs';
  els.logsPanel.hidden = !state.logsOpen;
  els.logsPanel.classList.toggle('is-hidden', !state.logsOpen);
}

function renderInventory() {
  const apps = [...state.apps.values()].sort((a, b) => a.app.localeCompare(b.app));
  if (apps.length === 0) {
    els.apps.innerHTML = '<p class="empty">Waiting for apps…</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const app of apps) {
    const card = document.createElement('article');
    card.className = `app${state.openApps.has(app.app) ? ' is-open' : ''}${app.status === 'failed' ? ' is-failed' : ''}`;
    card.dataset.app = app.app;

    const keys = appLibKeys(app);
    const appCheck = checkboxState(keys);
    const canSelect = app.status === 'ready' && keys.length > 0 && state.phase !== 'updating';

    const row = document.createElement('div');
    row.className = 'app-head';

    const appCb = document.createElement('input');
    appCb.type = 'checkbox';
    appCb.className = 'check';
    appCb.checked = appCheck.checked;
    appCb.indeterminate = appCheck.indeterminate;
    appCb.disabled = !canSelect;
    appCb.title = 'Select all packages in this app';
    appCb.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleKeys(keys, appCb.checked);
    });

    const name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = app.app;

    const meta = document.createElement('div');
    meta.className = 'app-meta';

    const isBusy = app.status === 'scanning' || app.status === 'cloning' || app.status === 'queued';
    const canReload = state.phase !== 'updating'
      && state.phase !== 'scanning'
      && !isBusy
      && (app.status === 'ready' || app.status === 'failed');

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = `btn-icon${isBusy ? ' is-spinning' : ''}`;
    reloadBtn.title = 'Rescan this app';
    reloadBtn.setAttribute('aria-label', `Rescan ${app.app}`);
    reloadBtn.disabled = !canReload;
    reloadBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M13.65 2.35A7.96 7.96 0 0 0 8 0C3.58 0 .01 3.58.01 8S3.58 16 8 16c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 8 14c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z"/></svg>';
    reloadBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      requestRescan(app.app);
    });
    meta.append(reloadBtn);

    if (app.status === 'failed') {
      meta.append(badgeEl('Failed', 'error'));
    } else if (app.status === 'ready') {
      meta.append(badgeEl('Ready', 'success'));
      const outdated = countLibs(app);
      if (outdated > 0) meta.append(badgeEl(`${outdated} outdated`, 'warn'));
      else meta.append(badgeEl('Up to date', 'info'));
    } else if (isBusy) {
      meta.append(badgeEl(jobStatusLabel(app.status), 'warn'));
    } else {
      meta.append(badgeEl(jobStatusLabel(app.status), 'neutral'));
    }

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.setAttribute('aria-hidden', 'true');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'app-open';
    openBtn.append(name, meta, chevron);
    openBtn.addEventListener('click', () => {
      if (state.openApps.has(app.app)) state.openApps.delete(app.app);
      else state.openApps.add(app.app);
      renderInventory();
    });

    row.append(appCb, openBtn);
    card.append(row);

    const body = document.createElement('div');
    body.className = 'app-body';

    if (app.status === 'failed') {
      const note = document.createElement('pre');
      note.className = 'app-error';
      note.textContent = app.message || 'Scan failed for this app. Open Logs for details.';
      body.append(note);
    } else if ((app.locks ?? []).length === 0) {
      const note = document.createElement('p');
      note.className = 'muted-note';
      note.textContent = app.status === 'ready' ? 'No outdated packages.' : 'Scanning…';
      body.append(note);
    } else {
      for (const lock of app.locks) {
        body.append(renderLock(app, lock, canSelect));
      }
    }

    card.append(body);
    frag.append(card);
  }
  els.apps.replaceChildren(frag);
}

function renderLock(app, lock, canSelect) {
  const wrap = document.createElement('div');
  const key = lockKey(app.app, lock.lockRel);
  const isOpen = state.openLocks.has(key);
  wrap.className = `lock${isOpen ? ' is-open' : ''}`;

  const head = document.createElement('div');
  head.className = 'lock-head';

  const keys = lockLibKeys(app.app, lock);
  const lockCheck = checkboxState(keys);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'check';
  cb.checked = lockCheck.checked;
  cb.indeterminate = lockCheck.indeterminate;
  cb.disabled = !canSelect || keys.length === 0;
  cb.title = 'Select all packages in this lockfile';
  cb.addEventListener('click', (event) => event.stopPropagation());
  cb.addEventListener('change', () => toggleKeys(keys, cb.checked));

  const label = document.createElement('div');
  label.className = 'lock-label';

  const pathEl = document.createElement('span');
  pathEl.className = 'lock-path';
  pathEl.textContent = lockPathLabel(lock);

  label.append(pathEl);

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.setAttribute('aria-hidden', 'true');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'lock-toggle';
  toggle.append(label, chevron);
  toggle.addEventListener('click', () => {
    if (state.openLocks.has(key)) state.openLocks.delete(key);
    else state.openLocks.add(key);
    renderInventory();
  });

  head.append(cb, toggle);
  wrap.append(head);

  const body = document.createElement('div');
  body.className = 'lock-body';

  const libs = document.createElement('div');
  libs.className = 'libs';
  if ((lock.libs ?? []).length === 0) {
    const note = document.createElement('p');
    note.className = 'muted-note';
    note.textContent = 'No outdated packages in this lockfile.';
    body.append(note);
  } else {
    for (const lib of lock.libs ?? []) {
      const libId = libKey(app.app, lock.lockRel, lib.name);
      const row = document.createElement('label');
      row.className = 'lib';

      const libCb = document.createElement('input');
      libCb.type = 'checkbox';
      libCb.className = 'check';
      libCb.checked = state.selection.has(libId);
      libCb.disabled = !canSelect;
      libCb.addEventListener('change', () => {
        if (libCb.checked) state.selection.add(libId);
        else state.selection.delete(libId);
        renderSelectionBar();
        renderInventory();
      });

      const name = document.createElement('span');
      name.className = 'lib-name';
      name.textContent = lib.name;

      const right = document.createElement('span');
      right.className = 'lib-right';

      if (lib.kind === 'pin') {
        const pin = document.createElement('span');
        pin.className = 'badge badge-warn badge-pin';
        pin.textContent = 'Pinned';
        pin.title = 'Exact pinned version in package.json';
        right.append(pin);
      }

      const ver = document.createElement('span');
      ver.className = 'lib-ver';
      ver.innerHTML = `${escapeHtml(lib.current)} → <strong>${escapeHtml(lib.available)}</strong>`;
      right.append(ver);

      row.append(libCb, name, right);
      libs.append(row);
    }
    body.append(libs);
  }

  wrap.append(body);
  return wrap;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function toggleKeys(keys, checked) {
  for (const key of keys) {
    if (checked) state.selection.add(key);
    else state.selection.delete(key);
  }
  renderSelectionBar();
  renderInventory();
}

function renderSelectionBar() {
  const count = state.selection.size;
  els.selectionCount.textContent = `${count} package${count === 1 ? '' : 's'} selected`;
  const canRun = state.phase === 'ready' && count > 0;
  els.runBtn.disabled = !canRun;
  els.clearBtn.disabled = count === 0 || state.phase === 'updating';
  els.cancelBtn.hidden = state.phase !== 'updating';
}

function renderProgress() {
  if (!state.job || !state.job.apps) {
    els.progressHint.textContent = 'Submit a selection to start an update job.';
    els.jobApps.innerHTML = '<p class="empty">No active job.</p>';
    return;
  }

  if (state.job.status === 'running') {
    els.progressHint.textContent = `Running with concurrency ${state.job.concurrency}. Extra apps stay queued.`;
  } else if (state.job.status === 'done_with_errors') {
    els.progressHint.textContent = 'Job finished with errors. Open Logs for details.';
  } else if (state.job.status === 'failed') {
    els.progressHint.textContent = 'Job failed. Open Logs for details.';
  } else {
    els.progressHint.textContent = 'Job completed.';
  }

  const apps = Object.values(state.job.apps).sort((a, b) => a.app.localeCompare(b.app));
  const frag = document.createDocumentFragment();
  for (const app of apps) {
    frag.append(renderJobApp(app));
  }
  els.jobApps.replaceChildren(frag);
}

function renderJobApp(app) {
  const card = document.createElement('article');
  card.className = 'job-app';

  const title = document.createElement('div');
  title.className = 'job-app-title';
  const name = document.createElement('div');
  name.textContent = app.app;
  title.append(name, badgeEl(jobStatusLabel(app.status), jobStatusTone(app.status)));
  card.append(title);

  const list = document.createElement('ul');
  list.className = 'stages';
  const completed = new Set(app.completed ?? []);
  const current = app.stage;
  const failed = app.status === 'failed';
  const stageIndex = (name) => STAGES.indexOf(name);
  const currentIdx = stageIndex(current);

  // Once work starts past queued, treat queued as completed even if older events omitted it.
  if (currentIdx > 0 || completed.size > 0 || app.status === 'pushed' || app.status === 'up to date' || failed) {
    completed.add('queued');
  }

  for (const stage of STAGES) {
    if (['lint', 'test', 'build'].includes(stage)) {
      const reachedQuality = completed.has(stage) || current === stage;
      const pastInstall = completed.has('installing')
        || ['lint', 'test', 'build', 'committing', 'pushing', 'done'].includes(current);
      if (!reachedQuality && (app.status === 'up to date' || (failed && !pastInstall))) {
        continue;
      }
      if (!reachedQuality && app.status === 'pushed' && !completed.has(stage) && current === 'done') {
        continue;
      }
    }

    const li = document.createElement('li');
    li.className = 'stage';
    const mark = document.createElement('span');
    mark.className = 'mark';
    const label = document.createElement('span');
    label.textContent = STAGE_LABELS[stage] ?? stage;

    if (completed.has(stage) || (stage === 'done' && (app.status === 'pushed' || app.status === 'up to date'))) {
      li.classList.add('is-done');
    } else if (failed && stage === current) {
      li.classList.add('is-failed');
    } else if (stage === current) {
      li.classList.add('is-active');
    } else {
      li.classList.add('is-pending');
    }

    if (failed && stage === current) {
      li.classList.remove('is-active', 'is-pending');
      li.classList.add('is-failed');
    }

    li.append(mark, label);
    list.append(li);
  }

  // Errors live in Logs only — progress shows stage checklist + status badge.
  card.append(list);
  return card;
}

function renderLogs() {
  if (!els.logView) return;
  if (state.logs.length === 0) {
    els.logView.textContent = 'No log entries yet.';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of state.logs) {
    const line = document.createElement('span');
    line.className = `log-line is-${entry.level || 'info'}`;
    const time = (entry.ts || '').slice(11, 19);
    const app = entry.app ? ` ${entry.app}` : '';
    line.textContent = `${time} ${String(entry.level || 'info').toUpperCase()}${app}  ${entry.message}`;
    frag.append(line, document.createTextNode('\n'));
  }
  const nearBottom = els.logView.scrollHeight - els.logView.scrollTop - els.logView.clientHeight < 48;
  els.logView.replaceChildren(frag);
  if (nearBottom || state.logs.length < 20) {
    els.logView.scrollTop = els.logView.scrollHeight;
  }
}

function pushLog(entry) {
  state.logs.push(entry);
  while (state.logs.length > 500) state.logs.shift();
  renderLogs();
}

function renderAll() {
  renderMeta();
  renderInventory();
  renderProgress();
  renderSelectionBar();
  renderLogs();
}

function selectionsPayload() {
  const selections = {};
  for (const key of state.selection) {
    const { app, lockRel, name } = parseKey(key);
    selections[app] ??= {};
    selections[app][lockRel] ??= [];
    selections[app][lockRel].push(name);
  }
  return selections;
}

function clearAppSelection(appName) {
  for (const key of [...state.selection]) {
    if (key.startsWith(`${appName}\0`)) state.selection.delete(key);
  }
}

async function requestRescan(appName) {
  clearAppSelection(appName);
  clearAppProgress(appName);
  renderSelectionBar();
  renderProgress();
  const current = state.apps.get(appName);
  if (current) {
    state.apps.set(appName, {
      ...current,
      status: 'cloning',
      locks: [],
      message: '',
    });
    renderInventory();
  }
  try {
    const res = await fetch('/api/rescan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appName }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      pushLog({
        id: Date.now(),
        ts: new Date().toISOString(),
        level: 'error',
        message: body.error || `Failed to rescan ${appName}`,
        app: appName,
      });
      if (current) {
        state.apps.set(appName, current);
        renderInventory();
      }
    }
  } catch (error) {
    pushLog({
      id: Date.now(),
      ts: new Date().toISOString(),
      level: 'error',
      message: error.message,
      app: appName,
    });
    if (current) {
      state.apps.set(appName, current);
      renderInventory();
    }
  }
}

function clearAppProgress(appName) {
  if (!state.job?.apps) return;
  if (!state.job.apps[appName]) return;
  delete state.job.apps[appName];
  if (Array.isArray(state.job.results)) {
    state.job.results = state.job.results.filter((result) => result.app !== appName);
  }
  if (Object.keys(state.job.apps).length === 0) {
    state.job = null;
  }
}

els.clearBtn.addEventListener('click', () => {
  state.selection.clear();
  renderSelectionBar();
  renderInventory();
});

els.clearLogsBtn?.addEventListener('click', () => {
  state.logs = [];
  renderLogs();
});

els.logsToggle?.addEventListener('click', () => {
  state.logsOpen = !state.logsOpen;
  renderLogsToggle();
  if (state.logsOpen) renderLogs();
});

els.runBtn.addEventListener('click', async () => {
  els.runBtn.disabled = true;
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections: selectionsPayload() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body.error || 'Failed to start job';
      els.progressHint.textContent = 'Could not start job. Open Logs for details.';
      pushLog({
        id: Date.now(),
        ts: new Date().toISOString(),
        level: 'error',
        message,
        app: null,
      });
      state.logsOpen = true;
      renderLogsToggle();
      renderSelectionBar();
      return;
    }
    setPhase('updating');
    renderSelectionBar();
  } catch (error) {
    els.progressHint.textContent = 'Could not start job. Open Logs for details.';
    pushLog({
      id: Date.now(),
      ts: new Date().toISOString(),
      level: 'error',
      message: error.message,
      app: null,
    });
    state.logsOpen = true;
    renderLogsToggle();
    renderSelectionBar();
  }
});

els.cancelBtn.addEventListener('click', async () => {
  await fetch('/api/cancel', { method: 'POST' });
});

function connectEvents() {
  const source = new EventSource('/api/events');

  source.addEventListener('state', (event) => {
    applySnapshot(JSON.parse(event.data));
  });

  source.addEventListener('phase', (event) => {
    const data = JSON.parse(event.data);
    setPhase(data.phase);
  });

  source.addEventListener('scan.app', (event) => {
    const data = JSON.parse(event.data);
    const prev = state.apps.get(data.app) ?? { app: data.app, locks: [], status: 'queued' };
    state.apps.set(data.app, {
      ...prev,
      ...data,
      locks: data.locks ?? prev.locks ?? [],
    });
    if (data.status === 'cloning' || data.status === 'scanning') {
      clearAppSelection(data.app);
    }
    if (data.status === 'ready' || data.status === 'failed') {
      state.openApps.add(data.app);
      for (const lock of data.locks ?? []) {
        state.openLocks.add(lockKey(data.app, lock.lockRel));
      }
    }
    renderInventory();
    renderSelectionBar();
    renderMeta();
  });

  source.addEventListener('rescan.start', (event) => {
    const data = JSON.parse(event.data);
    clearAppProgress(data.app);
    renderProgress();
  });

  source.addEventListener('rescan.done', (event) => {
    const data = JSON.parse(event.data);
    clearAppSelection(data.app);
    renderSelectionBar();
    renderInventory();
  });

  source.addEventListener('scan.done', (event) => {
    const data = JSON.parse(event.data);
    setPhase(data.phase ?? 'ready');
    if (data.error) {
      pushLog({
        id: Date.now(),
        ts: new Date().toISOString(),
        level: 'error',
        message: data.error,
        app: null,
      });
      state.logsOpen = true;
      renderLogsToggle();
    }
    renderSelectionBar();
    renderMeta();
  });

  source.addEventListener('log', (event) => {
    const entry = JSON.parse(event.data);
    pushLog(entry);
    if (entry.level === 'error' && !state.logsOpen) {
      // Keep collapsed unless user opens Logs; progress hint points there.
    }
  });

  source.addEventListener('job.start', (event) => {
    const data = JSON.parse(event.data);
    const apps = {};
    for (const app of data.apps) {
      apps[app] = {
        app,
        stage: 'queued',
        completed: [],
        status: 'queued',
        message: '',
        branch: null,
      };
    }
    state.job = {
      id: data.id,
      status: 'running',
      concurrency: data.concurrency,
      apps,
    };
    setPhase('updating');
    renderProgress();
    renderSelectionBar();
  });

  source.addEventListener('job.app', (event) => {
    const data = JSON.parse(event.data);
    if (!state.job) return;
    state.job.apps[data.app] = {
      app: data.app,
      stage: data.stage,
      completed: data.completed ?? [],
      status: data.status,
      message: data.message ?? '',
      branch: data.branch ?? null,
    };
    renderProgress();
  });

  source.addEventListener('job.done', (event) => {
    const data = JSON.parse(event.data);
    if (state.job) state.job.status = data.status;
    if (data.error) {
      pushLog({
        id: Date.now(),
        ts: new Date().toISOString(),
        level: 'error',
        message: data.error,
        app: null,
      });
    }
    if (data.status === 'done_with_errors' || data.status === 'failed') {
      state.logsOpen = true;
      renderLogsToggle();
    }
    setPhase('ready');
    renderProgress();
    renderSelectionBar();
  });

  source.onerror = () => {
    setBadge(els.phasePill, 'Reconnecting', 'warn', { busy: true, status: true });
  };
}

async function boot() {
  try {
    const res = await fetch('/api/state');
    if (res.ok) applySnapshot(await res.json());
  } catch {
    // SSE will hydrate
  }
  connectEvents();
}

boot();
