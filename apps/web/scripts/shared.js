// ─────────────────────────────────────────────────────────────────────────────
// shared.js — Plus-Minus NBA  ·  Client-side data layer
//
// Architecture
//  ┌──────────────────────────────────────────────────────────────────────┐
//  │  Browser                                                             │
//  │    PM_CLIENT_CACHE (localStorage)  ← serves stale instantly         │
//  │           ↕  miss or expired                                        │
//  │    PM_WORKER (Cloudflare Worker)   ← central cache, 24 h KV         │
//  │           ↕  worker miss (rare — cron pre-warms)                    │
//  │    ESPN / NBA CDN  ← worker fetches on behalf of all clients        │
//  └──────────────────────────────────────────────────────────────────────┘
//
// Client-cache TTLs mirror the KV TTLs so browsers don't hammer the worker:
//   leaders    24 h
//   standings   1 h
//   scoreboard  2 min  (worker KV = 60 s; client adds a cushion)
// ─────────────────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
window.esc = esc;

// Suppress noisy ResizeObserver errors (Chrome bug)
window.addEventListener('error', e => {
  if (e.message?.includes('ResizeObserver')) e.stopImmediatePropagation();
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const PM_IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.port === '8080' || window.location.port === '4035';
const PM_WORKER = 'https://nba-data-worker.lorenzbarangan112.workers.dev';
const PM_LOCAL_BACKEND = 'http://localhost:8000';
const PM_NBA_TIME_ZONE = 'America/New_York';

/** Is the page served from the filesystem? (live data disabled) */
const PM_IS_FILE = window.location.protocol === 'file:';

function pmDateKey(timeZone = PM_NBA_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function resolvePredictionApiBase() {
  if (window.PRED_BACKEND) return String(window.PRED_BACKEND).replace(/\/+$/, '');
  return PM_IS_LOCAL ? PM_LOCAL_BACKEND : PM_WORKER;
}

window.PM_CONFIG = {
  workerUrl: PM_WORKER,
  localBackendUrl: PM_LOCAL_BACKEND,
  nbaTimeZone: PM_NBA_TIME_ZONE,
  isLocal: PM_IS_LOCAL,
  isFile: PM_IS_FILE,
  todayKey: pmDateKey,
  predictionApiBase: resolvePredictionApiBase,
};
window.PM_WORKER = PM_WORKER;
window.PM_LOCAL_BACKEND = PM_LOCAL_BACKEND;
window.resolvePredictionApiBase = resolvePredictionApiBase;
window.pmDateKey = pmDateKey;

const TEAM_COLORS = {};
window.PM_TEAM_COLORS = TEAM_COLORS;



// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SIDE CACHE  (localStorage with TTL)
// ─────────────────────────────────────────────────────────────────────────────
const PM_CLIENT_CACHE = (() => {
  const PREFIX = 'pm_cache_v8_';

  /** TTLs in milliseconds */
  const TTL = {
    leaders: 24 * 3_600_000,    // 24 h
    standings: 3_600_000,    //  1 h
    scoreboard: 2 * 60_000,        //  2 min
    schedule: 30 * 60_000,       // 30 min
    meta: 24 * 3_600_000,        // 24 h
  };

  const _lastWriteHash = {};

  function set(key, data) {
    // Skip sync localStorage write if data hasn't changed (avoids 10-30ms main-thread jank)
    const dataStr = JSON.stringify(data);
    if (_lastWriteHash[key] === dataStr) return;
    _lastWriteHash[key] = dataStr;

    const entry = JSON.stringify({ data, ts: Date.now() });
    try {
      localStorage.setItem(PREFIX + key, entry);
    } catch {
      // Evict oldest pm_ entries until it fits
      const pmKeys = Object.keys(localStorage)
        .filter(k => k.startsWith(PREFIX))
        .map(k => {
          try { return { k, ts: JSON.parse(localStorage.getItem(k)).ts }; } catch { return { k, ts: 0 }; }
        })
        .sort((a, b) => a.ts - b.ts);
      for (const { k } of pmKeys) {
        localStorage.removeItem(k);
        try { localStorage.setItem(PREFIX + key, entry); return; } catch { /* keep evicting */ }
      }
    }
  }

  function get(key, ttlKey) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      const maxAge = TTL[ttlKey] ?? TTL.leaders;
      if (Date.now() - ts > maxAge) {
        localStorage.removeItem(PREFIX + key);
        return null;
      }
      return { data, ts };
    } catch {
      return null;
    }
  }

  function peek(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Return age in seconds, or null if not cached */
  function age(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const { ts } = JSON.parse(raw);
      return Math.floor((Date.now() - ts) / 1000);
    } catch {
      return null;
    }
  }

  return { set, get, age, peek };
})();

function pmReadClientCache(key, ttlKey, allowExpired = false) {
  const entry = allowExpired ? PM_CLIENT_CACHE.peek(key) : PM_CLIENT_CACHE.get(key, ttlKey);
  if (!entry) return null;
  return entry;
}

window.pmReadClientCache = pmReadClientCache;

// ─────────────────────────────────────────────────────────────────────────────
// DEBOUNCE / VISIBILITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/**
 * Like setInterval, but pauses while the tab is hidden.
 * Returns { clear() } so callers can cancel.
 */
function visibilityInterval(fn, ms) {
  let id = setInterval(fn, ms);
  const handler = () => {
    if (document.hidden) { clearInterval(id); id = null; }
    else if (!id) { id = setInterval(fn, ms); }
  };
  document.addEventListener('visibilitychange', handler);
  return {
    clear() {
      if (id) clearInterval(id);
      document.removeEventListener('visibilitychange', handler);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER FETCH WRAPPER
// Adds a client-side timeout and normalises errors.
// ─────────────────────────────────────────────────────────────────────────────
async function workerFetch(path, timeoutMs = 9000, retries = 2) {
  if (PM_IS_FILE) return null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const usesBackend = [
        '/api/predict',
        '/api/slate',
        '/api/schedule',
        '/api/team_top_players',
        '/api/playerlog',
        '/api/shot_zones',
        '/api/lineups',
        '/api/play_types',
        '/api/injuries',
        '/api/team_stats',
      ].some(prefix => path.startsWith(prefix));
      const primaryBase = usesBackend ? resolvePredictionApiBase() : PM_WORKER;
      const fallbackBase = usesBackend && primaryBase === PM_LOCAL_BACKEND ? PM_WORKER : null;

      const fetchFromBase = async (baseUrl) => {
        const res = await fetch(`${baseUrl}${path}`, {
          signal: controller.signal,
          cache: usesBackend ? 'no-store' : 'default',
        });
        if (res.status === 429) {
          const wait = Math.min(Number(res.headers.get('Retry-After') || 2) * 1000, 8000);
          await new Promise(r => setTimeout(r, wait));
          return null;
        }
        if (!res.ok) throw Object.assign(new Error(`Worker ${path} → ${res.status}`), { status: res.status });
        return res;
      };

      let res = null;
      let primaryError = null;
      try {
        res = await fetchFromBase(primaryBase);
      } catch (err) {
        primaryError = err;
      }

      if (!res && fallbackBase) {
        try {
          res = await fetchFromBase(fallbackBase);
        } catch (fallbackError) {
          throw primaryError || fallbackError;
        }
      } else if (primaryError) {
        throw primaryError;
      }

      clearTimeout(timer);
      if (!res) continue;
      return res.json();
    } catch (err) {
      clearTimeout(timer);
      const isLast = attempt === retries;
      if (isLast) throw err;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1))); // back-off
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Higher-level fetch helpers: backend-first, retry wrapper, and debug UI
// ─────────────────────────────────────────────────────────────────────────────

// Per-endpoint fetch policies (timeoutMs, retries)
const PM_ENDPOINT_POLICY = {
  '/api/predict': { timeoutMs: 30000, retries: 1 },
  '/api/playerlog': { timeoutMs: 15000, retries: 1 },
  '/api/lineups': { timeoutMs: 20000, retries: 1 },
  '/api/shot_zones': { timeoutMs: 12000, retries: 1 },
  '/api/play_types': { timeoutMs: 12000, retries: 1 },
};

/**
 * Try the prediction backend first (resolvePredictionApiBase()), then fall back to the worker.
 * Returns parsed JSON. Also emits a small on-screen badge for debugging.
 */
async function backendFirstFetch(path, timeoutMs = 9000, retries = 2) {
  if (PM_IS_FILE) return null;
  // Apply per-endpoint policy if configured
  for (const prefix in PM_ENDPOINT_POLICY) {
    if (path.startsWith(prefix)) {
      const p = PM_ENDPOINT_POLICY[prefix] || {};
      timeoutMs = p.timeoutMs ?? timeoutMs;
      retries = (typeof p.retries === 'number') ? p.retries : retries;
      break;
    }
  }
  const freshTs = Date.now();
  const usesBackend = path.startsWith('/api/');
  const primaryBase = resolvePredictionApiBase();
  const fallbackBase = (primaryBase === PM_LOCAL_BACKEND) ? PM_WORKER : null;

  // Try direct backend first when appropriate
  if (usesBackend && primaryBase) {
    try {
      const url = `${primaryBase}${path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`backend ${res.status}`);
      const json = await res.json();
      try { showDataSourceBadge('backend', json?.cachedAt ?? freshTs); } catch {}
      return json;
    } catch (err) {
      console.warn('[PM] backendFirstFetch primary failed:', err.message);
      // fall through to worker
    }
  }

  // Fallback to workerFetch (which already implements its own fallback/backoff)
  try {
    const json = await workerFetch(path, timeoutMs, retries);
    try { showDataSourceBadge('worker', json?.cachedAt ?? Date.now()); } catch {}
    return json;
  } catch (err) {
    try { showDataSourceBadge('error', Date.now()); } catch {}
    throw err;
  }
}

/** Generic retry wrapper with exponential backoff. `fn` should be a function that returns a Promise. */
async function retryFetch(fn, attempts = 3, baseDelayMs = 500) {
  let attempt = 0;
  while (attempt < attempts) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= attempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Simple on-screen badge to show last data source and approximate timestamp
function showDataSourceBadge(source, ts) {
  try {
    let el = document.getElementById('pm-data-source-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pm-data-source-badge';
      el.className = 'pm-debug-badge';
      document.body.appendChild(el);
    }
    const when = ts ? new Date(ts).toLocaleTimeString() : 'now';
    el.textContent = `${source.toUpperCase()} · ${when}`;
    el.dataset.source = source;
    // Fade out after a short while for non-error states
    if (source !== 'error') {
      el.style.opacity = '1';
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => { el.style.opacity = '0.14'; }, 3500);
    } else {
      // Error state remains visible longer
      el.style.opacity = '1';
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => { el.style.opacity = '0.6'; }, 12000);
    }
  } catch (e) { /* best-effort UI */ }
}

function showNonBlockingError(msg, ttl = 7000) {
  try {
    let el = document.getElementById('pm-notice-container');
    if (!el) { el = document.createElement('div'); el.id = 'pm-notice-container'; document.body.appendChild(el); }
    const note = document.createElement('div');
    note.className = 'pm-toast';
    note.textContent = msg;
    el.appendChild(note);
    setTimeout(() => { note.classList.add('dismiss'); setTimeout(() => note.remove(), 400); }, ttl);
  } catch (e) { console.warn('[PM] showNonBlockingError failed', e.message); }
}

// Expose helpers for other modules
window.backendFirstFetch = backendFirstFetch;
window.retryFetch = retryFetch;
window.showDataSourceBadge = showDataSourceBadge;
window.showNonBlockingError = showNonBlockingError;

// Lightweight telemetry helper — best-effort, uses navigator.sendBeacon when possible.
function pmEmitMetric(name, payload = {}) {
  try {
    const body = JSON.stringify({ name, ts: Date.now(), payload });
    const url = (typeof resolvePredictionApiBase === 'function' ? resolvePredictionApiBase() : PM_WORKER) + '/api/telemetry';
    if (navigator && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, body);
    } else {
      fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  } catch (e) { console.debug('[PM] pmEmitMetric failed', e.message); }
}
window.pmEmitMetric = pmEmitMetric;



// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Stale-while-revalidate fetch helper
// Deduplicates the identical cache → fetch → emit pattern used by leaders & standings.
// ─────────────────────────────────────────────────────────────────────────────

// How old cached data must be before a background refresh is triggered.
// These are intentionally SHORTER than the full TTL so we proactively refresh
// while still serving instantly from cache. They must be ≤ the corresponding TTL.
//   leaders:   4 h  — season stats change once daily at most; 24h TTL
//   standings: 20 min — W/L records update after every game;  1h TTL
//   scoreboard: N/A (handled separately with its own SWR logic)
//   schedule:  30 min — schedule rarely changes intra-day;   30m TTL (client/worker)
//   meta:      12 h  — team colors never change mid-season;  24h TTL
const _SWR_STALE_MS = {
  leaders:   4  * 3_600_000,  // 4 h
  standings: 20 * 60_000,     // 20 min
  schedule:  30 * 60_000,     // 30 min
  meta:      12 * 3_600_000,  // 12 h
};
async function _staleWhileRevalidate({ cacheKey, ttlKey, workerPath, processResponse, logLabel, timeoutMs, retries }) {
  if (PM_IS_FILE) return null;

  const cached = PM_CLIENT_CACHE.get(cacheKey, ttlKey);
  const staleMs = _SWR_STALE_MS[ttlKey] ?? 30 * 60_000; // default 30 min
  const isStale = cached && (Date.now() - cached.ts > staleMs);

  if (cached && !isStale) {
    console.info(`[PM] ${logLabel} ← localStorage (fresh)`);
    return cached.data;
  }

  // Stale or missing: fetch in background, return cached immediately if present
  const fetchPromise = (async () => {
    try {
      const json = await workerFetch(workerPath, timeoutMs ?? 9000, retries ?? 2);
      const data = processResponse(json);
      if (data) {
        PM_CLIENT_CACHE.set(cacheKey, data);
        return data;
      }
    } catch (err) {
      console.warn(`[PM] ${logLabel} refresh failed:`, err.message);
    }
    return null;
  })();

  if (cached) {
    console.info(`[PM] ${logLabel} ← stale localStorage (refreshing…)`);
    return cached.data;
  }

  return fetchPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. STAT LEADERS
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLeaders() {
  return _staleWhileRevalidate({
    cacheKey: 'leaders_v3',
    ttlKey: 'leaders',
    workerPath: '/api/leaders',
    logLabel: 'Leaders',
    processResponse(json) {
      if (json?.data) {
        window._pmLeadersCachedAt = json.cachedAt ?? Date.now();
        window.PMData?.emit('leaders:updated', json.data);
        return json.data;
      }
      return null;
    },
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// 2. STANDINGS
// ─────────────────────────────────────────────────────────────────────────────
async function fetchStandings() {
  return _staleWhileRevalidate({
    cacheKey: 'standings',
    ttlKey: 'standings',
    workerPath: '/api/standings',
    logLabel: 'Standings',
    processResponse(json) {
      const data = json.data;
      if (data && (data.west?.length || data.east?.length)) {
        ['west', 'east'].forEach(conf => {
          (data[conf] ?? []).forEach(t => {
              if (!window.__pmStandingsDebugLogged) {
                console.debug('[PM] Standings raw team sample:', {
                  abbr: t.abbr,
                  team: t.team,
                  name: t.name,
                  teamName: t.teamName,
                  city: t.city,
                  strk: t.strk,
                  Streak: t.Streak,
                });
                window.__pmStandingsDebugLogged = true;
              }
              t.name = t.team ?? t.name ?? t.teamName ?? t.fullName ?? t.abbr;
            if (t.pctStr) { t.pct = t.pctStr; }
            else if (typeof t.pct === 'number') {
              t.pct = '.' + String(Math.round(t.pct * 1000)).padStart(3, '0');
            }
            t.record = `${t.w}-${t.l}`;
              t.streak = t.strk ?? t.Streak ?? t.streak ?? 'N/A';
            t.color = t.color || TEAM_COLORS[t.abbr] || '#888888';
          });
        });
        window.PMData?.emit('standings:updated', data);
        return data;
      }
      return null;
    },
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// 3. LIVE SCOREBOARD
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLiveScores() {
  if (PM_IS_FILE) return [];

  const cached = PM_CLIENT_CACHE.get('scoreboard', 'scoreboard');
  const cachedGames = Array.isArray(cached?.data) ? cached.data : (cached?.data?.games ?? null);
  const cachedMeta = cached?.data?.games ? cached.data : null;

  // Stale-while-revalidate: serve cached data immediately but kick off a
  // background refresh if the data is older than 30 s. The 2-min client TTL
  // prevents the cache from being hit at all once fully expired — this 30 s
  // threshold covers the window WITHIN the TTL where data may be getting stale.
  const SCOREBOARD_STALE_MS = 30_000; // 30 s
  const isStale = cached && (Date.now() - cached.ts > SCOREBOARD_STALE_MS);

  const doFetch = async () => {
    try {
      const json = await workerFetch('/api/scoreboard', 7000);
      console.info(`[PM] Scoreboard ← worker · source:${json.source}`);
      const games = json.games ?? [];
      if (games.length) {
        const meta = {
          games,
          source: json.source ?? 'unknown',
          cachedAt: json.cachedAt ?? Date.now(),
          ageSeconds: json.ageSeconds ?? 0,
          date: json.date ?? pmDateKey(),
          receivedAt: Date.now(),
        };
        window._pmScoreboardMeta = meta;
        PM_CLIENT_CACHE.set('scoreboard', meta);
        if (window.PMData) {
          window.PMData.SCOREBOARD = games;
          window.PMData.emit('scoreboard:updated', games);
        }
      }
      return games;
    } catch (err) {
      console.warn('[PM] Scoreboard worker failed:', err.message);
      return null;
    }
  };

  // Fresh cache — return immediately, no fetch needed
  if (cachedGames && !isStale) {
    window._pmScoreboardMeta = cachedMeta ?? {
      games: cachedGames,
      source: 'local-cache',
      cachedAt: cached.ts,
      ageSeconds: Math.floor((Date.now() - cached.ts) / 1000),
      date: pmDateKey(),
      receivedAt: cached.ts,
    };
    return cachedGames;
  }

  // Stale cache — return cached data NOW, refresh silently in background
  if (cachedGames && isStale) {
    const fresh = await doFetch();
    return fresh ?? cachedGames;
  }

  // Cache miss — must wait for network
  return (await doFetch()) ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TODAY KPI SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTodayKPIs() {
  const games = await fetchLiveScores();
  if (!games.length) return null;

  const finished = games.filter(g => g.status === 3);
  const live = games.filter(g => g.status === 2);

  let avgScore = null;
  if (finished.length) {
    const total = finished.reduce((s, g) => s + (g.home.score ?? 0) + (g.away.score ?? 0), 0);
    avgScore = (total / (finished.length * 2)).toFixed(1);
  }

  return { total: games.length, live: live.length, finished: finished.length, avgScore };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. LIVE UI REFRESH  (scoreboard → DOM patches)
// ─────────────────────────────────────────────────────────────────────────────

// Fetch games from schedule (multi-day) and flatten to today + next 3 days
async function fetchUpcomingGames() {
  try {
    const schedule = await workerFetch('/api/schedule?days=4', 30000, 1);
    if (!schedule?.schedule) return [];

    const today = new Date();
    const games = [];

    // Flatten schedule for today + next 3 days
    for (let i = 0; i < 4; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const rawDayGames = schedule.schedule[dateKey] || [];

        // Add date separator for tomorrow onwards
        if (i > 0 && rawDayGames.length > 0) {
          games.push({ _isSeparator: true, _date: dateKey, _label: i === 1 ? 'TOMORROW' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) });
        }

        // Normalize each dayGame into the fuller game object shape expected by buildGameChips
        // Also deduplicate games by unique key (away-home-startTime) to avoid midnight-boundary duplicates
        const seenKeys = new Set();
        const dayGames = rawDayGames.map(g => {
        // If already full object (has away.tricode), return as-is
        if (g && g.away && typeof g.away === 'object' && g.away.tricode) return g;
        // Otherwise g is from fetchDaySchedule: { home: 'LAL', away: 'BOS', time, status, startTime, tv }
        const homeAbbr = (g.home && typeof g.home === 'string') ? g.home : (g.home?.tricode || '???');
        const awayAbbr = (g.away && typeof g.away === 'string') ? g.away : (g.away?.tricode || '???');
        const normalized = {
          home: { tricode: String(homeAbbr).toUpperCase(), name: '', score: 0, wins: 0, losses: 0 },
          away: { tricode: String(awayAbbr).toUpperCase(), name: '', score: 0, wins: 0, losses: 0 },
          // Prefer venue/arena only; do NOT fall back to broadcast network to avoid inconsistent labels
          arena: g.arena ?? '',
          startTime: g.startTime ?? g.time ?? '',
          status: typeof g.status === 'number' ? g.status : (g.time && String(g.time).toUpperCase().includes('FINAL') ? 3 : 1),
          period: 0,
          clock: '',
        };
        const key = `${normalized.away.tricode}-${normalized.home.tricode}-${normalized.startTime}`;
        if (seenKeys.has(key) || games.some(existing => existing && existing.away && existing.home && `${existing.away.tricode}-${existing.home.tricode}-${existing.startTime}` === key)) {
          return null; // duplicate
        }
        seenKeys.add(key);
        return normalized;
      });
      games.push(...dayGames.filter(Boolean));
    }
    return games;
  } catch (err) {
    console.warn('[PM] Upcoming games fetch failed, falling back to live scores:', err.message);
    return await fetchLiveScores();
  }
}

async function refreshLiveUI() {
  try {
    // Try multi-day schedule first, fall back to today-only if it fails
    let games = await fetchUpcomingGames();
    if (!games?.length) games = await fetchLiveScores();
    if (!games?.length) return;

  const realGames = games.filter(g => g && g.away && g.home);

  // ── First call: build DOM structure from live data + upcoming ──
  const timeline = document.querySelector('.games-timeline');
  const alreadyBuilt = timeline?.querySelector('[data-away]');
  if (timeline && !alreadyBuilt) buildGameChips(games);

  const live = realGames.filter(g => g.status === 2);
  const finished = realGames.filter(g => g.status === 3);

  // Live badge
  const badge = document.querySelector('.live-badge');
  if (badge) badge.textContent = `${realGames.length} GAME${realGames.length !== 1 ? 'S' : ''}`;

  // Helper: find a game by home/away tricode (order-insensitive)
  const findGame = (a, h) =>
    realGames.find(g =>
      (g.away.tricode === a && g.home.tricode === h) ||
      (g.away.tricode === h && g.home.tricode === a)
    );

  // ── Rebuild sidebar pills from live data ──
  const sidebarGames = document.getElementById('sidebarGames');
  const sidebarDateLabel = document.getElementById('sidebarDateLabel');
  if (sidebarGames && sidebarDateLabel) {
    // Show simple games count in sidebar instead of 'LIVE NOW — DATE'
    sidebarDateLabel.textContent = `${realGames.length} GAME${realGames.length !== 1 ? 'S' : ''}`;

    // Remove old pills (keep the label)
    sidebarGames.querySelectorAll('.team-pill').forEach(p => p.remove());

    realGames.slice(0, 6).forEach((g, i) => {
      const isLive = g.status === 2;
      const isFinal = g.status === 3;
      const scoreText = (isLive || isFinal)
        ? `${g.away.score}–${g.home.score}${isFinal ? ' F' : ` Q${g.period}`}`
        : (g.startTime ? _formatGameTime(g.startTime) : 'TBD');
      const rawColor = TEAM_COLORS[g.away.tricode] ?? '#888';
      const color = /^#[0-9a-fA-F]{3,8}$/.test(rawColor) ? rawColor : '#888';

      const pill = document.createElement('div');
      pill.className = `team-pill${i === 0 ? ' active' : ''}`;
      pill.dataset.away = g.away.tricode;
      pill.dataset.home = g.home.tricode;
      pill.innerHTML = `
        <div class="tp-dot" style="background:${color}"></div>
        <span>${esc(g.away.tricode)} vs ${esc(g.home.tricode)}</span>
        ${isLive ? '<div class="tp-live"></div>' : ''}
        <span class="tp-rec" style="color:${isLive ? 'var(--coral)' : 'var(--text2)'};font-weight:700">
          ${esc(scoreText)}
        </span>`;
      sidebarGames.appendChild(pill);
    });
  }

  // ── Game chips in timeline: Subsequent calls only patch existing chips ──
  document.querySelectorAll('.game-chip[data-away][data-home]').forEach(chip => {
    const game = findGame(chip.dataset.away, chip.dataset.home);
    if (!game) return;

    if (game.status === 2) {
      chip.classList.add('live-chip', 'featured-chip');
      chip.classList.remove('closed-chip');
      const statusEl = chip.querySelector('.gc-status');
      if (statusEl) {
        statusEl.className = 'gc-status live';
        statusEl.innerHTML = `<div class="gc-status-dot"></div>LIVE Q${esc(game.period)} ${esc(game.clock)}`;
      }
      // Score pulse animation on change
      const scores = chip.querySelectorAll('.gc-score-sm');
      if (scores[0]) {
        const oldScore = scores[0].textContent;
        const newScore = esc(game.away.score);
        scores[0].textContent = newScore;
        if (oldScore !== newScore && oldScore !== '') {
          scores[0].classList.remove('score-updated');
          void scores[0].offsetWidth; // force reflow
          scores[0].classList.add('score-updated');
        }
      }
      if (scores[1]) {
        const oldScore = scores[1].textContent;
        const newScore = esc(game.home.score);
        scores[1].textContent = newScore;
        if (oldScore !== newScore && oldScore !== '') {
          scores[1].classList.remove('score-updated');
          void scores[1].offsetWidth;
          scores[1].classList.add('score-updated');
        }
      }
    } else if (game.status === 3) {
      chip.classList.add('closed-chip');
      chip.classList.remove('live-chip', 'featured-chip');
      const statusEl = chip.querySelector('.gc-status');
      if (statusEl) { statusEl.className = 'gc-status final'; statusEl.textContent = 'FINAL'; }
      const scores = chip.querySelectorAll('.gc-score-sm');
      if (scores[0]) { scores[0].textContent = esc(game.away.score); scores[0].classList.toggle('win', game.away.score > game.home.score); }
      if (scores[1]) { scores[1].textContent = esc(game.home.score); scores[1].classList.toggle('win', game.home.score > game.away.score); }
    }
  });

  // ── KPI card patch ──
  document.querySelectorAll('.kpi-card').forEach(card => {
    const label = card.querySelector('.kpi-label');
    if (label?.textContent.includes('GAMES TODAY')) {
      const val = card.querySelector('.kpi-value');
      if (val) val.textContent = String(realGames.length);
    }
  });

  // ── Stop simulation if any real live game data arrives ──
  if (realGames.length > 0) {
    window._pmSimActive = false;
  }

  // ── Announce score updates to screen readers ──
  const _scoreAnnouncer = document.getElementById('scoreAnnouncer');
  if (_scoreAnnouncer) {
    const _liveGames = realGames.filter(g => g.status === 2);
    if (_liveGames.length) {
      _scoreAnnouncer.textContent = `${_liveGames.length} live game${_liveGames.length > 1 ? 's' : ''}: ` +
        _liveGames.map(g => `${g.away.tricode} ${g.away.score}, ${g.home.tricode} ${g.home.score}`).join('; ');
    } else {
      _scoreAnnouncer.textContent = `${realGames.length} game${realGames.length !== 1 ? 's' : ''} today`;
    }
  }

  // Timestamp
  window._pmLastRefresh = Date.now();
  _updateTimestamp();
  } catch (err) {
    console.warn('[PM] refreshLiveUI failed:', err.message);
  }
}

// ── BUILD GAME CHIPS FROM LIVE DATA ──────────────────────────────────────
function buildGameChips(games) {
  const timeline = document.querySelector('.games-timeline');
  if (!timeline || !games.length) return;

  timeline.innerHTML = games.map(g => {
    // Handle date separators
    if (g._isSeparator) {
      return `<div class="gc-separator"><span class="gc-sep-label">${esc(g._label)}</span></div>`;
    }

    const isLive = g.status === 2;
    const isFinal = g.status === 3;
    const isPre = g.status === 1;
    const awayWin = isFinal && g.away.score > g.home.score;
    const homeWin = isFinal && g.home.score > g.away.score;
    const rawAwayClr = TEAM_COLORS[g.away.tricode] ?? '#888';
    const rawHomeClr = TEAM_COLORS[g.home.tricode] ?? '#888';
    const awayClr = /^#[0-9a-fA-F]{3,8}$/.test(rawAwayClr) ? rawAwayClr : '#888';
    const homeClr = /^#[0-9a-fA-F]{3,8}$/.test(rawHomeClr) ? rawHomeClr : '#888';

    const probW = (isLive || isFinal) && (g.away.score + g.home.score) > 0
      ? Math.round((g.away.score / (g.away.score + g.home.score)) * 100)
      : 50;

    // Countdown for upcoming games
    let countdownHtml = '';
    if (isPre && g.startTime) {
      const diff = new Date(g.startTime) - new Date();
      if (diff > 0 && diff < 24 * 3600000) {
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        countdownHtml = `<div class="gc-countdown">STARTS IN ${h}h ${m}m</div>`;
      }
    }

    const statusHtml = isLive
      ? `<div class="gc-status live"><div class="gc-status-dot"></div>LIVE Q${esc(g.period)} ${esc(g.clock)}</div>`
      : isFinal
        ? `<div class="gc-status final">FINAL</div>`
        : `<div class="gc-status upcoming">${g.startTime ? _formatGameTime(g.startTime) : 'TBD'}${countdownHtml}</div>`;

    const scoresHtml = (isLive || isFinal)
      ? `<div class="gc-score-sm${awayWin ? ' win' : ''} ${isLive ? 'live-s' : ''}">${esc(g.away.score)}</div>
         <div class="gc-vs">–</div>
         <div class="gc-score-sm${homeWin ? ' win' : ''} ${isLive ? 'live-s' : ''}">${esc(g.home.score)}</div>`
      : `<div class="gc-vs">vs</div>`;

    const chipCls = [
      'game-chip',
      isLive ? 'featured-chip live-chip' : '',
      isFinal ? 'closed-chip' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${chipCls}" data-away="${esc(g.away.tricode)}" data-home="${esc(g.home.tricode)}">
        ${statusHtml}
        <div class="gc-matchup">
          <div class="gc-team">
            <div class="gc-team-dot" style="background:${awayClr}"></div>
            <div class="gc-abbr">${esc(g.away.tricode)}</div>
          </div>
          <div class="gc-scores">${scoresHtml}</div>
          <div class="gc-team">
            <div class="gc-abbr">${esc(g.home.tricode)}</div>
            <div class="gc-team-dot" style="background:${homeClr}"></div>
          </div>
        </div>
        <div class="gc-prob-sm">
          <div class="gc-prob-bar-sm">
            <div class="gc-prob-fill-sm" style="width:${probW}%"></div>
          </div>
        </div>
        <div class="gc-extra">
          <span class="gc-sub">${esc(g.arena)}</span>
        </div>
      </div>`;
  }).join('');
}
window.buildGameChips = buildGameChips;
window.fetchUpcomingGames = fetchUpcomingGames;

// ─────────────────────────────────────────────────────────────────────────────
// 5b. NBA NEWS FEED (worker → PMData → DOM)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchNBANews() {
  try {
    const json = await workerFetch('/api/news', 8000, 1);
    return json?.data ?? [];
  } catch (err) {
    console.warn('[PM] News fetch failed:', err.message);
    return [];
  }
}
window.fetchNBANews = fetchNBANews;

async function fetchAdvancedTeamContext(team = 'OKC') {
  const t = String(team || 'OKC').trim().toUpperCase();
  const freshnessToken = Date.now();
  const paths = {
    shotZones: `/api/shot_zones?team=${encodeURIComponent(t)}&fresh=${freshnessToken}`,
    lineups: `/api/lineups?team=${encodeURIComponent(t)}&top_n=5&fresh=${freshnessToken}`,
    playTypes: `/api/play_types?team=${encodeURIComponent(t)}&fresh=${freshnessToken}`,
    injuries: `/api/injuries?team=${encodeURIComponent(t)}&fresh=${freshnessToken}`,
  };

  const entries = await Promise.allSettled(
    Object.entries(paths).map(async ([key, path]) => [key, await workerFetch(path, 12000, 1)])
  );

  const data = { team: t, source: 'backend', timestamp: new Date().toISOString() };
  entries.forEach(result => {
    if (result.status === 'fulfilled') {
      const [key, value] = result.value;
      data[key] = value;
    }
  });
  data.ok = ['shotZones', 'lineups', 'playTypes', 'injuries'].some(key => !!data[key]);
  return data;
}

window.fetchAdvancedTeamContext = fetchAdvancedTeamContext;

// ─────────────────────────────────────────────────────────────────────────────
// 6. STANDINGS REFRESH  (worker → PMData → DOM)
// ─────────────────────────────────────────────────────────────────────────────
async function refreshStandings() {
  if (!window.PMData) return; // data.js not yet loaded
  try {
    const data = await fetchStandings();
    if (!data || (!data.west?.length && !data.east?.length)) return;

    if (window.PMData) {
      window.PMData.STANDINGS = data;
      window.PMData.emit('standings:updated', data);
    }

    if (typeof window.renderStandings === 'function') {
      window.renderStandings('west', 'standingsListWest');
      window.renderStandings('east', 'standingsListEast');

      // Update badge to LIVE
      document.querySelectorAll('.standings-panel .panel-badge').forEach(b => {
        b.textContent = 'LIVE';
        b.style.background = 'rgba(255,110,64,.15)';
        b.style.color = '#ff6e40';
      });
    }
  } catch (err) {
    console.error('[PM] refreshStandings failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. LEADERS REFRESH  (worker → PMData → DOM)
// ─────────────────────────────────────────────────────────────────────────────
async function refreshLeadersUI() {
  if (PM_IS_FILE) return;
  if (!window.PMData) return; // data.js not yet loaded — skip

  try {
    const live = await fetchLeaders();
    if (!live) return;

    let hasUpdate = false;
    for (const cat in live) {
      if (!live[cat]?.length) continue;
      window.PMData.LEADERS[cat] = live[cat];
      hasUpdate = true;

      // Generate deterministic sparkline paths from live data
      if (!window.PMData.LEADER_SPARKS) window.PMData.LEADER_SPARKS = {};
      window.PMData.LEADER_SPARKS[cat] = live[cat].map((p, i) => {
        const termY = 22 - Math.round(((p.pct ?? 0) / 100) * 18);
        const pts = [];
        for (let j = 0; j <= 6; j++) {
          const x = j * 10;
          const noise = j < 6 ? Math.sin(i * 1.3 + j * 0.9) * 4 : 0;
          const y = Math.max(2, Math.min(22, Math.round(termY + noise)));
          pts.push(`${x},${y}`);
        }
        return 'M' + pts.join(' ');
      });
    }

    if (!hasUpdate) return;

    if (typeof window.renderLeaders === 'function') {
      const activeCat = document.querySelector('.ltab.active')?.dataset?.cat ?? 'pts';
      window.renderLeaders(activeCat);
    }
    // Also re-render MVP race which depends on leaders data
    if (typeof window.renderMVPRace === 'function') {
      window.renderMVPRace();
    }

    if (window.PMData?.emit) {
      window.PMData.emit('leaders:updated');
    }

    // Update badge
    const badge = document.querySelector('.leaders-panel .panel-badge');
    if (badge) {
      badge.textContent = 'LIVE';
      badge.style.background = 'rgba(255,75,38,.15)';
      badge.style.color = 'var(--coral)';
    }

    // Rebuild search index if available
    if (typeof window.rebuildSearchIndex === 'function') window.rebuildSearchIndex();
  } catch (err) {
    console.warn('[PM] refreshLeadersUI failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING LEADERS  (subset of leaders, for Widget 2 flip cards)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchScoringLeaders() {
  if (PM_IS_FILE) return [];
  try {
    const all = await fetchLeaders();
    return (all?.pts ?? []).map(l => ({
      name: l.name,
      team: l.team,
      img: l.img,
      stat: l.val.toFixed(1),
      label: 'PPG',
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMESTAMP DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
function _updateTimestamp() {
  const el = document.getElementById('dataTimestamp');
  if (!el) return;

  const now = Date.now();

  // Just refreshed (< 10 s ago)
  if (window._pmLastRefresh && (now - window._pmLastRefresh) < 10_000) {
    const source = window._pmScoreboardMeta?.source;
    el.textContent = source ? `Live scores updated just now (${source})` : 'Updated just now';
    return;
  }

  if (window._pmScoreboardMeta?.cachedAt) {
    const ms = now - window._pmScoreboardMeta.cachedAt;
    const mins = Math.max(0, Math.floor(ms / 60_000));
    const source = window._pmScoreboardMeta.source ?? 'scoreboard';
    el.textContent = mins < 1
      ? `Live scores updated just now (${source})`
      : `Live scores updated ${mins}m ago (${source})`;
    return;
  }

  // Leaders cache age
  if (window._pmLeadersCachedAt) {
    const ms = now - window._pmLeadersCachedAt;
    const hrs = Math.floor(ms / 3_600_000);
    const mins = Math.floor(ms / 60_000);
    el.textContent = hrs >= 1 ? `Stats updated ${hrs}h ago` : `Stats updated ${mins}m ago`;
    return;
  }

  // Generic fallback
  const secsAgo = Math.round((now - (window._pmLastRefresh || now)) / 1000);
  const minsAgo = Math.floor(secsAgo / 60);
  el.textContent = minsAgo < 1 ? 'Updated just now'
    : minsAgo === 1 ? 'Updated 1 min ago'
      : `Updated ${minsAgo} min ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LUCIDE ICONS
// ─────────────────────────────────────────────────────────────────────────────
const initLucide = () => { if (window.lucide) window.lucide.createIcons(); };
document.addEventListener('DOMContentLoaded', initLucide);

// ─────────────────────────────────────────────────────────────────────────────
// DOT CHART FACTORY
// ─────────────────────────────────────────────────────────────────────────────
function createDotChart({ canvasId, wrapId, tooltipId, lineId, mainValId, data, rows = 11 }) {
  const CELL = 9, DOT = 4, MAX = Math.max(...data.map(d => d.value ?? d));
  let active = data.length - 1, cols = 0, rafPending = false;

  function height(c, total) {
    if (total <= 1) return Math.round(((data[0].value ?? data[0]) / MAX) * rows);
    const raw = (c / (total - 1)) * (data.length - 1);
    const lo = Math.floor(raw), hi = Math.min(data.length - 1, Math.ceil(raw));
    const v = a => data[a].value ?? data[a];
    return Math.round((v(lo) / MAX) * rows * (1 - (raw - lo)) + (v(hi) / MAX) * rows * (raw - lo));
  }

  function draw() {
    const canvas = document.getElementById(canvasId);
    const wrap = document.getElementById(wrapId);
    if (!canvas || !wrap) return;
    const w = wrap.offsetWidth, dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = (rows * CELL + 20) * dpr;
    canvas.style.width = w + 'px';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    cols = Math.max(1, Math.floor(w / CELL));
    if (active >= cols) active = cols - 1;

    for (let c = 0; c < cols; c++) {
      const h = height(c, cols), inf = Math.max(0, 1 - Math.abs(active - c) / 5);
      const isAct = c === active;
      for (let r = 0; r < rows; r++) {
        const dr = rows - 1 - r, filled = dr < h;
        const isTop = isAct && filled && dr === Math.max(h - 1, 0);
        let fill = filled ? 'rgba(255,255,255,.32)' : 'rgba(255,255,255,.1)', op = 1;
        if (isTop) { fill = '#fff'; }
        else if (filled && inf) { fill = 'rgba(197,248,42,.85)'; op = 0.2 + inf * 0.8; }
        else if (isAct) { fill = filled ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.08)'; op = filled ? 1 : 0.4; }
        const cx = (c * CELL + DOT / 2) * dpr, cy = (r * CELL + DOT / 2) * dpr;
        const rad = (DOT / 2) * (isTop ? 1.45 : 1) * dpr;
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.globalAlpha = op; ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const xPx = active * CELL + CELL / 2;
    const tip = document.getElementById(tooltipId), line = document.getElementById(lineId);
    if (tip) tip.style.left = xPx + 'px';
    if (line) line.style.left = xPx + 'px';
    const di = cols <= 1 ? 0 : Math.round((active / (cols - 1)) * (data.length - 1));
    const pt = data[Math.min(di, data.length - 1)];
    const val = pt.value ?? pt;
    const mv = document.getElementById(mainValId);
    if (mv) mv.textContent = val.toFixed(1);
  }

  let handleMove, handleLeave;
  const el = document.getElementById(canvasId);
  if (el) {
    if (el.dataset.dotChartBound) return { draw, destroy: () => {} };
    el.dataset.dotChartBound = '1';

    handleMove = e => {
      const rect = el.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const newActive = Math.max(0, Math.min(cols - 1, Math.floor((clientX - rect.left) / CELL)));
      if (newActive === active) return;
      active = newActive;
      if (!rafPending) { rafPending = true; requestAnimationFrame(() => { draw(); rafPending = false; }); }
    };
    handleLeave = () => { active = cols - 1; draw(); };
    el.addEventListener('mousemove', handleMove);
    el.addEventListener('touchstart', handleMove, { passive: true });
    el.addEventListener('mouseleave', handleLeave);
    el.addEventListener('touchend', handleLeave);
  }

  draw();
  const resizeHandler = debounce(draw, 100);
  window.addEventListener('resize', resizeHandler);
  return { draw, destroy() { window.removeEventListener('resize', resizeHandler); if (el) { el.removeEventListener('mousemove', handleMove); el.removeEventListener('touchstart', handleMove); el.removeEventListener('mouseleave', handleLeave); el.removeEventListener('touchend', handleLeave); } } };
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS BADGE SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  pending: { icon: 'var(--text2)', glow: 'rgba(176,176,196,0.3)' },
  success: { icon: 'var(--lime)', glow: 'rgba(197,248,42,0.3)' },
  failed: { icon: 'var(--coral)', glow: 'rgba(255,75,38,0.3)' },
};

function statusIcon(size, status) {
  const c = STATUS_COLORS[status].icon;
  if (status === 'pending') return `<svg class="sb-spinner" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
  if (status === 'success') return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="0"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
}

function renderStatusBadges(containerId, tasks, resolvedAt, rowClass, iconSize) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.querySelectorAll('.' + rowClass).forEach(r => r.remove());
  const sorted = [...tasks].sort((a, b) => {
    const ar = a.status !== 'pending', br = b.status !== 'pending';
    if (ar && !br) return -1; if (!ar && br) return 1;
    if (ar && br) return (resolvedAt[b.id] || 0) - (resolvedAt[a.id] || 0);
    return 0;
  });
  sorted.forEach(task => {
    const { status } = task, c = STATUS_COLORS[status];
    const row = document.createElement('div');
    row.className = rowClass;
    row.innerHTML = `<div class="${rowClass}-task"></div><div><span class="status-badge ${esc(status)}" style="--glow:${c.glow}"><span class="sb-icon">${statusIcon(iconSize, status)}</span><span class="sb-label">${esc(status.charAt(0).toUpperCase() + status.slice(1))}</span></span></div><div class="${rowClass}-more"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg></div>`;
    row.querySelector('.' + rowClass + '-task').textContent = task.label;
    el.appendChild(row);
  });
}

function createStatusCycler(tasks, resolvedAt, containerId, rowClass, iconSize, intervalMs, renderFn) {
  const cycle = ['pending', 'success', 'failed'];
  let cursor = 0;
  return visibilityInterval(() => {
    const task = tasks[cursor % tasks.length]; cursor++;
    const next = cycle[(cycle.indexOf(task.status) + 1) % cycle.length];
    task.status = next;
    if (next !== 'pending') resolvedAt[task.id] = Date.now();
    else delete resolvedAt[task.id];
    renderFn();
  }, intervalMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function initialsAvatar(name, size = 48) {
  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="0" fill="hsl(0,0%,20%)" stroke="rgba(255,255,255,0.1)"/><text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.38}" fill="#fff" font-weight="600">${initials}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function trapFocus(el) {
  const focusable = el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
  const first = focusable[0], last = focusable[focusable.length - 1];
  el.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
    else { if (document.activeElement === last) { e.preventDefault(); first.focus(); } }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. ON THIS DAY PANEL  (AI allowed, but must pass strict date validation)
// ─────────────────────────────────────────────────────────────────────────────
const OTD_STRICT_CURATED = false;

async function fetchAIOTD() {
  if (OTD_STRICT_CURATED) return null;
  if (PM_IS_FILE) return null;

  const now = new Date();
  const mmdd = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const cacheKey = `otd_v10_${mmdd}`;

  const cached = PM_CLIENT_CACHE.get(cacheKey, 'meta');
  if (cached?.data?.length >= 1) {
    console.info('[PM] OTD ← localStorage');
    return cached.data;
  }


  try {
    // Use the worker — it has the API key, KV cache, and no CORS issues
    const json = await workerFetch(`/api/otd?date=${mmdd}`, 12000, 1);
    const events = json?.data;
    if (!Array.isArray(events)) throw new Error('Bad OTD structure');
    // Only cache non-empty results — an empty array means the worker had no data
    // for today (e.g. no Groq key, or date not in static fallback). Caching []
    // would poison the localStorage slot and cause tier-3 failures on the next call.
    if (events.length > 0) PM_CLIENT_CACHE.set(cacheKey, events);
    console.info(`[PM] OTD ← worker (source:${json.source ?? 'unknown'}, items:${events.length}) ✓`);

    return events.length > 0 ? events : null;
  } catch (err) {
    console.warn('[PM] OTD worker fetch failed:', err.message);
    return null;
  }
}

function _mmddToDayOfYear(mmdd) {
  const [m, d] = String(mmdd).split('-').map(Number);
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let day = d;
  for (let i = 0; i < m - 1; i++) day += monthDays[i];
  return day;
}

function _withOTDMinThree(events, mmdd) {
  const base = Array.isArray(events) ? [...events] : [];
  if (base.length >= 3) return base.slice(0, 3);

  const history = window.PM_NBA_HISTORY;
  if (!history || typeof history !== 'object') return base;

  // Only supplement from the SAME date bucket to keep facts date-correct.
  const sameDate = Array.isArray(history[mmdd]) ? history[mmdd] : [];
  const seen = new Set(base.map(e => `${e?.year}|${e?.headline}`));
  for (const e of sameDate) {
    const id = `${e?.year}|${e?.headline}`;
    if (seen.has(id)) continue;
    base.push(e);
    seen.add(id);
    if (base.length >= 3) return base.slice(0, 3);
  }

  // Return whatever we have (could be 0-2) — don't pad with wrong-date placeholders
  return base;
}

async function refreshOTD() {
  const otdBody = document.getElementById('otdBody');
  if (!otdBody) return;

  // Show skeleton while AI generates
  otdBody.innerHTML = Array(3).fill(`
    <div class="otd-item">
      <div class="otd-stripe" style="background:var(--bg4)"></div>
      <div class="otd-year"><div class="skeleton-line" style="width:40px"></div></div>
      <div class="otd-content">
        <div class="skeleton-line" style="width:60%;margin-bottom:8px"></div>
        <div class="skeleton-line" style="width:90%;margin-bottom:6px"></div>
        <div class="skeleton-line" style="width:70%"></div>
      </div>
    </div>`).join('');

  // Try AI first, fall back to static
  const aiEvents = await fetchAIOTD();
  let events = (Array.isArray(aiEvents) && aiEvents.length > 0) ? aiEvents : null;
  
  if (events) {
    console.info('[PM] OTD tier 1: AI/Worker SUCCESS');
  } else {
    events = [];
  }

  if (!events.length) {
    console.warn('[PM] OTD tier 3: No data found for today');
    otdBody.innerHTML = '<div style="padding:24px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--muted)">NO DATA FOR TODAY</div>';
    return;
  }

  const now = new Date();
  const mmdd = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  // Reverted: Restoring the padding logic to ensure 3 cards
  events = _withOTDMinThree(events, mmdd);



  if (!events.length) {
    console.warn('[PM] OTD tier 3: No verified data found for today');
    otdBody.innerHTML = '<div style="padding:24px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--muted)">NO VERIFIED EVENTS FOR TODAY</div>';
    return;
  }

  // Update PMData so search index can use the AI results too.
  // Guard: aiEvents must be a non-empty array. An empty [] is falsy for length
  // but truthy as an object — if we wrote [] here we'd wipe the static OTD that
  // just successfully rendered above.
  if (Array.isArray(aiEvents) && aiEvents.length > 0 && window.PMData) {
    window.PMData.OTD = aiEvents;
  }

  // Update date badges
  document.querySelectorAll('.otd-panel .panel-badge').forEach(b => {
    b.textContent = window.PMData?.otdLabel ?? '';
  });

  // Validate color values from AI to prevent CSS injection
  const SAFE_COLORS = new Set(['var(--lime)', 'var(--coral)', 'var(--amber)', 'var(--blue)']);
  const SAFE_ICONS = new Set(['zap', 'trending-up', 'star', 'crown', 'flame', 'trophy']);
  const SAFE_CLS = new Set(['up', 'down']);

  otdBody.innerHTML = events.map(m => {
    const color = SAFE_COLORS.has(m.color) ? m.color : 'var(--lime)';
    const tagIcon = SAFE_ICONS.has(m.tagIcon) ? m.tagIcon : 'star';
    const chipCls = SAFE_CLS.has(m.statChip?.cls) ? m.statChip.cls : 'up';
    return `
    <div class="otd-item">
      <div class="otd-stripe" style="background:${color}"></div>
      <div class="otd-year">${m.year ? esc(String(m.year)) : ''}</div>
      <div class="otd-content">
        <div class="otd-tag" style="color:${color}">
          <svg class="lucide-icon" width="10" height="10"><use href="#icon-${tagIcon}"/></svg>
          ${esc(m.tag)}
        </div>
        <div class="otd-headline">${esc(m.headline)}</div>
        <div class="otd-detail">${esc(m.detail)}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px">
          <div class="otd-stat-chip ${chipCls}">${esc(m.statChip?.text ?? '')}</div>
          ${(m.players ?? []).map(p => `<div class="otd-player-chip">${esc(p)}</div>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');

  const otdBadge = document.getElementById('otdDateBadge');
  if (otdBadge && window.PMData) {
    otdBadge.textContent = window.PMData.otdLabel;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. SCHEDULE CACHE  (today's games → calendar schedule map)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchScheduleCache() {
  const games = await fetchLiveScores();
  if (!games.length) return null;

  const todayKey = pmDateKey();

  const todayGames = games.map(g => ({
    home: g.home.tricode,
    away: g.away.tricode,
    time: g.status === 3 ? 'FINAL'
      : g.status === 2 ? `Q${g.period} ${g.clock}`
        : (g.startTime ? _formatGameTime(g.startTime) : 'TBD'),
    status: g.status,
  }));

  const existing = PM_CLIENT_CACHE.get('schedule', 'schedule');
  const schedule = (existing?.data) ?? {};
  schedule[todayKey] = todayGames;
  PM_CLIENT_CACHE.set('schedule', schedule);
  return schedule;
}

function _formatGameTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    }) + ' ET';
  } catch {
    return 'TBD';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. CALENDAR SCHEDULE HYDRATION  (live data → window._pmSchedule)
// ─────────────────────────────────────────────────────────────────────────────
async function hydrateCalendarSchedule() {
  if (PM_IS_FILE) return;

  // 1. Check localStorage (keyed by today so it auto-expires)
  const todayStr = pmDateKey();
  const cached = PM_CLIENT_CACHE.get(`schedule_${todayStr}`, 'schedule');
  if (cached?.data) {
    window._pmSchedule = cached.data;
    if (window.PMData) window.PMData.emit('schedule:updated', cached.data);
    return;
  }

  // 2. Fetch from worker /api/schedule (returns 7-day map)
  try {
    const nbaDate = pmDateKey();
    const json = await workerFetch(`/api/schedule?days=21&date=${nbaDate}`, 12000);
    const schedule = json.schedule ?? {};
    if (!Object.keys(schedule).length) return;

    // Merge today's live scoreboard into schedule for real-time accuracy
    const liveGames = await fetchLiveScores();
    if (liveGames.length) {
      schedule[todayStr] = liveGames.map(g => ({
        home: g.home.tricode,
        away: g.away.tricode,
        time: g.status === 3 ? 'FINAL'
          : g.status === 2 ? `Q${g.period} ${g.clock}`
            : (g.startTime ? _formatGameTime(g.startTime) : 'TBD'),
        status: g.status,
      }));
    }

    PM_CLIENT_CACHE.set(`schedule_${todayStr}`, schedule);
    window._pmSchedule = schedule;
    if (window.PMData) window.PMData.emit('schedule:updated', schedule);
  } catch (err) {
    console.warn('[PM] hydrateCalendarSchedule failed:', err.message);
  }
}

async function syncMeta() {
  if (PM_IS_FILE) return;
  const cached = PM_CLIENT_CACHE.get('meta', 'meta');
  if (cached?.data?.TEAM_COLORS) {
    Object.assign(TEAM_COLORS, cached.data.TEAM_COLORS);
    window.PM_TEAM_COLORS = TEAM_COLORS;
    return;
  }
  try {
    const meta = await workerFetch('/api/meta', 5000);
    if (meta?.TEAM_COLORS) {
      Object.assign(TEAM_COLORS, meta.TEAM_COLORS);
      window.PM_TEAM_COLORS = TEAM_COLORS;
      PM_CLIENT_CACHE.set('meta', meta);
      console.log('[PM] Meta synced from worker');
    }
  } catch (e) {
    console.warn('[PM] Meta sync failed, using local defaults');
  }
}

/** 
 * BOOTSTRAP — Orchestrates the initial load sequence
 */
async function _pmBootstrap() {
  if (typeof window.initDashboard === 'function') window.initDashboard();

  // ── 0. Initial config sync (single-source-of-truth) ───────────────────────
  await syncMeta();

  // ── Startup diagnostics ──────────────────────────────────────────────────
  if (PM_IS_FILE) {
    console.warn(
      '%c[Plus-Minus] ⚠ file:// detected — live data disabled.\n' +
      'Serve via a local web server:\n' +
      '  python3 -m http.server 8080   → http://localhost:8080/home.html\n' +
      '  npx serve .                   → http://localhost:3000/home.html',
      'color:#ffb300;font-size:13px;font-weight:bold'
    );
    _pmInjectFileWarning();
    return;
  }

  const IS_DASHBOARD = !!document.querySelector('.dash-grid');

  // ── OTD — ensure data.js (PMData) is ready before rendering ────────────────
  if (window.PMData) {
    refreshOTD();
  } else {
    const _waitPMData = () => {
      if (window.PMData) refreshOTD();
      else setTimeout(_waitPMData, 50);
    };
    _waitPMData();
  }

  // ── Scoreboard: refresh immediately + every 90 s ─────────────────────────
  if (window._pmIntervals) {
    Object.values(window._pmIntervals).forEach(h => h?.clear?.());
  }

  refreshLiveUI();
  const liveInterval = visibilityInterval(refreshLiveUI, 90_000);

  // Timestamp updates independently
  const tsInterval = visibilityInterval(_updateTimestamp, 60_000);

  window._pmIntervals = { live: liveInterval, ts: tsInterval };

  if (!IS_DASHBOARD) return;

  // ── Standings: once on load (client TTL 1 h prevents re-fetching) ────────
  refreshStandings();

  // ── Leaders: once on load (client TTL 24 h prevents re-fetching) ─────────
  refreshLeadersUI();

  // ── Schedule: hydrate calendar from live scoreboard ───────────────────────
  hydrateCalendarSchedule();
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE:// WARNING BANNER
// ─────────────────────────────────────────────────────────────────────────────
function _pmInjectFileWarning() {
  if (!PM_IS_FILE) return;
  const banner = document.createElement('div');
  banner.id = 'pmFileWarning';
  banner.style.cssText = [
    'position:fixed', 'bottom:72px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:9999', 'background:#1a1400', 'border:1px solid #ffb300',
    'color:#ffb300', 'font-family:monospace', 'font-size:11px',
    'padding:10px 16px', 'border-radius:0', 'max-width:480px', 'width:90vw',
    'line-height:1.6', 'box-shadow:0 0 24px rgba(255,179,0,.2)', 'cursor:pointer'
  ].join(';');
  banner.innerHTML =
    '<strong>⚠ LIVE DATA DISABLED</strong> — served from <code>file://</code><br>' +
    'Start a local server to enable live stats:<br>' +
    '<code style="color:#fff">python3 -m http.server 8080</code><br>' +
    'Then open <code style="color:#fff">http://localhost:8080/home.html</code><br>' +
    '<span style="color:#666;font-size:9px">click to dismiss</span>';
  banner.addEventListener('click', () => banner.remove());
  document.body.appendChild(banner);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wait for DOM (works with sync or deferred <script> tags)
// ─────────────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _pmBootstrap);
} else {
  // Slight delay so data.js and initDashboard (dashboard.js) run first
  setTimeout(_pmBootstrap, 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS — functions needed by other modules / pages
// ─────────────────────────────────────────────────────────────────────────────
window.fetchLeaders = fetchLeaders;
window.fetchStandings = fetchStandings;
window.fetchLiveScores = fetchLiveScores;
window.fetchScoringLeaders = fetchScoringLeaders;
window.fetchTodayKPIs = fetchTodayKPIs;
window.refreshLiveUI = refreshLiveUI;
window.refreshStandings = refreshStandings;
window.refreshLeadersUI = refreshLeadersUI;
window.refreshOTD = refreshOTD;
window.hydrateCalendarSchedule = hydrateCalendarSchedule;
window.visibilityInterval = visibilityInterval;
window.debounce = debounce;
window.initialsAvatar = initialsAvatar;
window.trapFocus = trapFocus;
window.createDotChart = createDotChart;
window.renderStatusBadges = renderStatusBadges;
window.createStatusCycler = createStatusCycler;
window.TEAM_COLORS = TEAM_COLORS;
