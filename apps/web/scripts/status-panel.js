(function () {
  return; // Disabled: users shouldn't see infrastructure status
  const POLL_MS = 60_000;
  let drawer;
  let chip;
  let lastStatus = 'checking';

  function apiBase(path) {
    const cfg = window.PM_CONFIG || {};
    const worker = cfg.workerUrl || window.PM_WORKER || '';
    if (!worker) return path;
    return `${worker.replace(/\/+$/, '')}${path}`;
  }

  function backendHealthUrl() {
    const cfg = window.PM_CONFIG || {};
    const base = window.resolvePredictionApiBase
      ? window.resolvePredictionApiBase()
      : (cfg.localBackendUrl || 'http://localhost:8000');

    if (cfg.isLocal || base.includes('localhost') || base.includes('127.0.0.1')) {
      return `${base.replace(/\/+$/, '')}/api/health`;
    }
    return apiBase('/api/backend-health');
  }

  async function fetchJson(url, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      const text = await res.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      return { ok: res.ok, status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  function cacheTone(cache) {
    if (!cache) return 'cold';
    if (cache.status === 'warm') return 'good';
    if (cache.status === 'stale') return 'warn';
    return 'cold';
  }

  function ageLabel(seconds) {
    if (seconds == null) return 'not cached';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }

  function setChip(status, label) {
    lastStatus = status;
    if (!chip) return;
    chip.className = `pm-health-chip ${status}`;
    chip.innerHTML = `<span class="pm-health-dot"></span><span>${label}</span>`;
  }

  function row(label, value, tone = 'neutral', detail = '') {
    return `
      <div class="pm-status-row ${tone}">
        <div>
          <div class="pm-status-label">${label}</div>
          ${detail ? `<div class="pm-status-detail">${detail}</div>` : ''}
        </div>
        <div class="pm-status-value">${value}</div>
      </div>`;
  }

  function renderLoading() {
    if (!drawer) return;
    drawer.querySelector('.pm-status-body').innerHTML = [
      row('Worker', 'checking', 'neutral'),
      row('Backend', 'checking', 'neutral'),
      row('Scoreboard', 'checking', 'neutral'),
      row('Schedule', 'checking', 'neutral'),
    ].join('');
  }

  async function refreshStatus() {
    if (!drawer || document.hidden) return;
    renderLoading();
    setChip('checking', 'CHECKING');

    const workerResult = await fetchJson(apiBase('/api/status')).catch(err => ({
      ok: false,
      status: 0,
      json: { error: err.message },
    }));

    const backendResult = await fetchJson(backendHealthUrl()).catch(err => ({
      ok: false,
      status: 0,
      json: { error: err.message },
    }));

    const caches = workerResult.json?.caches || [];
    const scoreboard = caches.find(c => c.label === 'Scoreboard');
    const schedule = caches.find(c => c.label === 'Schedule');
    const meta = window._pmScoreboardMeta;

    const workerTone = workerResult.ok ? 'good' : 'bad';
    const backendTone = backendResult.ok && backendResult.json?.model_ready !== false ? 'good' : 'warn';
    const scoreTone = meta?.source === 'stale' ? 'warn' : cacheTone(scoreboard);
    const scheduleTone = cacheTone(schedule);

    const body = [
      row('Worker', workerResult.ok ? 'online' : 'offline', workerTone, workerResult.json?.today ? `NBA date ${workerResult.json.today}` : 'Cloudflare data edge'),
      row('Backend', backendResult.ok ? (backendResult.json?.model_ready ? 'model ready' : 'online') : 'unreachable', backendTone, backendResult.json?.startup_error || 'FastAPI prediction service'),
      row('Scoreboard', meta?.source || scoreboard?.status || 'unknown', scoreTone, meta?.cachedAt ? `updated ${ageLabel(Math.floor((Date.now() - meta.cachedAt) / 1000))} ago` : `cache age ${ageLabel(scoreboard?.ageSeconds)}`),
      row('Schedule', schedule?.status || 'unknown', scheduleTone, `cache age ${ageLabel(schedule?.ageSeconds)}`),
    ];

    drawer.querySelector('.pm-status-body').innerHTML = body.join('');

    const healthy = workerResult.ok && backendResult.ok && scoreTone !== 'bad';
    const warned = !healthy || backendTone === 'warn' || scoreTone === 'warn' || scheduleTone === 'warn';
    setChip(healthy && !warned ? 'good' : warned ? 'warn' : 'bad', healthy && !warned ? 'SYSTEM OK' : 'CHECK STATUS');
  }

  function ensurePanel() {
    if (chip && drawer) return;

    const target = document.querySelector('.topbar-right') || document.querySelector('.main-nav') || document.body;
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pm-health-chip checking';
    chip.setAttribute('aria-expanded', 'false');
    chip.innerHTML = '<span class="pm-health-dot"></span><span>CHECKING</span>';
    target.prepend(chip);

    drawer = document.createElement('aside');
    drawer.className = 'pm-status-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML = `
      <div class="pm-status-head">
        <div>
          <div class="pm-status-kicker">OPS</div>
          <div class="pm-status-title">System Status</div>
        </div>
        <button type="button" class="pm-status-close" aria-label="Close status panel">×</button>
      </div>
      <div class="pm-status-body"></div>
      <div class="pm-status-foot">NBA date uses America/New_York. Stale means fallback, not live.</div>`;
    document.body.appendChild(drawer);

    const toggle = () => {
      const open = drawer.classList.toggle('open');
      drawer.setAttribute('aria-hidden', String(!open));
      chip.setAttribute('aria-expanded', String(open));
      if (open) refreshStatus();
    };
    chip.addEventListener('click', toggle);
    drawer.querySelector('.pm-status-close').addEventListener('click', toggle);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && drawer.classList.contains('open')) toggle();
    });
  }

  function boot() {
    ensurePanel();
    refreshStatus();
    setInterval(() => {
      if (lastStatus !== 'checking') refreshStatus();
    }, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

