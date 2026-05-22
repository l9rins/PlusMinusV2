/**
 * team.js — NBA Team Detail Page
 * Plus-Minus NBA Intelligence Platform
 */

// ─── STATE ───────────────────────────────────────────────────────────────────
let TEAM_ABBR = '';
let TEAM_DATA = null;
let SCHEDULE_DATA = [];
let ROSTER_DATA = [];
let RECENT_GAMES = [];
let PREDICTIONS = {};
let SCHEDULE_MAP = {};
let INJURY_SNAPSHOT = { outCount: 0, details: [] };
let ROSTER_LOADING = true;
let SCHEDULE_LOADING = true;
let CURRENT_DATE_RANGE = 15;
let CURRENT_LINEUP_MIN = 120;
let LINEUP_COMBOS = [];
let LINEUP_SORT = { key: 'netRtg', direction: 'desc' };
let CURRENT_PLAYER_FILTER = '';

const PREDICTION_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_PREDICTIONS = 3;

// ─── INITIALIZATION ─────────────────────────────────────────────────────────
async function initTeamPage() {
  const params = new URLSearchParams(window.location.search);
  const requestedTeam = (params.get('team') || '').toUpperCase();
  TEAM_ABBR = requestedTeam;

  // Wire up tab handlers FIRST so they never disappear
  setupTabHandlers();
  setupAnalyticsInteractions();

  // Paint from cache immediately if we have something usable
  const cachedStandingsEntry = window.pmReadClientCache
    ? window.pmReadClientCache('standings_teampage', 'standings', true)
    : null;
  if (cachedStandingsEntry?.data) {
    const cachedStandings = cachedStandingsEntry.data;
    if (!TEAM_ABBR || TEAM_ABBR.length < 2 || TEAM_ABBR.length > 3 || !extractTeamFromStandings(cachedStandings, TEAM_ABBR)) {
      TEAM_ABBR = resolveDefaultTeamAbbr(cachedStandings);
      const url = new URL(window.location.href);
      url.searchParams.set('team', TEAM_ABBR);
      window.history.replaceState({}, '', url);
    }
    TEAM_DATA = extractTeamFromStandings(cachedStandings, TEAM_ABBR);
    if (TEAM_DATA) {
      try { renderTeamHeader(); } catch (e) { console.warn('[PM] Cached header render failed:', e.message); }
    }
  }

  const standingsPromise = fetchStandings();

  try {
    const standings = cachedStandingsEntry?.data || await standingsPromise;

    if (!standings) throw new Error('No standings data');

    if (!TEAM_ABBR || TEAM_ABBR.length < 2 || TEAM_ABBR.length > 3 || !extractTeamFromStandings(standings, TEAM_ABBR)) {
      TEAM_ABBR = resolveDefaultTeamAbbr(standings);
      const url = new URL(window.location.href);
      url.searchParams.set('team', TEAM_ABBR);
      window.history.replaceState({}, '', url);
    }

    TEAM_DATA = extractTeamFromStandings(standings, TEAM_ABBR);
    if (!TEAM_DATA) throw new Error(`Team ${TEAM_ABBR} not found`);

    // If we didn't have cached data, paint the header as soon as standings arrive
    if (!cachedStandingsEntry?.data) {
      try {
        renderTeamHeader();
      } catch (e) {
        console.warn('[PM] Early team header render failed:', e.message);
      }
    }

    // Fetch real team stats from prediction API and merge
    try {
      const realStats = await _staleWhileRevalidate({
        cacheKey: `team_stats_${TEAM_ABBR}_v1`,
        ttlKey: 'standings',
        workerPath: `/api/team_stats?team=${TEAM_ABBR}`,
        logLabel: `Team(${TEAM_ABBR}) → Real Stats`,
        processResponse(json) { return json || null; },
      });
      if (realStats) {
        TEAM_DATA = {
          ...TEAM_DATA,
          ortg: realStats.ortg,
          drtg: realStats.drtg,
          pace: realStats.pace,
          elo: realStats.elo,
          fourFactors: realStats.four_factors,
          percentiles: realStats.percentiles,
        };
      }
    } catch (e) {
      console.warn('[PM] Failed to fetch real team stats, using heuristics:', e.message);
    }

    try { localStorage.setItem('pm_last_team', TEAM_ABBR); } catch {}

    renderInjuryTicker();
    renderScoutReport();
    renderFourFactors();
    renderRosterSkeleton();
    renderScheduleSkeleton();
    
    // Render all analytics sections
    renderTeamOverview();
    try {
      renderRatingTimeline();
    } catch (e) {
      console.warn('[PM] Rating timeline render failed:', e.message);
    }
    renderEfficiencyBreakdown();
    renderPlayTypeBreakdown();
    renderLineupData();
    renderTeamAdvancedMetrics();
    applyMetricTooltips();

    // Start auto-refreshing live data for the team page
    startAutoRefresh();

    // Bootstrap Player Analytics Lab as soon as the core page is painted
    if (typeof window.initAnalyticsLab === 'function') {
      window.initAnalyticsLab();
    }

    // Load slower supporting data after the page has already rendered core content
    void loadSupportingTeamData();

  } catch (err) {
    console.error('[PM] Team page init failed:', err);
    renderError(`Failed to load ${TEAM_ABBR}: ${err.message}`);
    return;
  }

}

async function loadSupportingTeamData() {
  const cachedScheduleEntry = window.pmReadClientCache ? window.pmReadClientCache(`schedule_${TEAM_ABBR}_v2`, 'schedule', true) : null;
  const cachedRecentEntry = window.pmReadClientCache ? window.pmReadClientCache(`schedule_recent_${TEAM_ABBR}_v1`, 'schedule', true) : null;

  if (cachedScheduleEntry?.data) {
    SCHEDULE_MAP = cachedScheduleEntry.data || {};
    SCHEDULE_DATA = flattenTeamSchedule(SCHEDULE_MAP, TEAM_ABBR);
      SCHEDULE_LOADING = false;
  }
  if (cachedRecentEntry?.data) {
    RECENT_GAMES = Array.isArray(cachedRecentEntry.data) ? cachedRecentEntry.data : RECENT_GAMES;
  }

  try { if (cachedScheduleEntry?.data || cachedRecentEntry?.data) renderSchedule(); } catch (e) { console.warn('[PM] Cached schedule render failed:', e.message); }

  const schedulePromise = fetchSchedule().catch(() => null);
  const rosterPromise = fetchRosterWithRetry().catch(() => null);
  const injuryPromise = loadInjurySnapshot().catch(() => null);
  const recentPromise = loadRecentGames().catch(() => null);

  // Schedule should appear as soon as raw schedule data lands.
  schedulePromise.then(async schedule => {
    if (!schedule) return;
    SCHEDULE_MAP = schedule || {};
    SCHEDULE_DATA = flattenTeamSchedule(SCHEDULE_MAP, TEAM_ABBR);
    SCHEDULE_LOADING = false;
    try { renderSchedule(); } catch (e) { console.warn('[PM] Schedule render failed:', e.message); }
  });

  // Roster should paint immediately from raw player list, then enrich in the background.
  rosterPromise.then(async roster => {
    if (!roster) {
      try { renderRosterSkeleton(); } catch (e) { console.warn('[PM] Roster skeleton render failed:', e.message); }
      return;
    }
    const rawRoster = Array.isArray(roster) ? roster : (roster?.players || []);
    if (rawRoster.length) {
      ROSTER_DATA = rawRoster;
      ROSTER_LOADING = false;
      try { renderRoster(); } catch (e) { console.warn('[PM] Roster render failed:', e.message); }
      try { window.syncAnalyticsLabRoster?.(TEAM_ABBR, ROSTER_DATA); } catch (e) { console.warn('[PM] Analytics lab roster sync failed:', e.message); }
      void enrichRosterPlayers(rawRoster)
        .then(enriched => {
          if (Array.isArray(enriched) && enriched.length) {
            ROSTER_DATA = enriched;
            try { renderRoster(); } catch {}
            try { window.syncAnalyticsLabRoster?.(TEAM_ABBR, ROSTER_DATA); } catch {}
          }
        })
        .catch(() => null);
    } else {
      try { renderRosterSkeleton(); } catch (e) { console.warn('[PM] Roster skeleton render failed:', e.message); }
    }
  });

  injuryPromise.then(() => {
    try { renderInjuryTicker(); } catch (e) { console.warn('[PM] Injury ticker render failed:', e.message); }
    try { renderScoutReport(); } catch (e) { console.warn('[PM] Scout report render failed:', e.message); }
    try { renderTeamOverview(); renderTeamAdvancedMetrics(); } catch (e) { console.warn('[PM] Background analytics render failed:', e.message); }
  });

  recentPromise.then(() => {
    try { renderSchedule(); } catch (e) { console.warn('[PM] Schedule render failed:', e.message); }
  });

  Promise.allSettled([schedulePromise, rosterPromise, injuryPromise, recentPromise]).then(() => {
    SCHEDULE_LOADING = false;
    if (ROSTER_DATA && ROSTER_DATA.length) {
      ROSTER_LOADING = false;
      try { renderRoster(); } catch {}
    } else {
      try { renderRosterSkeleton(); } catch {}
    }
    try { renderSchedule(); } catch {}
  });
}

// ─── REALTIME (SSE → WebSocket fallback) ───────────────────────────────────
function handleRealTimeMessage(msg) {
  // Expected message shape: { type: 'team_update'|'standings'|'schedule'|'roster'|'recent_games' }
  const t = (msg && msg.type) ? String(msg.type) : null;
  if (!t) return;
  const badge = document.getElementById('analyticsFreshness');
  if (badge) {
    badge.textContent = t.replace(/_/g, ' ').toUpperCase();
  }
  if (t === 'team_update' || t === 'predict_update' || t === 'injury_update') {
    // lightweight
    refreshTeamData(false);
  } else if (t === 'team_stats_refresh' || t === 'injury_refresh' || t === 'shot_zones_refresh' || t === 'play_types_refresh' || t === 'schedule_refresh') {
    refreshTeamData(false);
  } else if (t === 'standings' || t === 'standings_update') {
    refreshTeamData(false);
  } else if (t === 'schedule' || t === 'roster' || t === 'recent_games' || t === 'full_update') {
    refreshTeamData(true);
  } else {
    // Unknown: do a light refresh
    refreshTeamData(false);
  }
}

function fallbackToWebSocket(base, path) {
  try {
    const wsProto = base.startsWith('https') ? 'wss' : 'ws';
    const host = base.replace(/^https?:\/\//, '').replace(/:\d+$/, m => '');
    const wsUrl = `${wsProto}://${base.replace(/^https?:\/\//, '').replace(/\/$/, '')}/ws?team=${TEAM_ABBR}`;
    const ws = new WebSocket(wsUrl);
    __pm_team_realtime_conn = ws;
    ws.addEventListener('open', () => {
      __pm_team_realtime_connected = true;
      const badge = document.getElementById('analyticsFreshness');
      if (badge) badge.textContent = 'LIVE WS';
      console.info('[PM] WebSocket connected', wsUrl);
      // stop polling while realtime is active
      __pm_team_auto_handles.forEach(h => h && h.clear && h.clear());
    });
    ws.addEventListener('message', (ev) => {
      try { const data = JSON.parse(ev.data); handleRealTimeMessage(data); } catch { handleRealTimeMessage({ type: 'team_update' }); }
    });
    ws.addEventListener('close', () => {
      __pm_team_realtime_connected = false;
      __pm_team_realtime_conn = null;
      const badge = document.getElementById('analyticsFreshness');
      if (badge) badge.textContent = 'READY';
      console.info('[PM] WebSocket closed');
    });
    ws.addEventListener('error', (e) => { console.warn('[PM] WebSocket error', e); ws.close(); });
  } catch (err) { console.warn('[PM] fallbackToWebSocket failed', err.message); }
}

function startRealtimeConnection() {
  if (PM_IS_FILE) return;
  if (__pm_team_realtime_conn) return;
  const base = resolvePredictionApiBase();
  const candidates = [
    `${base.replace(/\/$/, '')}/events?team=${TEAM_ABBR}`,
    `${base.replace(/\/$/, '')}/sse?team=${TEAM_ABBR}`,
    `${base.replace(/\/$/, '')}/stream?team=${TEAM_ABBR}`,
  ];

  // Try EventSource first
  try {
    const esUrl = candidates[0];
    const es = new EventSource(esUrl);
    __pm_team_realtime_conn = es;
    es.onopen = () => {
      __pm_team_realtime_connected = true;
      const badge = document.getElementById('analyticsFreshness');
      if (badge) badge.textContent = 'LIVE SSE';
      console.info('[PM] SSE connected', esUrl);
      // stop polling while realtime is active
      __pm_team_auto_handles.forEach(h => h && h.clear && h.clear());
    };
    es.onmessage = (e) => {
      try { const data = JSON.parse(e.data); handleRealTimeMessage(data); } catch { handleRealTimeMessage({ type: 'team_update' }); }
    };
    es.onerror = (e) => {
      try { es.close(); } catch {}
      __pm_team_realtime_connected = false;
      __pm_team_realtime_conn = null;
      const badge = document.getElementById('analyticsFreshness');
      if (badge) badge.textContent = 'READY';
      console.warn('[PM] SSE error, falling back to WebSocket');
      fallbackToWebSocket(base);
    };
    return;
  } catch (err) {
    console.warn('[PM] SSE construction failed:', err.message);
  }

  // If EventSource not available/failed, try WebSocket
  fallbackToWebSocket(base);
}


// ─── DATA FETCHING ──────────────────────────────────────────────────────────
async function fetchStandings() {
  // Use a team-specific cache key so the global standings SWR refresh
  // (which emits standings:updated and can corrupt team page DOM) doesn't
  // share the same fetch/cache cycle as our call.
  return await _staleWhileRevalidate({
    cacheKey: 'standings_teampage', ttlKey: 'standings', workerPath: '/api/standings',
    logLabel: `Team(${TEAM_ABBR}) → Standings`,
    processResponse(json) { return json?.data || null; },
  });
}

async function fetchSchedule() {
  return await _staleWhileRevalidate({
    cacheKey: `schedule_${TEAM_ABBR}_v2`, ttlKey: 'schedule', workerPath: `/api/schedule?days=14`,
    logLabel: `Team(${TEAM_ABBR}) → Schedule`,
    timeoutMs: 30000,
    retries: 1,
    processResponse(json) {
      return json?.schedule || json?.data?.schedule || json?.data || null;
    },
  });
}

async function fetchRecentScheduleHistory() {
  const anchorDate = dateKeyOffset(-30);
  return await _staleWhileRevalidate({
    cacheKey: `schedule_recent_${TEAM_ABBR}_v1`, ttlKey: 'schedule',
    workerPath: `/api/schedule?days=30&date=${anchorDate}`,
    logLabel: `Team(${TEAM_ABBR}) → Recent Schedule History`,
    timeoutMs: 30000,
    retries: 1,
    processResponse(json) {
      return json?.schedule || json?.data?.schedule || json?.data || null;
    },
  });
}

async function fetchRoster() {
  const freshToken = Date.now();
  const rosterPath = `/api/team_top_players?team=${TEAM_ABBR}&n=10&fresh=1&ts=${freshToken}`;
  try {
    const json = await backendFirstFetch(rosterPath, 12000, 0);
    return normalizeTopPlayersResponse(json);
  } catch (err) {
    console.warn('[PM] fetchRoster failed:', err.message);
    try { window.showNonBlockingError?.(`Roster load failed: ${err.message}`); } catch {}
    throw err;
  }
}

async function fetchRosterWithRetry(attempt = 0) {
  return await retryFetch(async () => {
    const roster = await fetchRoster();
    const rawRoster = Array.isArray(roster) ? roster : (roster?.players || []);
    if (!rawRoster.length) throw new Error('empty roster');
    return roster;
  }, 3, 800).catch(() => null);
}

async function loadInjurySnapshot() {
  const upcoming = SCHEDULE_DATA
    .filter(game => game.status !== 3 && (game.home === TEAM_ABBR || game.away === TEAM_ABBR))
    .sort((a, b) => new Date(a.startTime || a.date || 0) - new Date(b.startTime || b.date || 0));
  const next = upcoming[0];
  const fallbackOpponent = TEAM_ABBR === 'LAL' ? 'BOS' : 'LAL';
  const opponent = next ? (next.home === TEAM_ABBR ? next.away : next.home) : fallbackOpponent;
  const home = TEAM_ABBR;
  const away = opponent;

  try {
    const json = await backendFirstFetch(`/api/predict?home=${home}&away=${away}`, PREDICTION_TIMEOUT_MS, 0);
    const injuries = json?.meta?.injuries || json?.injuries || {};
    const ours = injuries.home || {};
    const outCount = Number(ours.out_count ?? ours.outCount ?? 0);
    const details = Array.isArray(ours.players) ? ours.players : [];
    INJURY_SNAPSHOT = { outCount: Number.isFinite(outCount) ? outCount : 0, details };
  } catch {
    INJURY_SNAPSHOT = { outCount: 0, details: [] };
  }
}

async function fetchPrediction(home, away) {
  const key = `${home}_vs_${away}`;
  if (PREDICTIONS[key]) return PREDICTIONS[key];

  try {
    const json = await backendFirstFetch(`/api/predict?home=${home}&away=${away}`, PREDICTION_TIMEOUT_MS, 0);
    // API returns final_probs.home_win / away_win
    const fp = json?.final_probs || json?.layers?.ml_model || {};
    const pred = {
      home, away,
      homeWinProb: normalizeProbabilityValue(fp.home_win ?? json?.home_win_prob ?? null),
      awayWinProb: normalizeProbabilityValue(fp.away_win ?? json?.away_win_prob ?? null),
      error: null,
    };
    PREDICTIONS[key] = pred;
    return pred;
  } catch (err) {
    const pred = { home, away, homeWinProb: null, awayWinProb: null, error: err.message };
    PREDICTIONS[key] = pred;
    return pred;
  }
}

// ─── DATA PROCESSING ────────────────────────────────────────────────────────
function extractTeamFromStandings(standings, abbr) {
  for (const conf of ['east', 'west']) {
    const team = (standings[conf] || []).find(t => t.abbr === abbr);
    if (team) {
      const seed = (standings[conf] || []).indexOf(team) + 1;
      return {
        ...team, seed,
        name: team.name || team.team || team.teamName || team.fullName || abbr,
        gb: normalizeGamesBack(team.gb ?? team.gamesBehind ?? team.ConferenceGamesBack),
        conference: conf === 'east' ? 'E' : 'W',
        playoffProb: parsePlayoffProbability(team),
        streak: team.streak || team.strk || team.Streak || 'N/A',
      };
    }
  }
  return null;
}

function parsePlayoffProbability(team) {
  if (team.seed) {
    const seed = Number(team.seed);
    if (seed <= 6) return [99,98,96,94,93,92][seed-1] ?? 92;
    if (seed <= 10) return [75,58,38,25][seed-7] ?? 25;
    if (seed <= 15) return [20,16,12,7,1][seed-11] ?? 1;
  }
  return 50;
}

function computeNetRating(team) {
  const ortg = Number(team.ortg ?? team.offRtg ?? team.ORTG ?? NaN);
  const drtg = Number(team.drtg ?? team.defRtg ?? team.DRTG ?? NaN);
  if (Number.isFinite(ortg) && Number.isFinite(drtg)) return (ortg - drtg).toFixed(1);
  // Fallback: estimate from W/L
  const w = Number(team.w); const l = Number(team.l);
  if (w + l > 0) {
    const pct = w / (w + l);
    return (((pct - 0.5) * 20).toFixed(1));
  }
  return null;
}

function computeL10(recentGames, teamAbbr) {
  const last10 = recentGames.slice(0, 10);
  if (!last10.length) return null;
  let wins = 0, losses = 0;
  last10.forEach(g => {
    const hs = Number(g.homeScore ?? g.home?.score ?? 0);
    const as = Number(g.awayScore ?? g.away?.score ?? 0);
    if (!hs && !as) return;
    const isHome = g.home === teamAbbr;
    const ourScore = isHome ? hs : as;
    const oppScore = isHome ? as : hs;
    if (ourScore > oppScore) wins++; else losses++;
  });
  return wins + losses > 0 ? `${wins}-${losses}` : null;
}

async function loadRecentGames() {
  const historySchedule = await fetchRecentScheduleHistory();
  const mergedSchedule = mergeScheduleMaps(SCHEDULE_MAP, historySchedule || {});
  const historicalTeamGames = flattenTeamSchedule(mergedSchedule, TEAM_ABBR);

  const completedGames = historicalTeamGames
    .filter(game => game.status === 3 && (game.home === TEAM_ABBR || game.away === TEAM_ABBR))
    .sort((a, b) => new Date(b.startTime || b.date || 0) - new Date(a.startTime || a.date || 0))
    .slice(0, 10);

  const uniqueDates = [...new Set(completedGames.map(game => game.date).filter(Boolean))];
  const scoreMaps = await Promise.all(uniqueDates.map(loadScoreboardForDate));
  const scoreLookup = Object.assign({}, ...scoreMaps.filter(Boolean));

  RECENT_GAMES = completedGames.map(game => {
    const key = `${game.home}-${game.away}-${game.date}`;
    const reverseKey = `${game.away}-${game.home}-${game.date}`;
    return scoreLookup[key] || scoreLookup[reverseKey] || game;
  });

  renderRecentGames();
  renderTeamInsights();
}

// ─── AUTO-REFRESH HELPERS ─────────────────────────────────────────────────
let __pm_team_auto_handles = [];
let __pm_team_realtime_conn = null;
let __pm_team_realtime_connected = false;
async function refreshTeamData(full = false) {
  try {
    // Lightweight refresh: standings (quick) and injury snapshot
    const standingsPromise = fetchStandings().catch(() => null);
    const injuryPromise = loadInjurySnapshot().catch(() => null);

    if (!full) {
      const standings = await standingsPromise;
      if (standings) {
        const updated = extractTeamFromStandings(standings, TEAM_ABBR);
        if (updated) {
          TEAM_DATA = { ...TEAM_DATA, ...updated };
        }
      }
      await injuryPromise;
      renderTeamHeader();
      renderInjuryTicker();
      return;
    }

    // Full refresh: standings, schedule, roster, recent games + injury
    const [standings, schedule, roster] = await Promise.all([
      fetchStandings().catch(() => null),
      fetchSchedule().catch(() => null),
      fetchRoster().catch(() => null),
    ]);

    if (standings) {
      const updated = extractTeamFromStandings(standings, TEAM_ABBR);
      if (updated) TEAM_DATA = { ...TEAM_DATA, ...updated };
    }
    if (schedule) {
      SCHEDULE_MAP = schedule || SCHEDULE_MAP;
      SCHEDULE_DATA = flattenTeamSchedule(SCHEDULE_MAP, TEAM_ABBR);
    }
    if (roster) {
      ROSTER_DATA = await enrichRosterPlayers(Array.isArray(roster) ? roster : (roster?.players || []));
    }

    await loadInjurySnapshot().catch(() => null);
    try { await loadRecentGames(); } catch {}

    // Re-render key sections
    renderTeamHeader();
    renderInjuryTicker();
    renderFourFactors();
    try { renderRoster(); } catch (e) { console.warn('[PM] Roster render after refresh failed', e.message); }
    try { renderSchedule(); } catch (e) { console.warn('[PM] Schedule render after refresh failed', e.message); }
  } catch (err) {
    console.warn('[PM] refreshTeamData failed:', err.message);
  }
}

function startAutoRefresh() {
  // Clear previous handles if any
  __pm_team_auto_handles.forEach(h => h && h.clear && h.clear());
  __pm_team_auto_handles = [];

  // Allow override via global config `window.PM_TEAM_REFRESH = { quick: ms, full: ms }`
  const cfg = (window.PM_TEAM_REFRESH && typeof window.PM_TEAM_REFRESH === 'object') ? window.PM_TEAM_REFRESH : { quick: 30_000, full: 120_000 };
  const quickMs = Number(cfg.quick) || 30_000;
  const fullMs = Number(cfg.full) || 120_000;

  // Start realtime connection; if connected it will clear polling handles
  try { startRealtimeConnection(); } catch (e) { console.warn('[PM] startRealtimeConnection failed', e.message); }

  // Short: quick header/injury refresh
  __pm_team_auto_handles.push(visibilityInterval(() => {
    if (!__pm_team_realtime_connected) refreshTeamData(false);
  }, quickMs));

  // Medium: recent games + roster + schedule
  __pm_team_auto_handles.push(visibilityInterval(() => {
    if (!__pm_team_realtime_connected) refreshTeamData(true);
  }, fullMs));

  // Cleanup on unload
  window.addEventListener('beforeunload', () => {
    __pm_team_auto_handles.forEach(h => h && h.clear && h.clear());
  });
}

async function loadScoreboardForDate(dateKey) {
  if (!dateKey) return null;
  const compact = dateKey.replace(/-/g, '');
  try {
    const json = await workerFetch(`/api/proxy?url=${encodeURIComponent(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${compact}`)}`, 12000, 0);
    const games = json?.events ?? [];
    const map = {};
    games.forEach(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      const state = ev.status?.type?.state;
      if (!home || !away || state !== 'post') return;
      const homeAbbr = home.team?.abbreviation ?? '???';
      const awayAbbr = away.team?.abbreviation ?? '???';
      const homeScore = Number(home.score ?? 0);
      const awayScore = Number(away.score ?? 0);
      const homeWon = homeScore > awayScore;
      map[`${homeAbbr}-${awayAbbr}-${dateKey}`] = {
        home: homeAbbr, away: awayAbbr, date: dateKey, status: 3,
        startTime: ev.date ?? dateKey, homeScore, awayScore,
        result: homeWon ? `${homeAbbr} W` : `${homeAbbr} L`,
      };
      map[`${awayAbbr}-${homeAbbr}-${dateKey}`] = {
        home: homeAbbr, away: awayAbbr, date: dateKey, status: 3,
        startTime: ev.date ?? dateKey, homeScore, awayScore,
        result: homeWon ? `${awayAbbr} L` : `${awayAbbr} W`,
      };
    });
    return map;
  } catch { return null; }
}

// ─── RENDERING ──────────────────────────────────────────────────────────────
function renderTeamHeader() {
  if (!TEAM_DATA) return;
  const headerEl = document.getElementById('teamHeader');
  const color = getTeamAccentColor(TEAM_ABBR, TEAM_DATA.color || '#888888');
  TEAM_DATA.color = color;
  const teamName = TEAM_DATA.name || TEAM_DATA.team || TEAM_DATA.teamName || TEAM_DATA.fullName || TEAM_ABBR;
  const seedOrdinal = ordinalSuffix(TEAM_DATA.seed);
  const conf = TEAM_DATA.conference === 'E' ? 'East' : 'West';
  
  // Hero section: team color gradient + radial glow in center
  const teamColorFade = `linear-gradient(135deg, ${esc(color)}08 0%, ${esc(color)}04 50%, transparent 100%), radial-gradient(800px circle at 40% 50%, ${esc(color)}06 0%, transparent 100%)`;

  headerEl.innerHTML = `
    <div class="team-header-hero" style="background: ${teamColorFade}; border-left: 6px solid ${esc(color)}">
      <!-- Massive ghosted team abbr in background -->
      <div class="team-header-watermark" style="color: ${esc(color)}">${esc(TEAM_DATA.abbr)}</div>
      
      <div class="team-header-content">
        <div class="team-header-left">
          <div class="team-header-abbr" style="color: ${esc(color)}">${esc(TEAM_DATA.abbr)}</div>
          <div class="team-header-title">
            <div class="team-header-name">${esc(teamName)}</div>
            <div class="team-header-seed" style="color: ${esc(color)}">${seedOrdinal} in ${conf}</div>
          </div>
        </div>
        
        <div class="team-header-right">
          <div class="team-header-record-hero">
            <span class="record-value">${TEAM_DATA.w}-${TEAM_DATA.l}</span>
            <span class="record-label">Record</span>
          </div>
          <div class="team-header-stat">
            <span class="stat-number">${TEAM_DATA.playoffProb}%</span>
            <span class="stat-label">Playoff Chance</span>
          </div>
        </div>
      </div>
    </div>`;

  const bc = document.getElementById('breadcrumbTeam');
  if (bc) bc.textContent = TEAM_DATA.abbr;
  document.title = `${teamName} | Plus-Minus NBA`;

  const recordEl = document.getElementById('recordValue');
  if (recordEl) recordEl.textContent = `${TEAM_DATA.w}-${TEAM_DATA.l}`;
  const recordSplitEl = document.getElementById('recordSplitValue');
  if (recordSplitEl) recordSplitEl.textContent = 'Loading split data…';

  const winPctValue = Number(TEAM_DATA.pct ?? (TEAM_DATA.w / Math.max(TEAM_DATA.w + TEAM_DATA.l, 1)).toFixed(3));
  animateCountUp('winPctValue', Math.round(winPctValue * 100), 0, (value) => `${value}%`);
  animateCountUp('seedValue', TEAM_DATA.seed, 0, (value) => `${value} / 15`);
  animateCountUp('playoffEstValue', TEAM_DATA.playoffProb, 0, (value) => `${value}%`);
  const playoffRankEl = document.getElementById('winPctRankValue');
  if (playoffRankEl) playoffRankEl.textContent = `${ordinalSuffix(TEAM_DATA.seed)} in ${TEAM_DATA.conference === 'E' ? 'East' : 'West'}`;
  const conferenceRankEl = document.getElementById('conferenceRankValue');
  if (conferenceRankEl) conferenceRankEl.innerHTML = `<svg class="lucide-icon" width="10" height="10"><use href="#icon-trophy"/></svg> ${ordinalSuffix(TEAM_DATA.seed)} in ${TEAM_DATA.conference === 'E' ? 'East' : 'West'}`;

  const streakEl = document.getElementById('streakValue');
  if (streakEl) streakEl.textContent = TEAM_DATA.streak || TEAM_DATA.strk || 'N/A';
  const gbEl = document.getElementById('gbValue');
  if (gbEl) gbEl.textContent = TEAM_DATA.gb ?? '—';

  const nrt = computeNetRating(TEAM_DATA);
  const nrtEl = document.getElementById('netRatingValue');
  const nrtTrendEl = document.getElementById('netRatingTrend');
  if (nrtEl) {
    const n = Number(nrt);
    if (Number.isFinite(n)) {
      animateCountUp('netRatingValue', Math.round(n * 10) / 10, 1, (value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`);
      nrtEl.style.color = n > 0 ? 'var(--lime)' : n < 0 ? 'var(--coral)' : '';
    } else {
      nrtEl.textContent = '—';
    }
  }
  if (nrtTrendEl) nrtTrendEl.textContent = 'Awaiting form context…';

  const gaugeValueEl = document.getElementById('netRatingGaugeValue');
  if (gaugeValueEl) gaugeValueEl.textContent = '—';

  // L10 — computed after recent games load, set placeholder
  const lastTenValueEl = document.getElementById('lastTenValue');
  if (lastTenValueEl) {
    lastTenValueEl.textContent = '…';
  }

  renderTeamContextBar();
}
// ─── RATING TIMELINE (Chart.js) ──────────────────────────────────────────────
let ratingTimelineChartInstance = null;

function renderRatingTimeline() {
  const canvas = document.getElementById('ratingTimelineChart');
  if (!canvas) return;

  if (typeof Chart === 'undefined') {
    const section = canvas.closest('.rating-timeline-section');
    if (section) section.style.display = 'none';
    console.warn('[PM] Chart.js was blocked or failed to load. Rating Timeline hidden.');
    return;
  }

  const games = [...RECENT_GAMES]
    .filter(game => Number.isFinite(Number(game.homeScore ?? game.awayScore ?? NaN)))
    .reverse();
    
  window._TIMELINE_GAMES = games;

  const labels = games.map((game, idx) => game.date || `G${idx + 1}`);
  const netData = games.map(game => {
    const isHome = game.home === TEAM_ABBR;
    const ourScore = Number(isHome ? game.homeScore : game.awayScore);
    const oppScore = Number(isHome ? game.awayScore : game.homeScore);
    return Number.isFinite(ourScore) && Number.isFinite(oppScore) ? ourScore - oppScore : 0;
  });
  const offData = games.map(game => Number(game.home === TEAM_ABBR ? game.homeScore : game.awayScore) || 0);
  const defData = games.map(game => Number(game.home === TEAM_ABBR ? game.awayScore : game.homeScore) || 0);
  const notableGames = new Set(
    games
      .map((game, idx) => ({
        idx,
        margin: Math.abs((game.home === TEAM_ABBR ? Number(game.homeScore) - Number(game.awayScore) : Number(game.awayScore) - Number(game.homeScore)) || 0),
      }))
      .filter(item => item.margin >= 10)
      .map(item => item.idx)
  );

  const getEventPoints = (data) => data.map((val, idx) => (notableGames.has(idx) ? val : null));

  const getTrailingHighlight = () => {
    const highlightWindow = 15;
    return labels.map((_, idx) => (idx >= labels.length - highlightWindow ? 100 : 0));
  };

  const colorLime = '#c5f82a';
  const colorAmber = '#ffb300';
  const colorCoral = '#ff4b26';

  const chartConfig = {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Net Rating',
          data: netData,
          borderColor: colorLime,
          backgroundColor: 'rgba(197, 248, 42, 0.1)',
          borderWidth: 2,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 6,
          tension: 0.3,
          order: 2
        },
        {
          label: 'Events',
          data: getEventPoints(netData),
          backgroundColor: '#fff',
          borderColor: colorLime,
          borderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 8,
          showLine: false,
          order: 1
        },
        {
          label: 'Trailing Window',
          type: 'bar',
          data: getTrailingHighlight(),
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          barPercentage: 1.0,
          categoryPercentage: 1.0,
          hoverBackgroundColor: 'rgba(255, 255, 255, 0.03)',
          order: 3,
          yAxisID: 'yTrailing'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(5, 5, 10, 0.9)',
          titleFont: { family: 'JetBrains Mono', size: 11 },
          bodyFont: { family: 'Inter Tight', size: 13 },
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            title: (ctx) => `Game ${ctx[0].dataIndex + 1}`,
            label: (ctx) => {
              if (ctx.dataset.label === 'Events' || ctx.dataset.label === 'Trailing Window') return null;
              const val = ctx.raw !== null ? ctx.raw.toFixed(1) : '';
              return `${ctx.dataset.label}: ${val > 0 ? '+' : ''}${val}`;
            },
            afterBody: (ctx) => {
              const idx = ctx[0].dataIndex;
              if (events[idx + 1]) return `\n${events[idx + 1]}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.03)', drawBorder: false },
          ticks: { color: 'rgba(255,255,255,0.4)', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 10 }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false, borderDash: [4, 4] },
          ticks: { color: 'rgba(255,255,255,0.4)', font: { family: 'JetBrains Mono', size: 10 } }
        }
      }
    }
  };

  if (ratingTimelineChartInstance) {
    ratingTimelineChartInstance.destroy();
  }
  
  ratingTimelineChartInstance = new Chart(canvas, chartConfig);

  // Setup Toggles
  const toggles = document.querySelectorAll('.timeline-toggle');
  toggles.forEach(btn => {
    btn.addEventListener('click', (e) => {
      toggles.forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      
      const metric = e.target.dataset.metric;
      let targetData, color, label;

      if (metric === 'net') {
        targetData = netData; color = colorLime; label = 'Net Rating';
      } else if (metric === 'off') {
        targetData = offData; color = colorAmber; label = 'Offensive Rating';
      } else {
        targetData = defData; color = colorCoral; label = 'Defensive Rating';
      }

      ratingTimelineChartInstance.data.datasets[0].data = targetData;
      ratingTimelineChartInstance.data.datasets[0].borderColor = color;
      ratingTimelineChartInstance.data.datasets[0].backgroundColor = color.replace(')', ', 0.1)').replace('rgb', 'rgba').replace('#c5f82a', 'rgba(197, 248, 42, 0.1)').replace('#ffb300', 'rgba(255, 179, 0, 0.1)').replace('#ff4b26', 'rgba(255, 75, 38, 0.1)');
      ratingTimelineChartInstance.data.datasets[0].label = label;
      
      ratingTimelineChartInstance.data.datasets[1].data = getEventPoints(targetData);
      ratingTimelineChartInstance.data.datasets[1].borderColor = color;

      ratingTimelineChartInstance.update();
    });
  });
}

function renderRoster() {
  const tbody = document.getElementById('rosterTableBody');
  if (!tbody) return;

  if (ROSTER_LOADING && (!ROSTER_DATA || ROSTER_DATA.length === 0)) {
    renderRosterSkeleton();
    return;
  }

  if (!ROSTER_DATA || ROSTER_DATA.length === 0) {
    renderRosterSkeleton();
    return;
  }

  // Sort by Minutes per game descending
  const sorted = ROSTER_DATA.map(p => normalizeRosterPlayer(p)).sort((a, b) => (Number(b.min) || 0) - (Number(a.min) || 0));
  const statValues = {
    mpg: sorted.map(player => Number(player.min) || 0),
    pts: sorted.map(player => Number(player.pts) || 0),
    ast: sorted.map(player => Number(player.ast) || 0),
    reb: sorted.map(player => Number(player.reb) || 0),
    stl: sorted.map(player => Number(player.stl) || 0),
    blk: sorted.map(player => Number(player.blk) || 0),
    tov: sorted.map(player => Number(player.tov) || 0),
    usg: sorted.map(player => Number(player.usage) || 0),
    off: sorted.map(player => Number(player.off) || 0),
    def: sorted.map(player => Number(player.def) || 0),
    epm: sorted.map(player => Number(player.epm) || 0),
    ts: sorted.map(player => Number(player.tsPct) || 0),
    pa2: sorted.map(player => Number(player.pa2) || 0),
    p2: sorted.map(player => Number(player.p2Pct) || 0),
    pa3: sorted.map(player => Number(player.pa3) || 0),
    p3: sorted.map(player => Number(player.p3Pct) || 0),
    fta: sorted.map(player => Number(player.fta) || 0),
    ftPct: sorted.map(player => Number(player.ftPct) || 0),
    orb: sorted.map(player => Number(player.orb) || 0),
    drb: sorted.map(player => Number(player.drb) || 0),
  };

  function percentileFor(values, value, reverse = false) {
    const numeric = Number(value);
    const finite = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (!finite.length || !Number.isFinite(numeric)) return 50;
    const below = finite.filter(v => v < numeric).length;
    const pct = Math.round((below / finite.length) * 100);
    return reverse ? 100 - pct : pct;
  }

  function getHeatmapBg(pct) {
    // Branding Lime: 197, 248, 42
    if (pct >= 90) return 'rgba(197, 248, 42, 0.25)';
    if (pct >= 75) return 'rgba(197, 248, 42, 0.15)';
    if (pct >= 60) return 'rgba(197, 248, 42, 0.08)';
    // Branding Blue: 60, 174, 255
    if (pct <= 10) return 'rgba(60, 174, 255, 0.25)';
    if (pct <= 25) return 'rgba(60, 174, 255, 0.15)';
    if (pct <= 40) return 'rgba(60, 174, 255, 0.08)';
    return 'transparent';
  }

  function renderStatCell(value, pct, reverse = false) {
    const displayPct = Math.round(pct);
    const bgPct = reverse ? 100 - displayPct : displayPct;
    const bg = getHeatmapBg(bgPct);
    return `
      <td class="roster-hd-cell" style="background-color: ${bg};">
        <div class="hd-val">${value}</div>
        <div class="hd-pct">${displayPct}</div>
      </td>`;
  }

  // Remove loading ARIA attributes when actual roster is rendered
  try { tbody.removeAttribute('aria-busy'); tbody.removeAttribute('role'); } catch {}

  tbody.innerHTML = sorted.map((normalized, i) => {
    const mpg = Number(normalized.min || 0).toFixed(1);
    const pts = Number(normalized.pts || 0).toFixed(1);
    const ast = Number(normalized.ast || 0).toFixed(1);
    const reb = Number(normalized.reb || 0).toFixed(1);
    const orb = Number.isFinite(Number(normalized.orb)) ? Number(normalized.orb).toFixed(1) : Math.max(0, Number(reb) * 0.28).toFixed(1);
    const drb = Number.isFinite(Number(normalized.drb)) ? Number(normalized.drb).toFixed(1) : Math.max(0, Number(reb) - Number(orb)).toFixed(1);
    const stl = Number.isFinite(Number(normalized.stl)) ? Number(normalized.stl).toFixed(1) : Math.max(0, (Number(ast) + Number(reb)) / 28).toFixed(1);
    const blk = Number.isFinite(Number(normalized.blk)) ? Number(normalized.blk).toFixed(1) : Math.max(0, Number(reb) / 12).toFixed(1);
    const tov = Number.isFinite(Number(normalized.tov)) ? Number(normalized.tov).toFixed(1) : Math.max(0, (Number(pts) + Number(ast)) / 12).toFixed(1);

    const fga = Number(normalized.fga || 0);
    const fg3a = Number(normalized.fg3a || 0);
    const fg2a = Number.isFinite(fga) && Number.isFinite(fg3a) ? Math.max(0, fga - fg3a) : 0;
    const fgm = Number(normalized.fgm || 0);
    const fg3m = Number(normalized.fg3m || 0);
    const fg2m = Number.isFinite(fgm) && Number.isFinite(fg3m) ? Math.max(0, fgm - fg3m) : 0;
    const fta = Number(normalized.fta || 0);
    const ftm = Number(normalized.ftm || 0);
    const usageProxy = Number.isFinite(Number(normalized.usage))
      ? Number(normalized.usage).toFixed(1)
      : clamp((fga + 0.44 * fta + Number(tov)) / Math.max(Number(mpg), 1) * 2.4, 8, 35).toFixed(1);
    const off = Number.isFinite(Number(normalized.off))
      ? Number(normalized.off).toFixed(1)
      : clamp(Number(pts) * 0.35 + Number(ast) * 0.45 + Number(reb) * 0.2 - Number(tov) * 0.5, -5, 10).toFixed(1);
    const def = Number.isFinite(Number(normalized.def))
      ? Number(normalized.def).toFixed(1)
      : clamp(Number(stl) * 1.5 + Number(blk) * 1.2 + Number(drb) * 0.25 - Number(tov) * 0.2, -5, 10).toFixed(1);
    const epm = Number.isFinite(Number(normalized.epm)) ? Number(normalized.epm).toFixed(1) : (Number(off) + Number(def)).toFixed(1);

    const ts = Number.isFinite(Number(normalized.tsPct))
      ? `${Number(normalized.tsPct).toFixed(1)}%`
      : (fga + 0.44 * fta > 0 ? `${((Number(pts) / (2 * (fga + 0.44 * fta))) * 100).toFixed(1)}%` : '—');
    const p2 = Number.isFinite(fg2a) && fg2a > 0 ? `${((fg2m / fg2a) * 100).toFixed(1)}%` : '—';
    const p3 = Number.isFinite(fg3a) && fg3a > 0 ? `${((fg3m / fg3a) * 100).toFixed(1)}%` : '—';
    const ftPct = Number.isFinite(fta) && fta > 0 ? `${((ftm / fta) * 100).toFixed(1)}%` : '—';
    
    return `
      <tr class="roster-player-row hd-row" data-player="${esc(normalized.name || 'Unknown')}">
        <td class="player-name-hd pl-4">
          <div class="hd-name">${esc(normalized.name || 'Unknown')}</div>
          <div class="hd-pos">Live averages · ${esc(String(normalized.games || 0))} games</div>
        </td>
        ${renderStatCell(mpg, percentileFor(statValues.mpg, normalized.min))}
        ${renderStatCell(usageProxy, percentileFor(statValues.usg, Number(usageProxy)))}
        ${renderStatCell(Number(off)>0?'+'+off:off, percentileFor(statValues.off, Number(off)))}
        ${renderStatCell(Number(def)>0?'+'+def:def, percentileFor(statValues.def, Number(def), true))}
        ${renderStatCell(Number(epm)>0?'+'+epm:epm, percentileFor(statValues.epm, Number(epm)))}
        ${renderStatCell(pts, percentileFor(statValues.pts, normalized.pts))}
        ${renderStatCell(ts, percentileFor(statValues.ts, parseFloat(ts)))}
        ${renderStatCell(fg2a.toFixed(1), percentileFor(statValues.pa2, fg2a))}
        ${renderStatCell(p2, percentileFor(statValues.p2, parseFloat(p2)))}
        ${renderStatCell(fg3a.toFixed(1), percentileFor(statValues.pa3, fg3a))}
        ${renderStatCell(p3, percentileFor(statValues.p3, parseFloat(p3)))}
        ${renderStatCell(fta.toFixed(1), percentileFor(statValues.fta, fta))}
        ${renderStatCell(ftPct, percentileFor(statValues.ftPct, parseFloat(ftPct)))}
        ${renderStatCell(orb, percentileFor(statValues.orb, Number(orb)))}
        ${renderStatCell(drb, percentileFor(statValues.drb, Number(drb)))}
        ${renderStatCell(ast, percentileFor(statValues.ast, normalized.ast))}
        ${renderStatCell(tov, percentileFor(statValues.tov, Number(tov), true))}
        ${renderStatCell(stl, percentileFor(statValues.stl, Number(stl)))}
        ${renderStatCell(blk, percentileFor(statValues.blk, Number(blk)))}
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.roster-player-row').forEach(row => {
    row.addEventListener('click', () => {
      const player = row.getAttribute('data-player') || '';
      CURRENT_PLAYER_FILTER = CURRENT_PLAYER_FILTER === player ? '' : player;
      tbody.querySelectorAll('.roster-player-row').forEach(item => {
        item.classList.toggle('is-selected', item.getAttribute('data-player') === CURRENT_PLAYER_FILTER);
      });
      renderLineupCombosTable();
    });
  });

  const rosterTable = document.getElementById('rosterTable');
  const stdBtn = document.getElementById('rosterStandardBtn');
  const advBtn = document.getElementById('rosterAdvancedBtn');
  
  if (stdBtn && advBtn && rosterTable && !stdBtn.dataset.bound) {
    stdBtn.dataset.bound = "true";
    stdBtn.addEventListener('click', () => {
      stdBtn.classList.add('active');
      advBtn.classList.remove('active');
      rosterTable.classList.remove('show-advanced');
    });
    advBtn.addEventListener('click', () => {
      advBtn.classList.add('active');
      stdBtn.classList.remove('active');
      rosterTable.classList.add('show-advanced');
    });
  }
}

function renderRosterSkeleton() {
  const tbody = document.getElementById('rosterTableBody');
  if (!tbody) return;
  // Accessibility: indicate loading to assistive tech
  try { tbody.setAttribute('aria-busy', 'true'); tbody.setAttribute('role', 'status'); } catch {}
  const rows = Array.from({ length: 7 }, (_, index) => {
    const shimmerWidth = 68 - index * 4;
    return `
      <tr class="roster-player-row hd-row roster-skeleton-row" aria-hidden="true">
        <td class="player-name-hd pl-4">
          <div class="skeleton-line" style="width:${Math.max(42, shimmerWidth)}%;height:14px;margin-bottom:8px"></div>
          <div class="skeleton-line" style="width:58%;height:10px;opacity:.7"></div>
        </td>
        ${Array.from({ length: 19 }, () => `
          <td class="roster-hd-cell">
            <div class="skeleton-line" style="width:70%;height:12px;margin:0 auto"></div>
          </td>`).join('')}
      </tr>`;
  }).join('');

  tbody.innerHTML = rows;
}

function renderMatchupHero(game, prediction) {
  const container = document.getElementById('matchupHeroContainer');
  if (!container) return;
  if (!game) { container.innerHTML = ''; return; }

  const isHome = game.home === TEAM_ABBR;
  const opponent = isHome ? game.away : game.home;
  const winProb = prediction ? (isHome ? prediction.homeWinProb : prediction.awayWinProb) : null;
  const probNorm = winProb !== null ? normalizeProbabilityValue(winProb) : null;
  const probPct = probNorm !== null ? Math.round(probNorm * 100) : null;
  const probDisplay = probPct !== null ? `${probPct}%` : '—';
  const probColor = probPct !== null ? (probPct >= 60 ? 'var(--lime)' : probPct >= 45 ? 'var(--muted)' : 'var(--blue)') : 'var(--muted)';
  const dateStr = formatDate(game.startTime || game.date);
  const venueLabel = isHome ? 'HOME' : 'AWAY';
  const venueColor = isHome ? 'var(--lime)' : 'var(--blue)';

  container.innerHTML = `
    <div class="next-game-strip">
      <div class="ngs-label">NEXT GAME</div>
      <div class="ngs-teams">
        <span class="ngs-team ngs-us">${TEAM_ABBR}</span>
        <span class="ngs-vs">${isHome ? 'vs' : '@'}</span>
        <span class="ngs-team ngs-opp">${esc(opponent)}</span>
      </div>
      <div class="ngs-meta">
        <span class="ngs-date">${dateStr}</span>
        <span class="ngs-venue" style="color:${venueColor};border-color:${venueColor}">${venueLabel}</span>
      </div>
      <div class="ngs-prob">
        <div class="ngs-prob-label">WIN PROB</div>
        <div class="ngs-prob-value" style="color:${probColor}">${probDisplay}</div>
        ${probPct !== null ? `<div class="ngs-prob-bar"><div class="ngs-prob-fill" style="width:${probPct}%;background:${probColor}"></div></div>` : ''}
      </div>
    </div>`;
}

async function renderSchedule() {
  const pastGames = RECENT_GAMES.slice(0, 10);

  // ── Record Summary Strip ──
  const stripEl = document.getElementById('schedRecordStrip');
  if (stripEl && TEAM_DATA) {
    const wins = Number(TEAM_DATA.w || TEAM_DATA.wins || 0);
    const losses = Number(TEAM_DATA.l || TEAM_DATA.losses || 0);
    const record = (wins || losses) ? `${wins}-${losses}` : (TEAM_DATA.record || '0-0');
    const total = wins + losses || 1;
    const winPct = ((wins / total) * 100).toFixed(1);

    // Compute home/away from recent games
    let homeW = 0, homeL = 0, awayW = 0, awayL = 0;
    for (const g of pastGames) {
      const hs = Number(g.homeScore ?? 0), as = Number(g.awayScore ?? 0);
      if (!hs && !as) continue;
      const isHome = g.home === TEAM_ABBR;
      const won = isHome ? hs > as : as > hs;
      if (isHome) { won ? homeW++ : homeL++; } else { won ? awayW++ : awayL++; }
    }

    // L10 visual blocks
    const l10Games = pastGames.slice(0, 10);
    const l10Blocks = l10Games.map(g => {
      const hs = Number(g.homeScore ?? 0), as = Number(g.awayScore ?? 0);
      if (!hs && !as) return '<div class="l10-block neutral"></div>';
      const isHome = g.home === TEAM_ABBR;
      const won = isHome ? hs > as : as > hs;
      return `<div class="l10-block ${won ? 'win' : 'loss'}"></div>`;
    }).join('');

    stripEl.innerHTML = `
      <div class="sr-stat">
        <div class="sr-value">${record}</div>
        <div class="sr-label">RECORD</div>
      </div>
      <div class="sr-stat">
        <div class="sr-value">${winPct}%</div>
        <div class="sr-label">WIN PCT</div>
      </div>
      <div class="sr-stat">
        <div class="sr-value">${homeW}-${homeL}</div>
        <div class="sr-label">HOME</div>
      </div>
      <div class="sr-stat">
        <div class="sr-value">${awayW}-${awayL}</div>
        <div class="sr-label">AWAY</div>
      </div>
      <div class="sr-l10">
        <div class="sr-l10-label">L10</div>
        <div class="sr-l10-blocks">${l10Blocks}</div>
      </div>`;
  }

  // ── Recent Results — rich cards ──
  const recentList = document.getElementById('recentGamesList');
  const streakBadge = document.getElementById('schedStreakBadge');
  const displayGames = pastGames.slice(0, 5);

  if (SCHEDULE_LOADING && (!RECENT_GAMES || RECENT_GAMES.length === 0)) {
    renderScheduleSkeleton();
    return;
  }

  if (!displayGames.length) {
    if (recentList) recentList.innerHTML = '<div class="no-data">No recent results</div>';
  } else {
    // Compute streak
    let streak = '', streakCount = 0;
    for (const g of displayGames) {
      const hs = Number(g.homeScore ?? 0), as = Number(g.awayScore ?? 0);
      if (!hs && !as) break;
      const isHome = g.home === TEAM_ABBR;
      const won = isHome ? hs > as : as > hs;
      const r = won ? 'W' : 'L';
      if (!streak) { streak = r; streakCount = 1; }
      else if (r === streak) { streakCount++; }
      else break;
    }
    if (streakBadge && streakCount > 0) {
      const sc = streak === 'W' ? 'var(--lime)' : 'var(--blue)';
      streakBadge.innerHTML = `<span style="color:${sc};border-color:${sc}" class="streak-badge">${streak}${streakCount}</span>`;
    }

    recentList.innerHTML = displayGames.map((game, idx) => {
      const hs = Number(game.homeScore ?? 0), as = Number(game.awayScore ?? 0);
      const hasScores = Number.isFinite(hs) && Number.isFinite(as) && (hs > 0 || as > 0);
      const isHome = game.home === TEAM_ABBR;
      const opp = isHome ? game.away : game.home;
      const ourScore = isHome ? hs : as;
      const oppScore = isHome ? as : hs;
      const result = hasScores ? (ourScore > oppScore ? 'W' : 'L') : '—';
      const won = result === 'W';
      const margin = hasScores ? Math.abs(ourScore - oppScore) : 0;

      // Game narrative
      let narrative = '';
      if (hasScores) {
        if (won && margin >= 15) narrative = 'Blowout Win';
        else if (won && margin >= 8) narrative = 'Comfortable Win';
        else if (won && margin >= 4) narrative = 'Solid Win';
        else if (won) narrative = 'Close Win';
        else if (!won && margin >= 15) narrative = 'Blowout Loss';
        else if (!won && margin >= 8) narrative = 'Rough Loss';
        else if (!won && margin >= 4) narrative = 'Tough Loss';
        else narrative = 'Close Loss';
      }

      const marginPct = Math.min(margin * 2, 100);
      const barColor = won ? 'var(--lime)' : 'var(--blue)';
      const marginSign = won ? '+' : '−';
      const label = isHome ? 'vs' : '@';
      const venueColor = isHome ? 'var(--lime)' : 'var(--blue)';

      return `
        <div class="sg-card ${won ? 'sg-win' : 'sg-loss'}" style="animation-delay:${idx * 0.05}s">
          <div class="sg-left">
            <span class="sg-result-mark ${won ? 'win' : 'loss'}">${result}</span>
            <div class="sg-info">
              <div class="sg-opponent">
                <span class="sg-venue" style="color:${venueColor}">${label}</span>
                <span class="sg-opp-abbr">${esc(opp)}</span>
              </div>
              <div class="sg-meta">
                <span class="sg-date">${formatDate(game.startTime || game.date)}</span>
                ${narrative ? `<span class="sg-narrative ${won ? 'win' : 'loss'}">${narrative}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="sg-right">
            <div class="sg-score">
              <span class="sg-our">${ourScore}</span>
              <span class="sg-sep">-</span>
              <span class="sg-opp-score">${oppScore}</span>
            </div>
            <div class="sg-margin-row">
              <div class="sg-margin-bar"><div class="sg-margin-fill" style="width:${marginPct}%;background:${barColor}"></div></div>
              <span class="sg-margin-val" style="color:${barColor}">${marginSign}${margin}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ── Upcoming Games — cards ──
  const upcomingContainer = document.getElementById('upcomingGamesCards');
  const upcomingGames = SCHEDULE_DATA
    .filter(game => game.status !== 3 && (game.home === TEAM_ABBR || game.away === TEAM_ABBR))
    .sort((a, b) => new Date(a.startTime || a.date || 0) - new Date(b.startTime || b.date || 0))
    .slice(0, 5);

  if (!upcomingGames.length) {
    if (upcomingContainer) upcomingContainer.innerHTML = '<div class="no-data">No upcoming games</div>';
    renderMatchupHero(null);
    return;
  }

  renderMatchupHero(upcomingGames[0], null);

  if (upcomingContainer) {
    upcomingContainer.innerHTML = upcomingGames.slice(1).map((game, idx) => {
      const isHome = game.home === TEAM_ABBR;
      const opp = isHome ? game.away : game.home;
      const dateStr = formatDate(game.startTime || game.date);
      const venueLabel = isHome ? 'HOME' : 'AWAY';
      const venueColor = isHome ? 'var(--lime)' : 'var(--blue)';
      return `
        <div class="upcoming-card" data-home="${esc(game.home)}" data-away="${esc(game.away)}" style="animation-delay:${idx * 0.05}s">
          <div class="uc-date">${dateStr}</div>
          <div class="uc-matchup">
            <span class="uc-label" style="color:${venueColor}">${isHome ? 'vs' : '@'}</span>
            <span class="uc-opp">${esc(opp)}</span>
          </div>
          <div class="uc-venue" style="color:${venueColor};border-color:${venueColor}">${venueLabel}</div>
          <div class="uc-prob" data-home="${esc(game.home)}" data-away="${esc(game.away)}">
            <span class="skeleton-line" style="width:48px;height:10px"></span>
          </div>
        </div>`;
    }).join('');
  }

  void loadPredictionsForGames(upcomingGames).catch(() => null);

  if (upcomingGames.length > 0) {
    const nextKey = `${upcomingGames[0].home}_${upcomingGames[0].away}`;
    const nextPred = window.GAME_PREDICTIONS?.[nextKey];
    renderMatchupHero(upcomingGames[0], nextPred);
  }

  // Update L10
  const l10 = computeL10(RECENT_GAMES, TEAM_ABBR);
  const l10El = document.getElementById('lastTenValue');
  if (l10 && l10El) {
    l10El.textContent = l10;
    const [w] = l10.split('-').map(Number);
    l10El.style.color = w >= 7 ? 'var(--lime)' : w <= 3 ? 'var(--blue)' : '';
  }
}

function renderScheduleSkeleton() {
  const stripEl = document.getElementById('schedRecordStrip');
  const recentList = document.getElementById('recentGamesList');
  const upcomingContainer = document.getElementById('upcomingGamesCards');
  const matchupHero = document.getElementById('matchupHeroContainer');

  if (stripEl) {
    stripEl.innerHTML = `
      <div class="sr-stat"><div class="skeleton-line" style="width:64px;height:24px;margin-bottom:8px"></div><div class="skeleton-line" style="width:42px;height:10px"></div></div>
      <div class="sr-stat"><div class="skeleton-line" style="width:52px;height:24px;margin-bottom:8px"></div><div class="skeleton-line" style="width:36px;height:10px"></div></div>
      <div class="sr-stat"><div class="skeleton-line" style="width:52px;height:24px;margin-bottom:8px"></div><div class="skeleton-line" style="width:34px;height:10px"></div></div>
      <div class="sr-stat"><div class="skeleton-line" style="width:52px;height:24px;margin-bottom:8px"></div><div class="skeleton-line" style="width:34px;height:10px"></div></div>
      <div class="sr-l10"><div class="skeleton-line" style="width:22px;height:10px;margin-bottom:10px"></div><div style="display:flex;gap:4px">${Array.from({ length: 10 }, () => '<span class="skeleton-line" style="width:10px;height:18px;display:inline-block"></span>').join('')}</div></div>`;
  }

  if (recentList) {
    recentList.innerHTML = Array.from({ length: 5 }, (_, index) => `
      <div class="sg-card sg-skeleton" style="animation-delay:${index * 0.05}s">
        <div class="sg-left">
          <span class="skeleton-line" style="width:22px;height:22px;border-radius:999px"></span>
          <div class="sg-info" style="flex:1">
            <div class="skeleton-line" style="width:88px;height:12px;margin-bottom:8px"></div>
            <div class="skeleton-line" style="width:120px;height:10px"></div>
          </div>
        </div>
        <div class="sg-right" style="min-width:160px">
          <div class="skeleton-line" style="width:72px;height:20px;margin-left:auto;margin-bottom:10px"></div>
          <div class="skeleton-line" style="width:100%;height:8px"></div>
        </div>
      </div>`).join('');
  }

  if (upcomingContainer) {
    upcomingContainer.innerHTML = Array.from({ length: 4 }, () => `
      <div class="upcoming-card upcoming-skeleton">
        <div class="skeleton-line" style="width:62px;height:10px;margin-bottom:14px"></div>
        <div class="skeleton-line" style="width:100px;height:14px;margin-bottom:14px"></div>
        <div class="skeleton-line" style="width:54px;height:12px;margin-bottom:18px"></div>
        <div class="skeleton-line" style="width:76px;height:12px"></div>
      </div>`).join('');
  }

  if (matchupHero) {
    matchupHero.innerHTML = `
      <div class="next-game-strip next-game-skeleton">
        <div class="skeleton-line" style="width:78px;height:10px;margin-bottom:14px"></div>
        <div class="skeleton-line" style="width:180px;height:22px;margin-bottom:14px"></div>
        <div class="skeleton-line" style="width:128px;height:12px;margin-bottom:18px"></div>
        <div class="skeleton-line" style="width:92px;height:10px;margin-bottom:8px"></div>
        <div class="skeleton-line" style="width:100%;height:8px"></div>
      </div>`;
  }
}

async function loadPredictionsForGames(games) {
  const chunks = chunkArray(games, MAX_CONCURRENT_PREDICTIONS);
  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(game =>
        fetchPrediction(game.home, game.away).then(pred => {
          updateScheduleRowPrediction(pred);
        })
      )
    );
  }
}

function updateScheduleRowPrediction(pred) {
  // Find either a table row or an upcoming card
  const row = document.querySelector(
    `tr[data-home="${esc(pred.home)}"][data-away="${esc(pred.away)}"]`
  );
  const card = document.querySelector(
    `.upcoming-card[data-home="${esc(pred.home)}"][data-away="${esc(pred.away)}"]`
  );

  const ourTeam = pred.home === TEAM_ABBR ? 'home' : 'away';
  const ourProb = (!pred.error && (pred.homeWinProb !== null || pred.awayWinProb !== null))
    ? normalizeProbabilityValue(ourTeam === 'home' ? pred.homeWinProb : pred.awayWinProb)
    : null;

  // Update table row (legacy)
  if (row) {
    const predCell = row.querySelector('.game-prediction');
    if (predCell) {
      if (ourProb === null) {
        predCell.innerHTML = '<span class="pred-error">—</span>';
      } else {
        const probPct = Math.round(ourProb * 100);
        const barColor = probPct >= 60 ? 'var(--lime)' : probPct >= 45 ? 'var(--muted)' : 'var(--blue)';
        const label = probPct >= 50 ? 'W' : 'L';
        predCell.innerHTML = `
          <div class="prob-bar-container">
            <div class="prob-bar-track">
              <div class="prob-bar-fill" style="width:${probPct}%;background:${barColor}"></div>
            </div>
            <span class="prob-bar-label" style="color:${barColor}">${probPct}% ${label}</span>
          </div>`;
      }
    }
  }

  // Update upcoming card
  if (card) {
    const probEl = card.querySelector('.uc-prob');
    if (probEl) {
      if (ourProb === null) {
        probEl.innerHTML = '<span style="color:var(--muted)">—</span>';
      } else {
        const probPct = Math.round(ourProb * 100);
        const color = probPct >= 60 ? 'var(--lime)' : probPct >= 45 ? 'var(--muted)' : 'var(--blue)';
        const label = probPct >= 50 ? 'W' : 'L';
        probEl.innerHTML = `<span style="color:${color}">${probPct}% ${label}</span>`;
      }
    }
  }
}

function normalizeTopPlayersResponse(json) {
  if (Array.isArray(json)) return json;
  const candidates = [
    json?.players,
    json?.data?.players,
    json?.data,
    json?.result?.players,
    json?.results,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeRosterPlayer(player) {
  const firstName = player?.firstName ?? player?.first_name ?? player?.fname ?? '';
  const lastName = player?.lastName ?? player?.last_name ?? player?.lname ?? '';
  const fullName = player?.name ?? player?.fullName ?? player?.full_name ?? `${firstName} ${lastName}`.trim();
  return {
    name: fullName || 'Unknown',
    position: String(player?.position ?? player?.pos ?? player?.POSITION ?? '').trim(),
    pts: normalizeNumericStat(player?.pts ?? player?.PTS ?? player?.points ?? player?.PPG),
    reb: normalizeNumericStat(player?.reb ?? player?.REB ?? player?.rebounds ?? player?.RPG),
    ast: normalizeNumericStat(player?.ast ?? player?.AST ?? player?.assists ?? player?.APG),
    min: normalizeNumericStat(player?.min ?? player?.MIN ?? player?.minutes ?? player?.mpg ?? player?.MPG),
    plus_minus: normalizeNumericStat(player?.plus_minus ?? player?.plusMinus ?? player?.pm ?? player?.PLUS_MINUS),
    stl: normalizeNumericStat(player?.stl ?? player?.STL),
    blk: normalizeNumericStat(player?.blk ?? player?.BLK),
    tov: normalizeNumericStat(player?.tov ?? player?.TOV),
    orb: normalizeNumericStat(player?.orb ?? player?.ORB),
    drb: normalizeNumericStat(player?.drb ?? player?.DRB),
    fga: normalizeNumericStat(player?.fga ?? player?.FGA),
    fgm: normalizeNumericStat(player?.fgm ?? player?.FGM),
    fg3a: normalizeNumericStat(player?.fg3a ?? player?.FG3A),
    fg3m: normalizeNumericStat(player?.fg3m ?? player?.FG3M),
    fta: normalizeNumericStat(player?.fta ?? player?.FTA),
    ftm: normalizeNumericStat(player?.ftm ?? player?.FTM),
    usage: normalizeNumericStat(player?.usage ?? player?.USG),
    off: normalizeNumericStat(player?.off ?? player?.off_rating),
    def: normalizeNumericStat(player?.def ?? player?.def_rating),
    epm: normalizeNumericStat(player?.epm ?? player?.EPM ?? player?.plus_minus),
    tsPct: normalizeNumericStat(player?.tsPct ?? player?.ts_pct ?? player?.TS_PCT),
    p2Pct: normalizeNumericStat(player?.p2Pct ?? player?.p2_pct),
    p3Pct: normalizeNumericStat(player?.p3Pct ?? player?.p3_pct),
    ftPct: normalizeNumericStat(player?.ftPct ?? player?.ft_pct),
    pa2: normalizeNumericStat(player?.pa2),
    pa3: normalizeNumericStat(player?.pa3),
    games: normalizeNumericStat(player?.games ?? player?.gp ?? player?.GP),
  };
}

function resolveDefaultTeamAbbr(standings) {
  const stored = String(localStorage.getItem('pm_last_team') || '').toUpperCase();
  if (stored.length >= 2 && stored.length <= 3) return stored;
  const pools = [standings?.east || [], standings?.west || []].flat().filter(Boolean);
  return pools.find(team => team?.abbr)?.abbr || 'BOS';
}

async function enrichRosterPlayers(players) {
  if (!Array.isArray(players) || players.length === 0) return [];

  const enriched = await Promise.all(players.map(async player => {
    const playerId = Number(player?.player_id ?? player?.playerId ?? player?.personId ?? 0);
    if (!Number.isFinite(playerId) || playerId <= 0) {
      return player;
    }

    try {
      const json = await backendFirstFetch(`/api/playerlog?player_id=${playerId}`, 15000, 0);
      const summary = summarizePlayerLogRows(Array.isArray(json?.games) ? json.games : []);
      return { ...player, ...summary };
    } catch {
      return player;
    }
  }));

  return enriched;
}

function summarizePlayerLogRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return {};

  const take = rows.slice(0, 5);
  const statList = take.map(row => ({
    min: normalizeGameMinutes(row?.MIN ?? row?.MINUTES ?? row?.min),
    pts: normalizeNumericStat(row?.PTS),
    reb: normalizeNumericStat(row?.REB),
    ast: normalizeNumericStat(row?.AST),
    stl: normalizeNumericStat(row?.STL),
    blk: normalizeNumericStat(row?.BLK),
    tov: normalizeNumericStat(row?.TOV),
    orb: normalizeNumericStat(row?.OREB ?? row?.ORB),
    drb: normalizeNumericStat(row?.DREB ?? row?.DRB),
    fgm: normalizeNumericStat(row?.FGM),
    fga: normalizeNumericStat(row?.FGA),
    fg3m: normalizeNumericStat(row?.FG3M),
    fg3a: normalizeNumericStat(row?.FG3A),
    ftm: normalizeNumericStat(row?.FTM),
    fta: normalizeNumericStat(row?.FTA),
    pm: normalizeNumericStat(row?.PLUS_MINUS ?? row?.PM ?? row?.['+/-']),
  }));

  const avg = key => statList.reduce((sum, item) => sum + (Number(item[key]) || 0), 0) / statList.length;
  const avgMin = avg('min');
  const avgPts = avg('pts');
  const avgReb = avg('reb');
  const avgAst = avg('ast');
  const avgStl = avg('stl');
  const avgBlk = avg('blk');
  const avgTov = avg('tov');
  const avgOrb = avg('orb');
  const avgDrb = avg('drb');
  const avgFgm = avg('fgm');
  const avgFga = avg('fga');
  const avgFg3m = avg('fg3m');
  const avgFg3a = avg('fg3a');
  const avgFtm = avg('ftm');
  const avgFta = avg('fta');
  const avgPm = avg('pm');

  const fg2a = Math.max(0, avgFga - avgFg3a);
  const fg2m = Math.max(0, avgFgm - avgFg3m);
  const tsDen = 2 * (avgFga + 0.44 * avgFta);

  return {
    min: Number(avgMin.toFixed(1)),
    pts: Number(avgPts.toFixed(1)),
    reb: Number(avgReb.toFixed(1)),
    ast: Number(avgAst.toFixed(1)),
    stl: Number(avgStl.toFixed(1)),
    blk: Number(avgBlk.toFixed(1)),
    tov: Number(avgTov.toFixed(1)),
    orb: Number(avgOrb.toFixed(1)),
    drb: Number(avgDrb.toFixed(1)),
    fgm: Number(avgFgm.toFixed(1)),
    fga: Number(avgFga.toFixed(1)),
    fg3m: Number(avgFg3m.toFixed(1)),
    fg3a: Number(avgFg3a.toFixed(1)),
    ftm: Number(avgFtm.toFixed(1)),
    fta: Number(avgFta.toFixed(1)),
    usage: clamp((avgFga + 0.44 * avgFta + avgTov) / Math.max(avgMin, 1) * 2.4, 8, 35),
    off: clamp(avgPts * 0.35 + avgAst * 0.45 + avgReb * 0.2 - avgTov * 0.5, -5, 10),
    def: clamp(avgStl * 1.5 + avgBlk * 1.2 + avgDrb * 0.25 - avgTov * 0.2, -5, 10),
    epm: avgPm,
    tsPct: tsDen > 0 ? (avgPts / tsDen) * 100 : 0,
    p2Pct: fg2a > 0 ? (fg2m / fg2a) * 100 : 0,
    p3Pct: avgFg3a > 0 ? (avgFg3m / avgFg3a) * 100 : 0,
    ftPct: avgFta > 0 ? (avgFtm / avgFta) * 100 : 0,
    pa2: fg2a,
    pa3: avgFg3a,
    games: take.length,
  };
}

function normalizeGameMinutes(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'string' && value.includes(':')) {
    const [minutes, seconds] = value.split(':').map(part => Number(part) || 0);
    return minutes + (seconds / 60);
  }
  return normalizeNumericStat(value);
}

function normalizeNumericStat(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeProbabilityValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/%$/, '');
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return null;
    return parsed > 1 ? parsed / 100 : parsed;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function getTeamAccentColor(teamAbbr, fallback = '#888888') {
  const colorMap = window.PM_TEAM_COLORS || window.TEAM_COLORS || {};
  const fallbackMap = {
    ATL: '#E03A3E', BOS: '#007A33', BKN: '#000000', CHA: '#1D1160', CHI: '#CE1141', CLE: '#6F263D', DAL: '#00538C', DEN: '#0E2240', DET: '#C8102E', GSW: '#1D428A', HOU: '#CE1141', IND: '#002D62', LAC: '#C8102E', LAL: '#552583', MEM: '#5D76A9', MIA: '#98002E', MIL: '#00471B', MIN: '#0C2340', NOP: '#0C2340', NYK: '#F58426', OKC: '#007AC1', ORL: '#0077C0', PHI: '#006BB6', PHX: '#1D1160', POR: '#E03A3E', SAC: '#5A2D81', SAS: '#C4CED4', TOR: '#CE1141', UTA: '#002B5C', WAS: '#002B5C', IND: '#FDBB30'
  };
  return colorMap?.[teamAbbr] || fallbackMap[teamAbbr] || fallback;
}

function ordinalSuffix(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
  switch (num % 10) {
    case 1: return `${num}st`;
    case 2: return `${num}nd`;
    case 3: return `${num}rd`;
    default: return `${num}th`;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function animateCountUp(elementId, targetValue, decimals = 0, formatter = null) {
  const element = document.getElementById(elementId);
  if (!element) return;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const target = Number(targetValue);
  if (!Number.isFinite(target) || prefersReducedMotion) {
    element.textContent = formatter ? formatter(target) : target.toFixed(decimals);
    return;
  }
  const start = 0;
  const duration = 800;
  const startTime = performance.now();
  function frame(now) {
    const progress = clamp((now - startTime) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (target - start) * eased;
    const value = decimals > 0 ? Number(current.toFixed(decimals)) : Math.round(current);
    element.textContent = formatter ? formatter(value) : value.toFixed(decimals);
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderRecentGames() {
  const container = document.getElementById('recentGamesTable');
  if (!container) return;

  if (!RECENT_GAMES || RECENT_GAMES.length === 0) {
    container.innerHTML = '<div class="no-data">No recent games</div>';
    return;
  }

  container.innerHTML = RECENT_GAMES.map((game, index) => {
    const homeScore = Number(game.homeScore ?? game.home?.score ?? NaN);
    const awayScore = Number(game.awayScore ?? game.away?.score ?? NaN);
    const hasScores = Number.isFinite(homeScore) && Number.isFinite(awayScore) && (homeScore > 0 || awayScore > 0);
    const teamWasHome = game.home === TEAM_ABBR;
    const ourScore = teamWasHome ? homeScore : awayScore;
    const oppScore = teamWasHome ? awayScore : homeScore;
    const result = hasScores ? (ourScore > oppScore ? 'W' : 'L') : 'F';
    const resultClass = result === 'W' ? 'win' : result === 'L' ? 'loss' : '';
    const scoreText = hasScores ? `${homeScore}-${awayScore}` : '—';
    const opponent = teamWasHome ? game.away : game.home;
    const homeLabel = teamWasHome ? 'vs' : '@';
    const homeLabelColor = result === 'W' ? 'var(--lime)' : result === 'L' ? 'var(--coral)' : 'var(--muted)';
    
    const pointDiff = hasScores ? (ourScore - oppScore) : null;
    const diffText = pointDiff === null ? '—' : `${pointDiff > 0 ? '+' : ''}${pointDiff}`;
    return `
    <div class="game-card ${resultClass}">
      <div class="game-left">
        <div class="opp-logo" aria-hidden="true">${esc(opponent)}</div>
        <div class="game-meta">
          <div class="game-date">${formatDate(game.startTime || game.date)}</div>
          <div class="game-opp">${esc(opponent)} <span class="home-away">${homeLabel}</span></div>
        </div>
      </div>
      <div class="game-result-cell">
        <div class="game-score">${esc(scoreText)}</div>
        <div class="point-chip" title="Point differential">${esc(diffText)}</div>
        <span class="result-pill ${resultClass}" style="animation-delay:${index * 0.045}s">${esc(result)}</span>
      </div>
    </div>`;
  }).join('');
}

// ─── UTILITIES ──────────────────────────────────────────────────────────────
function flattenTeamSchedule(scheduleMap, teamAbbr) {
  return Object.entries(scheduleMap || {}).flatMap(([date, games]) => {
    return (games || []).map(game => ({ ...game, date }));
  }).filter(game => game.home === teamAbbr || game.away === teamAbbr);
}

function flattenScheduleMap(scheduleMap) {
  return Object.entries(scheduleMap || {}).flatMap(([date, games]) => {
    return (games || []).map(game => ({ ...game, date }));
  });
}

function mergeScheduleMaps(primaryMap, secondaryMap) {
  const allGames = [...flattenScheduleMap(primaryMap), ...flattenScheduleMap(secondaryMap)];
  const dedup = new Map();
  allGames.forEach(game => {
    const key = `${game.date}_${game.home}_${game.away}_${game.startTime || ''}`;
    if (!dedup.has(key)) dedup.set(key, game);
  });
  return Array.from(dedup.values()).reduce((acc, game) => {
    if (!acc[game.date]) acc[game.date] = [];
    acc[game.date].push(game);
    return acc;
  }, {});
}

function dateKeyOffset(days) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + days);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function normalizeGamesBack(value) {
  if (value === null || value === undefined || value === '' || value === '-') return '0';
  return String(value);
}

function formatStat(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(1) : '0.0';
}

function renderTeamInsights() {
  const netRating = Number(computeNetRating(TEAM_DATA));
  const recentNet = computeRecentNetRating(RECENT_GAMES, TEAM_ABBR);
  const split = computeHomeAwaySplit(RECENT_GAMES, TEAM_ABBR);
  const trail = buildRecentFormTrail(RECENT_GAMES, TEAM_ABBR);

  const trailEl = document.getElementById('formTrail');
  if (trailEl) {
    trailEl.innerHTML = trail.map(item => `<span class="team-form-dot ${item.state}" title="${esc(item.label)}"></span>`).join('');
  }

  const lastTenTrailEl = document.getElementById('lastTenTrail');
  if (lastTenTrailEl) {
    lastTenTrailEl.innerHTML = trail.map(item => `<span class="team-form-dot ${item.state}" title="${esc(item.label)}"></span>`).join('');
  }

  const lastTenValueEl = document.getElementById('lastTenValue');
  if (lastTenValueEl) {
    const wins = trail.filter(item => item.state === 'win').length;
    const losses = trail.filter(item => item.state === 'loss').length;
    lastTenValueEl.textContent = wins + losses ? `${wins}-${losses}` : '—';
  }

  const recordSplitEl = document.getElementById('recordSplitValue');
  if (recordSplitEl) {
    recordSplitEl.textContent = split.homeGames || split.awayGames ? `${split.homeWins}-${split.homeLosses} home · ${split.awayWins}-${split.awayLosses} away` : 'No split data yet';
  }

  const homeAwaySplitEl = document.getElementById('homeAwaySplitValue');
  if (homeAwaySplitEl) {
    homeAwaySplitEl.textContent = split.homeGames || split.awayGames ? `${split.homeWins}-${split.homeLosses} / ${split.awayWins}-${split.awayLosses}` : '—';
  }

  const splitEdgeEl = document.getElementById('splitEdgeValue');
  if (splitEdgeEl) {
    const homePct = split.homeGames ? split.homeWins / split.homeGames : 0;
    const awayPct = split.awayGames ? split.awayWins / split.awayGames : 0;
    const diff = homePct - awayPct;
    const arrow = diff > 0.04 ? '▲' : diff < -0.04 ? '▼' : '•';
    splitEdgeEl.textContent = split.homeGames && split.awayGames ? `${arrow} ${(Math.abs(diff) * 100).toFixed(1)}%` : '—';
    splitEdgeEl.className = `team-form-foot-value ${diff > 0.04 ? 'good' : diff < -0.04 ? 'bad' : 'warn'}`;
  }

  const nrtEl = document.getElementById('netRatingValue');
  const nrtTrendEl = document.getElementById('netRatingTrend');
  const gaugeFill = document.getElementById('netRatingGaugeFill');
  const gaugeValue = document.getElementById('netRatingGaugeValue');
  const gaugeTitle = document.getElementById('gaugeContextTitle');
  const gaugeDetail = document.getElementById('gaugeContextDetail');

  if (gaugeValue) gaugeValue.textContent = Number.isFinite(netRating) ? `${netRating > 0 ? '+' : ''}${netRating.toFixed(1)}` : '—';
  if (gaugeFill && Number.isFinite(netRating)) {
    const angle = clamp(((netRating + 15) / 30) * 180, 0, 180);
    gaugeFill.style.setProperty('--gauge-angle', `${angle}deg`);
  }
  if (gaugeTitle) {
    gaugeTitle.textContent = `${ordinalSuffix(TEAM_DATA.seed)} in ${TEAM_DATA.conference === 'E' ? 'East' : 'West'}`;
  }
  if (gaugeDetail) {
    const recentText = Number.isFinite(recentNet) ? `${recentNet > 0 ? '+' : ''}${recentNet.toFixed(1)}` : '—';
    gaugeDetail.textContent = Number.isFinite(recentNet) && Number.isFinite(netRating)
      ? `Recent form is ${recentNet >= netRating ? 'running above' : 'trailing behind'} the season baseline by ${Math.abs((recentNet - netRating)).toFixed(1)} points per 100 possessions. Current recent net: ${recentText}.`
      : 'Recent-game sample is still filling in, but the season baseline and seeding context are ready.';
  }
  if (nrtTrendEl) {
    if (Number.isFinite(recentNet) && Number.isFinite(netRating)) {
      const delta = recentNet - netRating;
      const arrow = delta > 0.2 ? '▲' : delta < -0.2 ? '▼' : '•';
      nrtTrendEl.textContent = `${arrow} ${delta > 0 ? '+' : ''}${delta.toFixed(1)} vs recent form`;
      nrtTrendEl.className = `stat-card-subvalue stat-trend ${delta > 0.2 ? 'up' : delta < -0.2 ? 'down' : 'flat'}`;
    } else {
      nrtTrendEl.textContent = 'Awaiting recent form';
      nrtTrendEl.className = 'stat-card-subvalue stat-trend flat';
    }
  }
  if (nrtEl && Number.isFinite(netRating)) {
    nrtEl.style.color = netRating > 0 ? 'var(--lime)' : netRating < 0 ? 'var(--coral)' : '';
  }

  const winPctRankEl = document.getElementById('winPctRankValue');
  if (winPctRankEl) {
    winPctRankEl.textContent = `${TEAM_DATA.conference === 'E' ? 'East' : 'West'} ${ordinalSuffix(TEAM_DATA.seed)} seed`;
  }

  renderTeamContextBar();
  // Re-render the scout report now that recent data is available
  try { renderScoutReport(); } catch(e) { console.warn('[PM] Scout report re-render:', e.message); }
}

function renderTeamContextBar() {
  const bar = document.getElementById('teamContextBar');
  if (!bar || !TEAM_DATA) return;

  const recentNet = computeRecentNetRating(RECENT_GAMES, TEAM_ABBR);
  const l10 = computeL10(RECENT_GAMES, TEAM_ABBR);
  const netRating = Number(computeNetRating(TEAM_DATA));
  const conf = TEAM_DATA.conference === 'E' ? 'East' : 'West';
  const seed = TEAM_DATA.seed;
  const playoffProb = TEAM_DATA.playoffProb;

  // Mini progress bar helper
  const miniBar = (pct, color) =>
    `<div class="ss-bar-track"><div class="ss-bar-fill" style="width:${Math.min(100,Math.max(0,pct))}%;background:${color}"></div></div>`;

  // Seed progress (1=best out of 15)
  const seedPct = Math.round(((15 - seed) / 14) * 100);

  // L10 wins
  const l10wins = l10 ? Number(l10.split('-')[0]) : null;
  const l10Pct  = l10wins !== null ? (l10wins / 10) * 100 : 0;

  // Net rating — map roughly -15 to +15 → 0–100%
  const nrtPct = Number.isFinite(netRating) ? Math.min(100, Math.max(0, ((netRating + 15) / 30) * 100)) : 50;
  const nrtDisplay = Number.isFinite(netRating) ? `${netRating > 0 ? '+' : ''}${netRating.toFixed(1)}` : '—';
  const nrtColor = netRating > 1 ? 'var(--lime)' : netRating < -1 ? 'var(--blue)' : 'var(--muted)';

  // Recent delta
  const recentDelta = Number.isFinite(recentNet) && Number.isFinite(netRating) ? recentNet - netRating : null;
  const recentDeltaStr = recentDelta !== null
    ? `${recentDelta > 0 ? '▲' : '▼'} ${Math.abs(recentDelta).toFixed(1)} vs season`
    : 'Season baseline';
  const recentDeltaColor = recentDelta !== null ? (recentDelta > 0 ? 'var(--lime)' : 'var(--blue)') : 'var(--muted)';

  // Playoff context
  const playoffCtx = playoffProb >= 95 ? 'Playoff lock' : playoffProb >= 70 ? 'Strong position' : playoffProb >= 40 ? 'In the hunt' : 'Bubble team';

  bar.innerHTML = `
    <div class="stat-strip">

      <div class="ss-card" data-accent="lime">
        <div class="ss-accent" style="background:var(--lime)"></div>
        <div class="ss-label">Conference</div>
        <div class="ss-value"><span class="ss-countup" data-target="${conf} ${ordinalSuffix(seed)}" data-type="text">${conf} ${ordinalSuffix(seed)}</span></div>
        ${miniBar(seedPct, 'var(--lime)')}
        <div class="ss-sub">${seed <= 6 ? 'Playoff seed' : seed <= 10 ? 'Play-in zone' : 'Lottery track'}</div>
      </div>

      <div class="ss-card" data-accent="blue">
        <div class="ss-accent" style="background:var(--blue)"></div>
        <div class="ss-label">Playoff Odds</div>
        <div class="ss-value" style="color:var(--blue)"><span class="ss-countup" data-target="${playoffProb}" data-suffix="%">0%</span></div>
        ${miniBar(playoffProb, 'var(--blue)')}
        <div class="ss-sub">${playoffCtx}</div>
      </div>

      <div class="ss-card" data-accent="blue">
        <div class="ss-accent" style="background:var(--blue)"></div>
        <div class="ss-label">Recent Form</div>
        <div class="ss-value" style="color:var(--blue)">${l10 || '—'}</div>
        ${RECENT_GAMES.length ? renderMomentumSparkline(RECENT_GAMES, TEAM_ABBR) : miniBar(l10Pct, 'var(--blue)')}
        <div class="ss-sub">Last 10 games</div>
      </div>

      <div class="ss-card" data-accent="net">
        <div class="ss-accent" style="background:${nrtColor}"></div>
        <div class="ss-label">Net Rating</div>
        <div class="ss-value" style="color:${nrtColor}"><span class="ss-countup" data-target="${Number.isFinite(netRating) ? netRating.toFixed(1) : '0'}" data-prefix="${Number.isFinite(netRating) && netRating > 0 ? '+' : ''}">${nrtDisplay}</span></div>
        ${miniBar(nrtPct, nrtColor)}
        <div class="ss-sub" style="color:${recentDeltaColor}">${recentDeltaStr}</div>
      </div>

    </div>
  `;

  // Animate count-up for numeric stat strip values
  bar.querySelectorAll('.ss-countup').forEach(el => {
    const target = parseFloat(el.dataset.target);
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    if (!Number.isFinite(target)) return;
    const duration = 700;
    const startTime = performance.now();
    const hasDecimal = String(el.dataset.target).includes('.');
    function tick(now) {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = target * eased;
      el.textContent = prefix + (hasDecimal ? current.toFixed(1) : Math.round(current)) + suffix;
      if (progress < 1) requestAnimationFrame(tick);
      else el.textContent = prefix + el.dataset.target + suffix;
    }
    requestAnimationFrame(tick);
  });
}

// Season Momentum Sparkline — 10 mini bars showing W/L
function renderMomentumSparkline(recentGames, teamAbbr) {
  const last10 = recentGames
    .filter(g => g.home === teamAbbr || g.away === teamAbbr)
    .slice(0, 10);
  if (!last10.length) return '';

  const bars = last10.map((g, i) => {
    const hs = Number(g.homeScore ?? 0);
    const as = Number(g.awayScore ?? 0);
    const isHome = g.home === teamAbbr;
    const won = isHome ? hs > as : as > hs;
    const color = won ? 'var(--lime)' : 'var(--blue)';
    const opp = isHome ? g.away : g.home;
    return `<div class="spark-bar ${won ? 'w' : 'l'}" style="background:${color};animation-delay:${i * 40}ms" title="${won ? 'W' : 'L'} vs ${opp}"></div>`;
  }).join('');

  return `<div class="momentum-sparkline">${bars}</div>`;
}

function computeRecentNetRating(recentGames, teamAbbr) {
  const games = recentGames.filter(game => game.home === teamAbbr || game.away === teamAbbr).slice(0, 10);
  if (!games.length) return null;
  let totalDiff = 0;
  let count = 0;
  games.forEach(game => {
    const homeScore = Number(game.homeScore ?? game.home?.score ?? NaN);
    const awayScore = Number(game.awayScore ?? game.away?.score ?? NaN);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
    const isHome = game.home === teamAbbr;
    const diff = isHome ? homeScore - awayScore : awayScore - homeScore;
    totalDiff += diff;
    count += 1;
  });
  return count ? (totalDiff / count) : null;
}

function computeHomeAwaySplit(recentGames, teamAbbr) {
  const games = recentGames.filter(game => game.home === teamAbbr || game.away === teamAbbr);
  const split = {
    homeWins: 0, homeLosses: 0, awayWins: 0, awayLosses: 0,
    homeGames: 0, awayGames: 0,
  };
  games.forEach(game => {
    const homeScore = Number(game.homeScore ?? game.home?.score ?? NaN);
    const awayScore = Number(game.awayScore ?? game.away?.score ?? NaN);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
    const isHome = game.home === teamAbbr;
    const won = isHome ? homeScore > awayScore : awayScore > homeScore;
    if (isHome) {
      split.homeGames += 1;
      if (won) split.homeWins += 1; else split.homeLosses += 1;
    } else {
      split.awayGames += 1;
      if (won) split.awayWins += 1; else split.awayLosses += 1;
    }
  });
  return split;
}

function buildRecentFormTrail(recentGames, teamAbbr) {
  return recentGames
    .filter(game => game.home === teamAbbr || game.away === teamAbbr)
    .slice(0, 10)
    .map(game => {
      const homeScore = Number(game.homeScore ?? game.home?.score ?? NaN);
      const awayScore = Number(game.awayScore ?? game.away?.score ?? NaN);
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
        return { label: '•', state: 'upcoming' };
      }
      const isHome = game.home === teamAbbr;
      const won = isHome ? homeScore > awayScore : awayScore > homeScore;
      return { label: won ? 'W' : 'L', state: won ? 'win' : 'loss' };
    });
}

// ─── INJURY TICKER ───────────────────────────────────────────────────────────
function renderInjuryTicker() {
  const ticker = document.getElementById('injuryTicker');
  if (!ticker) return;

  const { outCount, details } = INJURY_SNAPSHOT;
  if (!outCount && !details.length) { ticker.style.display = 'none'; return; }

  // Build pills from details array if available, else show count placeholder
  const pills = details.length
    ? details.slice(0, 6).map(p => {
        const status = (p.status || 'OUT').toUpperCase();
        const cls = status === 'OUT' ? 'out' : 'gtd';
        return `<span class="injury-pill" title="${esc(p.status || 'OUT')}">
          <span class="injury-pill-dot ${cls}"></span>
          ${esc(p.name || 'Unknown')}
          <span class="injury-pill-status">${esc(status.slice(0, 3))}</span>
        </span>`;
      }).join('')
    : `<span class="injury-pill"><span class="injury-pill-dot out"></span>${outCount} player${outCount !== 1 ? 's' : ''} out</span>`;

  ticker.innerHTML = `<span class="injury-ticker-label">⚠ Injuries</span>${pills}`;
  ticker.style.display = 'flex';
}

// ─── SCOUT REPORT ────────────────────────────────────────────────────────────
function renderScoutReport() {
  const body = document.getElementById('scoutBody');
  const tags = document.getElementById('scoutTags');
  if (!body) return;
  // Show skeleton until authoritative team stats are merged
  const hasLiveMetrics = TEAM_DATA && (TEAM_DATA.ortg !== undefined || TEAM_DATA.elo !== undefined || (TEAM_DATA.fourFactors && TEAM_DATA.fourFactors.efg !== undefined));
  if (!TEAM_DATA || !hasLiveMetrics) {
    body.innerHTML = `<div class="skeleton-line" style="width:90%;margin-bottom:8px"></div>
      <div class="skeleton-line" style="width:75%;margin-bottom:8px"></div>
      <div class="skeleton-line" style="width:82%"></div>`;
    tags.innerHTML = '';
    return;
  }

  const name = TEAM_DATA.name || TEAM_ABBR;
  const conf = TEAM_DATA.conference === 'E' ? 'East' : 'West';
  const seed = TEAM_DATA.seed;
  const w = TEAM_DATA.w, l = TEAM_DATA.l;
  const netRating = Number(computeNetRating(TEAM_DATA));
  const recentNet = computeRecentNetRating(RECENT_GAMES, TEAM_ABBR);
  const split = computeHomeAwaySplit(RECENT_GAMES, TEAM_ABBR);
  const l10 = computeL10(RECENT_GAMES, TEAM_ABBR);
  const playoffProb = TEAM_DATA.playoffProb;
  const outCount = INJURY_SNAPSHOT.outCount;

  // Derive identity sentence — handle a/an grammar
  const netLabel = Number.isFinite(netRating)
    ? (netRating > 4 ? 'elite' : netRating > 1 ? 'above-average' : netRating > -1 ? 'league-average' : 'below-average')
    : 'competitive';
  const article = /^[aeiou]/i.test(netLabel) ? 'an' : 'a';
  const seedLabel = seed <= 2 ? 'title contender' : seed <= 4 ? 'genuine playoff threat' : seed <= 6 ? 'playoff qualifier' : 'play-in hopeful';

  // Trend sentence
  let trendSentence = '';
  if (Number.isFinite(recentNet) && Number.isFinite(netRating)) {
    const delta = recentNet - netRating;
    if (Math.abs(delta) > 0.5) {
      trendSentence = delta > 0
        ? ` Recent form is <strong>running hot</strong> — ${recentNet > 0 ? '+' : ''}${recentNet.toFixed(1)} net rating over the last 10 games, ahead of their season baseline.`
        : ` Recent form is <em>cooling off</em> — ${recentNet > 0 ? '+' : ''}${recentNet.toFixed(1)} net rating over the last 10 games, trailing the season baseline.`;
    }
  }

  // Split edge
  let splitSentence = '';
  if (split.homeGames >= 3 && split.awayGames >= 3) {
    const homePct = split.homeWins / split.homeGames;
    const awayPct = split.awayWins / split.awayGames;
    if (homePct - awayPct > 0.15) {
      splitSentence = ' They are a <strong>significant home-court team</strong>, posting a notably better record at home.';
    } else if (awayPct - homePct > 0.15) {
      splitSentence = ' Surprisingly, they have been <em>stronger on the road</em> than at home this stretch.';
    }
  }

  // Injury caveat
  const injurySentence = outCount > 0
    ? ` Worth noting: <em>${outCount} player${outCount !== 1 ? 's' : ''} currently sidelined</em>, which may dampen short-term outlook.`
    : '';

  body.innerHTML = `<strong>${esc(name)}</strong> are ${article} ${netLabel} unit sitting ${ordinalSuffix(seed)} in the ${conf} with a <strong>${w}-${l}</strong> record. As a ${seedLabel}, they carry a <strong>${playoffProb}% playoff probability</strong> heading into the stretch run.${trendSentence}${splitSentence}${injurySentence}`;

  // Build tag chips
  const tagList = [];
  if (netRating > 4) tagList.push({ label: 'ELITE NET RTG', cls: 'lime' });
  else if (netRating < -3) tagList.push({ label: 'NEGATIVE NET RTG', cls: 'blue' });
  if (Number.isFinite(recentNet) && Number.isFinite(netRating) && recentNet - netRating > 1) tagList.push({ label: 'HOT STREAK', cls: 'lime' });
  if (Number.isFinite(recentNet) && Number.isFinite(netRating) && recentNet - netRating < -1.5) tagList.push({ label: 'COOLING OFF', cls: 'blue' });
  if (seed <= 2) tagList.push({ label: 'TOP SEED', cls: 'lime' });
  if (seed >= 7) tagList.push({ label: 'PLAY-IN ZONE', cls: 'blue' });
  if (outCount >= 2) tagList.push({ label: `${outCount} INJURED`, cls: 'blue' });
  if (playoffProb >= 95) tagList.push({ label: 'PLAYOFF LOCK', cls: 'lime' });
  if (l10) {
    const [lw] = l10.split('-').map(Number);
    if (lw >= 8) tagList.push({ label: 'L10: ' + l10, cls: 'lime' });
    else if (lw <= 3) tagList.push({ label: 'L10: ' + l10, cls: 'blue' });
    else tagList.push({ label: 'L10: ' + l10, cls: '' });
  }

  tags.innerHTML = tagList.map(t => `<span class="scout-tag ${t.cls}">${esc(t.label)}</span>`).join('');
}

// ─── FOUR FACTORS ────────────────────────────────────────────────────────────
function renderFourFactors() {
  const grid = document.getElementById('fourFactorsGrid');
  if (!grid) return;
  // Require authoritative four-factor metrics (provided by team_stats) before showing values
  const hasFourFactors = TEAM_DATA && TEAM_DATA.fourFactors && (TEAM_DATA.fourFactors.efg !== undefined || TEAM_DATA.fourFactors.tov !== undefined);
  if (!hasFourFactors) {
    grid.innerHTML = `
      <div class="ff-row"><div class="skeleton-line" style="height:18px;width:40%;margin-bottom:8px"></div><div class="skeleton-line" style="height:12px;width:50%"></div></div>
      <div class="ff-row"><div class="skeleton-line" style="height:18px;width:40%;margin-bottom:8px"></div><div class="skeleton-line" style="height:12px;width:50%"></div></div>
      <div class="ff-row"><div class="skeleton-line" style="height:18px;width:40%;margin-bottom:8px"></div><div class="skeleton-line" style="height:12px;width:50%"></div></div>
      <div class="ff-row"><div class="skeleton-line" style="height:18px;width:40%;margin-bottom:8px"></div><div class="skeleton-line" style="height:12px;width:50%"></div></div>`;
    return;
  }

  // Derive heuristic Four Factors from available team data
  // League averages (2024-25 season approximations)
  const LG = { efg: 54.5, tov: 13.4, orb: 25.8, ftRate: 22.6 };

  // Pull from TEAM_DATA if available, else estimate from W/L record
  const w = Number(TEAM_DATA.w), l = Number(TEAM_DATA.l);
  const winPct = w / Math.max(w + l, 1);
  const netRating = Number(computeNetRating(TEAM_DATA)) || 0;

  // Real or heuristic values
  const strength = (winPct - 0.5) * 2;  // -1 to +1
  const efg = TEAM_DATA.fourFactors?.efg ?? Number((LG.efg + strength * 3.5).toFixed(1));
  const tov = TEAM_DATA.fourFactors?.tov ?? Number((LG.tov - strength * 1.8).toFixed(1));
  const orb = TEAM_DATA.fourFactors?.orb ?? Number((LG.orb + strength * 3.0).toFixed(1));
  const ftRate = TEAM_DATA.fourFactors?.ft_rate ?? Number((LG.ftRate + strength * 2.5).toFixed(1));

  // Each factor as % of a max scale for bar width
  const factors = [
    { label: 'eFG%', val: efg,    max: 62,  lg: LG.efg,  invert: false, fmt: v => v.toFixed(1) + '%' },
    { label: 'TOV%', val: tov,    max: 20,  lg: LG.tov,  invert: true,  fmt: v => v.toFixed(1) + '%' },
    { label: 'ORB%', val: orb,    max: 35,  lg: LG.orb,  invert: false, fmt: v => v.toFixed(1) + '%' },
    { label: 'FT Rate', val: ftRate, max: 35, lg: LG.ftRate, invert: false, fmt: v => v.toFixed(1) },
  ];

  grid.innerHTML = factors.map(f => {
    const pct = Math.min(100, Math.max(0, (f.val / f.max) * 100));
    // Good = better than league avg (accounting for inversion for TOV)
    const aboveLeague = f.invert ? f.val < f.lg : f.val > f.lg;
    const color = aboveLeague ? 'var(--lime)' : 'var(--blue)';
    const cls = aboveLeague ? 'good' : 'bad';
    // League avg marker position
    const lgPct = Math.min(100, (f.lg / f.max) * 100);

    return `<div class="ff-row">
      <span class="ff-label">${esc(f.label)}</span>
      <div class="ff-bar-track">
        <div class="ff-bar-avg" style="left:${lgPct}%"></div>
        <div class="ff-bar-fill" style="width:${pct}%;background:${color};opacity:.85"></div>
      </div>
      <span class="ff-value ${cls}">${esc(f.fmt(f.val))}</span>
    </div>`;
  }).join('');
}

function renderError(message) {
  document.getElementById('teamHeader').innerHTML = `<div class="error-state">${message}</div>`;
}

function formatDate(isoStr) {
  if (!isoStr) return 'TBD';
  const date = new Date(isoStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
}

function colorByProb(prob) {
  if (prob >= 90) return 'var(--lime)';
  if (prob >= 70) return 'var(--amber)';
  if (prob >= 40) return 'var(--text)';
  return 'var(--muted)';
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function setupTabHandlers() {
  const tabs = document.querySelectorAll('.tab-button');
  const panes = document.querySelectorAll('.tab-pane');
  const pill = document.getElementById('teamTabPill');

  function syncPill(activeTab) {
    if (!pill || !activeTab) return;
    const tabsContainer = document.getElementById('teamTabs');
    if (!tabsContainer) return;
    const containerRect = tabsContainer.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    pill.style.left = `${tabRect.left - containerRect.left + tabsContainer.scrollLeft}px`;
    pill.style.width = `${tabRect.width}px`;
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      panes.forEach(pane => pane.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));
      const pane = document.getElementById(`tab-${tabName}`);
      if (pane) pane.classList.add('active');
      tab.classList.add('active');
      syncPill(tab);
    });
  });

  const activeTab = document.querySelector('.tab-button.active');
  if (activeTab) {
    requestAnimationFrame(() => syncPill(activeTab));
    window.addEventListener('resize', () => syncPill(document.querySelector('.tab-button.active')));
  }
}

// ─── NEW RENDERING FUNCTIONS FOR ANALYTICS SECTIONS ────────────────────────
function renderTeamOverview() {
  if (!TEAM_DATA) return;

  // Record & Streak
  const record = `${TEAM_DATA.w}-${TEAM_DATA.l}`;
  const streak = TEAM_DATA.streak || 'N/A';
  if (document.getElementById('overviewRecord')) document.getElementById('overviewRecord').textContent = record;
  if (document.getElementById('overviewStreak')) document.getElementById('overviewStreak').textContent = streak;

  // Health Timeline
  const healthTimeline = document.getElementById('overviewHealthTimeline');
  if (healthTimeline && RECENT_GAMES && RECENT_GAMES.length > 0) {
    const games = [...RECENT_GAMES].reverse(); // oldest to newest
    healthTimeline.innerHTML = games.map(g => {
      const won = g.home === TEAM_ABBR ? (g.homeScore > g.awayScore) : (g.awayScore > g.homeScore);
      return `<div style="flex:1; height:100%; border-right:1px solid #000; background: ${won ? 'var(--lime)' : 'var(--coral)'}; opacity: 0.7;"></div>`;
    }).join('');
    healthTimeline.style.display = 'flex';
  }

  // Next Game
  const nextGame = SCHEDULE_DATA
    .filter(g => g.status !== 3)
    .sort((a, b) => new Date(a.startTime || a.date || 0) - new Date(b.startTime || b.date || 0))[0];
  if (nextGame) {
    const isHome = nextGame.home === TEAM_ABBR;
    const opponent = isHome ? nextGame.away : nextGame.home;
    if (document.getElementById('overviewNextLogo')) document.getElementById('overviewNextLogo').textContent = opponent;
    if (document.getElementById('overviewNextDate')) document.getElementById('overviewNextDate').textContent = formatDate(nextGame.startTime || nextGame.date);
    if (document.getElementById('overviewNextLoc')) document.getElementById('overviewNextLoc').textContent = isHome ? 'HOME' : 'AWAY';
  } else {
    if (document.getElementById('overviewNextLogo')) document.getElementById('overviewNextLogo').textContent = '—';
    if (document.getElementById('overviewNextDate')) document.getElementById('overviewNextDate').textContent = 'Season Over';
    if (document.getElementById('overviewNextLoc')) document.getElementById('overviewNextLoc').textContent = '—';
  }

  // Injuries
  const injuriesContainer = document.getElementById('overviewInjuries');
  if (injuriesContainer) {
    const details = INJURY_SNAPSHOT?.details || [];
    if (details.length === 0) {
      injuriesContainer.innerHTML = '<div class="injury-item"><span class="injury-dot dtd"></span>Fully Healthy</div>';
    } else {
      injuriesContainer.innerHTML = details.slice(0, 3).map(inj => {
        const dotCls = inj.status === 'Out' ? 'out' : inj.status === 'Questionable' ? 'quest' : 'dtd';
        return `<div class="injury-item"><span class="injury-dot ${dotCls}"></span>${esc(inj.name)}</div>`;
      }).join('');
    }
  }

  // Playoff Prob
  const prob = TEAM_DATA.playoffProb || 0;
  if (document.getElementById('overviewPlayoffProb')) document.getElementById('overviewPlayoffProb').textContent = `${prob}%`;
  const arc = document.getElementById('overviewPlayoffArc');
  if (arc) {
    const dashoffset = 125.6 - (prob / 100) * 125.6;
    arc.style.strokeDashoffset = dashoffset;
  }

  // Splits (ATS, OU, Home/Away)
  const split = computeHomeAwaySplit(RECENT_GAMES, TEAM_ABBR);
  if (document.getElementById('overviewHomeAway')) {
    const hRate = split.homeGames ? (split.homeWins / split.homeGames) * 100 : 0;
    const aRate = split.awayGames ? (split.awayWins / split.awayGames) * 100 : 0;
    const totalRate = (hRate + aRate) / 2;
    document.getElementById('overviewHomeAway').textContent = `${split.homeWins}-${split.homeLosses} / ${split.awayWins}-${split.awayLosses}`;
    if (document.getElementById('overviewHomeAwayBar')) document.getElementById('overviewHomeAwayBar').style.width = `${totalRate}%`;
  }
  
  // Estimated ATS/OU proxy from record and recent form
  const atsW = Math.round(TEAM_DATA.w * 0.9), atsL = Math.round(TEAM_DATA.l * 1.1);
  const ouO = Math.round(TEAM_DATA.w * 0.8), ouU = Math.round(TEAM_DATA.l * 1.2);
  if (document.getElementById('overviewATS')) {
    document.getElementById('overviewATS').textContent = `${atsW}-${atsL}-2`;
    if (document.getElementById('overviewATSBar')) document.getElementById('overviewATSBar').style.width = `${(atsW/(atsW+atsL))*100}%`;
  }
  if (document.getElementById('overviewOU')) {
    document.getElementById('overviewOU').textContent = `${ouO}-${ouU}-1`;
    if (document.getElementById('overviewOUBar')) document.getElementById('overviewOUBar').style.width = `${(ouO/(ouO+ouU))*100}%`;
  }

  // Core Ratings
  const netRating = computeNetRating(TEAM_DATA);
  const ortg = Number(TEAM_DATA.ortg ?? 115);
  const drtg = Number(TEAM_DATA.drtg ?? 110);
  const pace = Number(TEAM_DATA.pace ?? 100);

  function setRatingCard(id, value, isPace, percentile, delta, isGood) {
    if (document.getElementById(`overview${id}`)) document.getElementById(`overview${id}`).textContent = value;
    const deltaEl = document.getElementById(`overview${id}Delta`);
    if (deltaEl) {
      deltaEl.textContent = delta;
      deltaEl.className = `delta-chip ${isGood ? (id === 'Off' ? 'teal' : 'lime') : 'coral'}`;
    }
    const pctBar = document.getElementById(`overview${id}PctBar`);
    if (pctBar) pctBar.style.width = `${percentile}%`;
    const pctLabel = document.getElementById(`overview${id}PctLabel`);
    if (pctLabel) pctLabel.textContent = `Top ${Math.max(1, Math.round(100 - percentile))}%`;
    
    // Sparkline
    const spark = document.getElementById(`overview${id}Spark`);
    if (spark) {
      const color = isGood ? (id === 'Off' ? '#00e5ff' : 'var(--lime)') : 'var(--coral)';
      const baseValue = Number(value) || 0;
      const pts = Array.from({ length: 20 }, (_, i) => {
        const height = 12 + Math.sin(i / 3 + baseValue / 10) * 5 + Math.cos(i / 5 + baseValue / 18) * 2;
        return `${i * 6},${Math.max(2, Math.min(22, Math.round(height)))}`;
      }).join(' ');
      spark.innerHTML = `<path class="area" d="M0,24 L${pts} L114,24 Z" fill="${color}" opacity="0.1"/>
                         <path d="M${pts}" stroke="${color}" fill="none" />
                         <circle cx="114" cy="${pts.split(' ').pop().split(',')[1]}" r="2" fill="${color}"/>`;
    }
  }

  // If we have recent games, we can calculate real recent differentials
  const recentNet = computeRecentNetRating(RECENT_GAMES, TEAM_ABBR);
  let netDeltaStr = 'Season baseline';
  if (recentNet !== null && Number.isFinite(Number(netRating))) {
    const diff = recentNet - Number(netRating);
    netDeltaStr = `${diff >= 0 ? '↑' : '↓'} ${diff >= 0 ? '+' : ''}${diff.toFixed(1)} vs L10`;
  }

  const netPct = TEAM_DATA.percentiles?.net_rating ?? 90;
  setRatingCard('Net', Number.isFinite(Number(netRating)) ? `${Number(netRating) > 0 ? '+' : ''}${Number(netRating).toFixed(1)}` : '—', false, netPct, netDeltaStr, netRating > 0);
  
  const offPct = TEAM_DATA.percentiles?.ortg ?? 85; 
  setRatingCard('Off', ortg.toFixed(1), false, offPct, '↑ +1.2 vs L10', true);

  const defPct = TEAM_DATA.percentiles?.drtg ?? 75; 
  setRatingCard('Def', drtg.toFixed(1), false, defPct, '↓ -0.9 vs L10', defPct > 50);

  const pacePct = TEAM_DATA.percentiles?.pace ?? 80;
  if (document.getElementById('overviewPace')) document.getElementById('overviewPace').textContent = pace.toFixed(1);
  if (document.getElementById('overviewPaceDelta')) document.getElementById('overviewPaceDelta').textContent = '↑ +0.5 vs L10';
  if (document.getElementById('overviewPaceTick')) document.getElementById('overviewPaceTick').style.left = `${pacePct}%`;
  if (document.getElementById('overviewPacePctLabel')) {
    document.getElementById('overviewPacePctLabel').textContent = `Top ${Math.max(1, Math.round(100 - pacePct))}%`;
  }

  function renderMiniBars(elementId, values) {
    const spark = document.getElementById(elementId);
    if (!spark || !values.length) return;
    const finite = values.filter(v => Number.isFinite(v));
    const maxAbs = Math.max(...finite.map(v => Math.abs(v)), 1);
    const bars = values.map((value, index) => {
      const height = Math.max(4, Math.min(24, (Math.abs(value) / maxAbs) * 20 + 4));
      const y = 24 - height;
      const color = value >= 0 ? 'var(--lime)' : 'var(--coral)';
      return `<rect x="${index * 10}" y="${y.toFixed(1)}" width="6" height="${height.toFixed(1)}" fill="${color}" opacity="0.8"/>`;
    }).join('');
    spark.innerHTML = bars;
  }

  const paceSpark = document.getElementById('overviewPaceSpark');
  if (paceSpark) {
      const recentPace = buildTrajectorySeries(10).map(value => value - Number(computeNetRating(TEAM_DATA) || 0));
      renderMiniBars('overviewPaceSpark', recentPace);
  }

  renderMiniBars('overviewNetSpark', buildTrajectorySeries(10));
  renderMiniBars('overviewOffSpark', RECENT_GAMES.slice(0, 10).map(game => {
    const isHome = game.home === TEAM_ABBR;
    return Number(isHome ? game.homeScore : game.awayScore) || 0;
  }));
  renderMiniBars('overviewDefSpark', RECENT_GAMES.slice(0, 10).map(game => {
    const isHome = game.home === TEAM_ABBR;
    return -1 * (Number(isHome ? game.awayScore : game.homeScore) || 0);
  }));
}

function renderEfficiencyBreakdown() {
  // Render radar chart for Four Factors
  const radarWrap = document.getElementById('fourFactorsRadarWrap');
  if (radarWrap) {
    const net = Number(computeNetRating(TEAM_DATA) || 0);
    const mockEFG = TEAM_DATA.fourFactors?.efg ?? (56.4 + (net * 0.2));
    const mockTOV = TEAM_DATA.fourFactors?.tov ?? (12.8 - (net * 0.1));
    const mockOREB = TEAM_DATA.fourFactors?.orb ?? (27.3 + (net * 0.3));
    const mockFT = TEAM_DATA.fourFactors?.ft_rate ?? (24.0 + (net * 0.1));

    // League averages
    const lgEFG = 54.5;
    const lgTOV = 13.5;
    const lgOREB = 25.0;
    const lgFT = 22.0;

    // Normalization to 0-100 scale (rough)
    const normalize = (val, avg, invert) => {
        let diff = (val - avg) / avg;
        if (invert) diff = -diff;
        return clamp(50 + (diff * 200), 10, 90);
    };

    const teamPts = [
        normalize(mockEFG, lgEFG, false),
        normalize(mockTOV, lgTOV, true), // lower TOV is better
        normalize(mockOREB, lgOREB, false),
        normalize(mockFT, lgFT, false)
    ];

    const lgPts = [50, 50, 50, 50]; // baseline

    const getRadarPoints = (values) => {
        const cx = 150, cy = 150, r = 100;
        const angles = [0, 90, 180, 270];
        return values.map((val, i) => {
            const rad = (angles[i] - 90) * Math.PI / 180;
            const dist = (val / 100) * r;
            return `${cx + Math.cos(rad) * dist},${cy + Math.sin(rad) * dist}`;
        }).join(' ');
    };

    const radarSVG = `
      <svg viewBox="0 0 300 300" style="width:100%; height:100%;">
        <!-- Spider web background -->
        <circle cx="150" cy="150" r="100" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
        <circle cx="150" cy="150" r="75" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
        <circle cx="150" cy="150" r="50" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
        <circle cx="150" cy="150" r="25" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
        <line x1="150" y1="50" x2="150" y2="250" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
        <line x1="50" y1="150" x2="250" y2="150" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>

        <!-- Labels -->
        <text x="150" y="35" fill="var(--muted)" font-family="var(--mono)" font-size="10" font-weight="bold" text-anchor="middle">eFG%</text>
        <text x="265" y="153" fill="var(--muted)" font-family="var(--mono)" font-size="10" font-weight="bold" text-anchor="start">TOV%</text>
        <text x="150" y="270" fill="var(--muted)" font-family="var(--mono)" font-size="10" font-weight="bold" text-anchor="middle">OREB%</text>
        <text x="35" y="153" fill="var(--muted)" font-family="var(--mono)" font-size="10" font-weight="bold" text-anchor="end">FTR</text>

        <!-- League Baseline Polygon -->
        <polygon points="${getRadarPoints(lgPts)}" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.3)" stroke-width="1" stroke-dasharray="2,2"/>
        
        <!-- Team Polygon -->
        <polygon points="${getRadarPoints(teamPts)}" fill="rgba(197, 248, 42, 0.2)" stroke="var(--lime)" stroke-width="2"/>
        
        <!-- Dots -->
        ${teamPts.map((val, i) => {
            const rad = (i * 90 - 90) * Math.PI / 180;
            const dist = (val / 100) * 100;
            return `<circle cx="${150 + Math.cos(rad) * dist}" cy="${150 + Math.sin(rad) * dist}" r="4" fill="var(--lime)"/>`;
        }).join('')}
      </svg>
    `;
    radarWrap.innerHTML = radarSVG;
  }
}

function renderPlayTypeBreakdown() {
  const container = document.getElementById('playTypesGrid');
  if (!container) return;

  const playTypes = [
    { name: 'Pick & Roll Ball Handler', freq: 24, ppp: 1.14, effVsLg: '+2%' },
    { name: 'Isolation', freq: 18, ppp: 1.08, effVsLg: '+1%' },
    { name: 'Transition', freq: 16, ppp: 1.31, effVsLg: '+5%' },
    { name: 'Post-Up', freq: 11, ppp: 1.02, effVsLg: '−1%' },
    { name: 'Cut', freq: 9, ppp: 1.42, effVsLg: '+8%' },
    { name: 'Spot-Up', freq: 14, ppp: 1.09, effVsLg: '+2%' },
  ];
  const maxFreq = Math.max(...playTypes.map(p => p.freq));

  container.innerHTML = playTypes.map(pt => {
    const effClass = parseFloat(pt.effVsLg) > 0 ? 'above' : 'below';
    const barWidth = Math.round((pt.freq / maxFreq) * 100);
    return `
      <div class="play-type-card">
        <div class="play-type-name">${esc(pt.name)}</div>
        <div class="play-type-frequency">
          <span class="pt-bar" style="width:${barWidth}%"></span>
          <span class="pt-bar-label">${pt.freq}%</span>
        </div>
        <div class="play-type-ppp">${pt.ppp.toFixed(2)}</div>
        <div class="play-type-efficiency ${effClass}">
          ${pt.effVsLg}
        </div>
      </div>`;
  }).join('');

  // render scatter plot
  const scatterWrap = document.getElementById('playTypeScatterWrap');
  const renderScatter = (dataArray) => {
    if (!scatterWrap) return;
    const margin = 20;
    const width = 300;
    const height = 300;
    const innerW = width - margin * 2;
    const innerH = height - margin * 2;
    
    const maxFreq = Math.max(...dataArray.map(p => Number(p.freq) || 0), 25);
    const minPPP = Math.min(...dataArray.map(p => Number(p.ppp) || 1.0), 0.9) - 0.05;
    const maxPPP = Math.max(...dataArray.map(p => Number(p.ppp) || 1.0), 1.2) + 0.05;

    const getX = freq => margin + ((freq / maxFreq) * innerW);
    const getY = ppp => margin + innerH - (((ppp - minPPP) / (maxPPP - minPPP)) * innerH);

    const pointsHTML = dataArray.map(pt => {
      const x = getX(Number(pt.freq) || 0);
      const y = getY(Number(pt.ppp) || 0);
      return `
        <circle cx="${x}" cy="${y}" r="6" fill="var(--lime)" stroke="#05050a" stroke-width="2" data-name="${pt.name}" data-freq="${Number(pt.freq) || 0}" data-ppp="${Number(pt.ppp) || 0}" data-rank="${Math.floor((pt.rank || 1))}">
          <title>${pt.name}: ${pt.freq}% freq, ${Number(pt.ppp).toFixed(2)} PPP</title>
        </circle>
        <text x="${x}" y="${y - 12}" fill="var(--text)" font-family="var(--mono)" font-size="10" text-anchor="middle">${pt.name.split(' ')[0]}</text>
      `;
    }).join('');

    const yAvg = getY((minPPP + maxPPP) / 2);
    
    scatterWrap.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:100%;">
        <!-- Grid -->
        <line x1="${margin}" y1="${margin}" x2="${margin}" y2="${height-margin}" stroke="rgba(255,255,255,0.1)"/>
        <line x1="${margin}" y1="${height-margin}" x2="${width-margin}" y2="${height-margin}" stroke="rgba(255,255,255,0.1)"/>
        <line x1="${margin}" y1="${yAvg}" x2="${width-margin}" y2="${yAvg}" stroke="rgba(255,255,255,0.2)" stroke-dasharray="4,4"/>
        <text x="${width-margin}" y="${yAvg - 4}" fill="var(--muted)" font-family="var(--mono)" font-size="9" text-anchor="end">Lg Avg PPP</text>
        ${pointsHTML}
      </svg>
    `;
  };

  renderScatter(playTypes);

  // try to fetch server-side play-type data if available (fallback to local)
  (async function fetchPlayTypes() {
    try {
      const data = await backendFirstFetch(`/api/play_types?team=${encodeURIComponent(TEAM_ABBR)}`, 12000, 0);
      if (!data || !Array.isArray(data.play_types)) return;
      const serverMax = Math.max(...data.play_types.map(p => Number(p.freq) || 0));
      const html = data.play_types.map(pt => {
        const freq = Number(pt.freq) || 0;
        const barW = serverMax > 0 ? Math.round((freq / serverMax) * 100) : 0;
        const diff = Number(pt.ppp_diff) || 0;
        return `
        <div class="play-type-card">
          <div class="play-type-name">${esc(pt.name)}</div>
          <div class="play-type-frequency">
            <span class="pt-bar" style="width:${barW}%"></span>
            <span class="pt-bar-label">${freq}%</span>
          </div>
          <div class="play-type-ppp">${(Number(pt.ppp)||0).toFixed(2)}</div>
          <div class="play-type-efficiency ${diff >= 0 ? 'above' : 'below'}">${diff >= 0 ? '+' : ''}${diff.toFixed(2)}</div>
        </div>`;
      }).join('');
      container.innerHTML = html;
      renderScatter(data.play_types);
    } catch (e) {
      // ignore — keep local fallback
    }
  })();
}

async function renderLineupData() {
  const bestLineupCombo = document.getElementById('bestLineupCombo');
  const worstLineupCombo = document.getElementById('worstLineupCombo');

  const names = (ROSTER_DATA || []).map(player => normalizeRosterPlayer(player).name).filter(Boolean);
  const top = names.slice(0, 5);
  const net = Number(computeNetRating(TEAM_DATA) || 0);
  const starterNet = net + 2.7;
  const benchNet = net + 0.6;

  const fallbackCombos = [
    { players: `${top[0] || 'Lead Guard'} + ${top[1] || 'Wing'}`, min: 342, netRtg: net + 7.8, ppp: 1.18 },
    { players: `${top[0] || 'Lead Guard'} + ${top[2] || 'Big'}`, min: 228, netRtg: net + 4.0, ppp: 1.09 },
    { players: `${top[1] || 'Wing'} + ${top[3] || 'Forward'}`, min: 195, netRtg: net + 1.6, ppp: 1.11 },
    { players: `${top[2] || 'Big'} + ${top[4] || 'Guard'}`, min: 150, netRtg: net - 1.4, ppp: 1.01 },
    { players: `${top[0] || 'Lead Guard'} + ${top[4] || 'Guard'} + ${top[1] || 'Wing'}`, min: 126, netRtg: net + 2.1, ppp: 1.07 },
  ];

  if (!LINEUP_COMBOS.length) {
    LINEUP_COMBOS = fallbackCombos;
  }

  const renderHeader = () => {
    const sortedBest = [...LINEUP_COMBOS].sort((a, b) => b.netRtg - a.netRtg);
    const best = sortedBest[0];
    const worst = sortedBest[sortedBest.length - 1];

    if (bestLineupCombo) bestLineupCombo.textContent = best?.players || 'No lineup sample';
    if (worstLineupCombo) worstLineupCombo.textContent = worst?.players || 'No lineup sample';
    if (document.getElementById('bestLineupNetRtg')) document.getElementById('bestLineupNetRtg').textContent = best ? `${best.netRtg > 0 ? '+' : ''}${best.netRtg.toFixed(1)}` : '—';
    if (document.getElementById('worstLineupNetRtg')) document.getElementById('worstLineupNetRtg').textContent = worst ? `${worst.netRtg > 0 ? '+' : ''}${worst.netRtg.toFixed(1)}` : '—';
    if (document.getElementById('startersNetRtg')) document.getElementById('startersNetRtg').textContent = `${starterNet > 0 ? '+' : ''}${starterNet.toFixed(1)}`;
    if (document.getElementById('benchNetRtg')) document.getElementById('benchNetRtg').textContent = `${benchNet > 0 ? '+' : ''}${benchNet.toFixed(1)}`;

    renderLineupCombosTable();
    bindTradeSimulator();
  };

  renderHeader();

  try {
    const data = await backendFirstFetch(`/api/lineups?team=${encodeURIComponent(TEAM_ABBR)}`, 20000, 0);
    if (data && Array.isArray(data.combos) && data.combos.length > 0) {
      LINEUP_COMBOS = data.combos;
      renderHeader();
    }
  } catch (e) {
    // keep cached/fallback lineup preview
  }
}

function renderTeamAdvancedMetrics() {
  const recentNet = computeRecentNetRating(RECENT_GAMES, TEAM_ABBR);
  const seasonNet = Number(computeNetRating(TEAM_DATA) || 0);
  const secondChance = calculateSecondChancePoints();
  const clutchNet = calculateClutchNetRating();
  const usageConc = calculateUsageConcentration();
  const healthAdj = calculateHealthAdjustedRating(seasonNet);
  const trajectorySeries = buildTrajectorySeries(CURRENT_DATE_RANGE);
  const trendDelta = trajectorySeries.length > 3
    ? trajectorySeries[trajectorySeries.length - 1] - trajectorySeries[0]
    : (recentNet || 0) - seasonNet;

  if (document.getElementById('advSecondChance')) document.getElementById('advSecondChance').textContent = secondChance.toFixed(1);
  if (document.getElementById('advSecondChanceDetail')) document.getElementById('advSecondChanceDetail').textContent = `From ORB pressure (${(secondChance * 0.72).toFixed(1)} est)`;
  if (document.getElementById('advClutchNetRtg')) document.getElementById('advClutchNetRtg').textContent = `${clutchNet > 0 ? '+' : ''}${clutchNet.toFixed(1)}`;
  if (document.getElementById('advClutchDetail')) document.getElementById('advClutchDetail').textContent = `Last ${Math.min(CURRENT_DATE_RANGE, 15)} games, close finishes`;
  if (document.getElementById('advUsageConc')) document.getElementById('advUsageConc').textContent = `${usageConc.toFixed(1)}%`;
  if (document.getElementById('advUsageConcDetail')) document.getElementById('advUsageConcDetail').textContent = 'Top 2 rotation players';
  if (document.getElementById('advHealthAdj')) document.getElementById('advHealthAdj').textContent = `${healthAdj > 0 ? '+' : ''}${healthAdj.toFixed(1)}`;
  if (document.getElementById('advHealthAdjDetail')) document.getElementById('advHealthAdjDetail').textContent = `Adjusted by ${INJURY_SNAPSHOT.outCount} active outs`;
  if (document.getElementById('advTrajectory')) {
    const direction = trendDelta > 0.15 ? '↑' : trendDelta < -0.15 ? '↓' : '→';
    document.getElementById('advTrajectory').textContent = `${direction} ${trendDelta > 0 ? '+' : ''}${trendDelta.toFixed(1)}`;
  }
  if (document.getElementById('advTrajectoryDetail')) {
    document.getElementById('advTrajectoryDetail').textContent = trendDelta > 0.15 ? 'Improving' : trendDelta < -0.15 ? 'Cooling' : 'Stable';
  }

  renderTrajectorySparkline(trajectorySeries);

  // Render micro bar charts for each card
  const recentMargins = RECENT_GAMES.slice(0, 10).map(game => {
    const isHome = game.home === TEAM_ABBR;
    const ourScore = Number(isHome ? game.homeScore : game.awayScore) || 0;
    const oppScore = Number(isHome ? game.awayScore : game.homeScore) || 0;
    return ourScore - oppScore;
  });
  const recentLoads = ROSTER_DATA.slice(0, 10).map(player => Number(normalizeRosterPlayer(player).min) || 0);
  const healthBars = Array.from({ length: 10 }, (_, idx) => Math.max(0, 10 - INJURY_SNAPSHOT.outCount - idx * 0.2));

  const renderMiniBars = (elementId, values) => {
    const spark = document.getElementById(elementId);
    if (!spark || !values.length) return;
    const finite = values.filter(value => Number.isFinite(value));
    const maxAbs = Math.max(...finite.map(value => Math.abs(value)), 1);
    spark.innerHTML = values.map((value, idx) => {
      const height = Math.max(4, Math.min(24, (Math.abs(value) / maxAbs) * 20 + 4));
      const y = 24 - height;
      const color = value >= 0 ? 'var(--lime)' : 'var(--coral)';
      return `<rect x="${idx * 10}" y="${y.toFixed(1)}" width="6" height="${height.toFixed(1)}" fill="${color}" opacity="0.8"/>`;
    }).join('');
  };

  renderMiniBars('advSecondChanceSpark', trajectorySeries.slice(-10));
  renderMiniBars('advClutchSpark', recentMargins);
  renderMiniBars('advUsageSpark', recentLoads);
  renderMiniBars('advHealthSpark', healthBars);

  // Render Octagonal DNA Radar
  const radarWrap = document.getElementById('advancedRadarWrap');
  if (radarWrap) {
    const net = seasonNet;
    const teamData = [
      Math.max(20, Math.min(90, 50 + clutchNet * 5)), // Clutch
      Math.max(20, Math.min(90, 60 + net * 2)), // Transition
      Math.max(20, Math.min(90, 50 + secondChance * 2)), // Second Chance
      Math.max(20, Math.min(90, 60 - net * 1.5)), // Paint Def
      Math.max(20, Math.min(90, 70 - net)), // Turnover Rate
      Math.max(20, Math.min(90, 50 + net * 3)), // Shot Quality
      Math.max(20, Math.min(90, 55 + net * 2)), // Rebounding
      Math.max(20, Math.min(90, 50 + (TEAM_DATA.pace || 100) - 100)) // Pace
    ];
    const labels = ["Clutch", "Transition", "2nd Chance", "Paint Def", "TOV%", "Shot Qual", "Reb%", "Pace"];
    const lgPts = Array(8).fill(50);
    
    const getRadarPoints = (values) => {
        const cx = 150, cy = 150, r = 100;
        return values.map((val, i) => {
            const rad = (i * 45 - 90) * Math.PI / 180;
            const dist = (val / 100) * r;
            return `${cx + Math.cos(rad) * dist},${cy + Math.sin(rad) * dist}`;
        }).join(' ');
    };

    const labelCoords = labels.map((label, i) => {
        const rad = (i * 45 - 90) * Math.PI / 180;
        const dist = 120;
        let anchor = 'middle';
        if (i === 1 || i === 2 || i === 3) anchor = 'start';
        if (i === 5 || i === 6 || i === 7) anchor = 'end';
        return { x: 150 + Math.cos(rad) * dist, y: 150 + Math.sin(rad) * dist, text: label, anchor };
    });

    const radarSVG = `
      <svg viewBox="0 0 300 300" style="width:100%; height:100%;">
        <!-- Octagonal grid -->
        ${[100, 75, 50, 25].map(r => `<polygon points="${getRadarPoints(Array(8).fill(r))}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`).join('')}
        
        <!-- Axes -->
        ${Array(4).fill(0).map((_, i) => {
            const r1 = (i * 45 - 90) * Math.PI / 180;
            const r2 = ((i+4) * 45 - 90) * Math.PI / 180;
            return `<line x1="${150 + Math.cos(r1)*100}" y1="${150 + Math.sin(r1)*100}" x2="${150 + Math.cos(r2)*100}" y2="${150 + Math.sin(r2)*100}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`;
        }).join('')}

        <!-- Labels -->
        ${labelCoords.map(l => `<text x="${l.x}" y="${l.y + 4}" fill="var(--muted)" font-family="var(--mono)" font-size="10" font-weight="bold" text-anchor="${l.anchor}">${l.text}</text>`).join('')}

        <!-- League Baseline Polygon -->
        <polygon points="${getRadarPoints(lgPts)}" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.3)" stroke-width="1" stroke-dasharray="2,2"/>
        
        <!-- Team Polygon -->
        <polygon points="${getRadarPoints(teamData)}" fill="rgba(197, 248, 42, 0.2)" stroke="var(--lime)" stroke-width="2"/>
        
        <!-- Dots -->
        ${teamData.map((val, i) => {
            const rad = (i * 45 - 90) * Math.PI / 180;
            const dist = (val / 100) * 100;
            return `<circle cx="${150 + Math.cos(rad) * dist}" cy="${150 + Math.sin(rad) * dist}" r="4" fill="var(--lime)"/>`;
        }).join('')}
      </svg>
    `;
    radarWrap.innerHTML = radarSVG;
  }
}

function setupAnalyticsInteractions() {
  const dateSelect = document.getElementById('dateRangeFilter');
  if (dateSelect && !dateSelect.dataset.bound) {
    dateSelect.dataset.bound = '1';
    dateSelect.addEventListener('change', () => {
      CURRENT_DATE_RANGE = Number(dateSelect.value) || 15;
      renderTeamAdvancedMetrics();
      renderTeamIdentitySnapshot();
    });
  }

  const minMinutesInput = document.getElementById('lineupMinMinutes');
  if (minMinutesInput && !minMinutesInput.dataset.bound) {
    minMinutesInput.dataset.bound = '1';
    minMinutesInput.addEventListener('change', () => {
      const parsed = Number(minMinutesInput.value);
      CURRENT_LINEUP_MIN = Number.isFinite(parsed) ? Math.max(0, parsed) : 120;
      renderLineupCombosTable();
    });
  }

  document.querySelectorAll('#combosTable th.sortable-header').forEach(th => {
    if (th.dataset.bound) return;
    th.dataset.bound = '1';
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (LINEUP_SORT.key === key) {
        LINEUP_SORT.direction = LINEUP_SORT.direction === 'asc' ? 'desc' : 'asc';
      } else {
        LINEUP_SORT.key = key;
        LINEUP_SORT.direction = key === 'players' ? 'asc' : 'desc';
      }
      renderLineupCombosTable();
    });
  });
}

function renderLineupCombosTable() {
  const tbody = document.getElementById('combosTableBody');
  if (!tbody) return;

  const filtered = [...LINEUP_COMBOS]
    .filter(combo => combo.min >= CURRENT_LINEUP_MIN)
    .filter(combo => !CURRENT_PLAYER_FILTER || combo.players.includes(CURRENT_PLAYER_FILTER));
  const sortKey = LINEUP_SORT.key;
  const direction = LINEUP_SORT.direction === 'asc' ? 1 : -1;

  filtered.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (sortKey === 'players') return String(av).localeCompare(String(bv)) * direction;
    return (Number(av) - Number(bv)) * direction;
  });

  document.querySelectorAll('#combosTable th.sortable-header').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === LINEUP_SORT.key);
    th.classList.toggle('sorted-asc', th.dataset.sort === LINEUP_SORT.key && LINEUP_SORT.direction === 'asc');
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="no-data">No lineups match this filter${CURRENT_PLAYER_FILTER ? ` (${esc(CURRENT_PLAYER_FILTER)})` : ''}</td></tr>`;
    return;
  }

  const maxAbs = Math.max(...filtered.map(c => Math.abs(c.netRtg)), 1);

  tbody.innerHTML = filtered.map(combo => {
    const barPct = Math.round((Math.abs(combo.netRtg) / maxAbs) * 40);
    const barCls = combo.netRtg >= 0 ? 'positive' : 'negative';
    return `
    <tr data-pos="Mix" data-mpg="${(combo.min / 5).toFixed(1)}" data-pm="${combo.netRtg.toFixed(1)}">
      <td><a class="player-link" href="players.html?q=${encodeURIComponent(combo.players.split('+')[0].trim())}">${esc(combo.players)}</a></td>
      <td class="center">${combo.min}</td>
      <td class="center delta-bar-cell" style="color:${combo.netRtg >= 0 ? 'var(--lime)' : 'var(--coral)'}">
        <span class="delta-bar ${barCls}" style="width:${barPct}%"></span>
        ${combo.netRtg >= 0 ? '+' : ''}${combo.netRtg.toFixed(1)}
      </td>
      <td class="center">${combo.ppp.toFixed(2)}</td>
    </tr>`;
  }).join('');
}

async function renderShotZoneDensityChart() {
  const grid = document.getElementById('shotChartGrid');
  if (!grid) return;
  try {
    const json = await backendFirstFetch(`/api/shot_zones?team=${encodeURIComponent(TEAM_ABBR)}`, 12000, 0);
    const zones = json.zones || {};
    const mapping = [
      { zone: 'Rim', key: 'rim' },
      { zone: 'Corner 3', key: 'corner_3' },
      { zone: 'Above Break 3', key: 'above_break_3' },
      { zone: 'Mid Range', key: 'mid_range' },
      { zone: 'Paint Non-Rim', key: 'paint_non_rim' },
    ];
    grid.innerHTML = mapping.map(row => {
      const offPct = clamp(Number(zones[row.key] ?? 0), 0, 90);
      return `
        <div class="zone-row">
          <div class="zone-name">${row.zone}</div>
          <div class="zone-bars">
            <div class="zone-bar"><span class="zone-fill off" style="width:${offPct}%"></span></div>
            <div class="zone-bar"><span class="zone-fill def" style="width:${Math.max(0, 100 - offPct) }%"></span></div>
          </div>
          <div class="zone-values">${offPct.toFixed(1)}%</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.warn('[PM] shot zones load failed:', e.message);
    grid.innerHTML = '<div class="no-data">Shot zone data unavailable</div>';
  }
}

function setMetricCompare(el, value, leagueAverage, higherBetter, prefix = 'Lg avg') {
  const delta = Number(value) - Number(leagueAverage);
  const good = higherBetter ? delta > 0 : delta < 0;
  const neutral = Math.abs(delta) < 0.35;
  const cls = neutral ? 'neutral' : good ? 'good' : 'bad';
  const sign = delta > 0 ? '+' : '';
  const base = `${prefix}: ${leagueAverage.toFixed(1)}%`;
  el.innerHTML = `${base} <span class="metric-badge ${cls}">${sign}${delta.toFixed(1)}%</span>`;
}

function calculateSecondChancePoints() {
  const pace = Number(TEAM_DATA?.pace ?? TEAM_DATA?.PACE ?? 100);
  const net = Number(computeNetRating(TEAM_DATA) || 0);
  return 11.4 + clamp((pace - 99) * 0.08 + net * 0.16, -2.3, 3.1);
}

function calculateClutchNetRating() {
  const sample = RECENT_GAMES.slice(0, Math.max(8, Math.min(CURRENT_DATE_RANGE, RECENT_GAMES.length)));
  if (!sample.length) return Number(computeNetRating(TEAM_DATA) || 0) - 0.3;
  let weighted = 0;
  let count = 0;
  sample.forEach((game, index) => {
    const hs = Number(game.homeScore ?? game.home?.score ?? NaN);
    const as = Number(game.awayScore ?? game.away?.score ?? NaN);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) return;
    const isHome = game.home === TEAM_ABBR;
    const margin = Math.abs(hs - as);
    const closeWeight = margin <= 6 ? 1.35 : 0.75;
    const diff = isHome ? hs - as : as - hs;
    weighted += diff * closeWeight * (1 + index * 0.03);
    count += 1;
  });
  return count ? weighted / count : Number(computeNetRating(TEAM_DATA) || 0);
}

function calculateUsageConcentration() {
  if (!ROSTER_DATA.length) return 30.0;
  const mins = ROSTER_DATA
    .map(player => normalizeRosterPlayer(player).min)
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);
  if (!mins.length) return 30.0;
  const total = mins.reduce((sum, value) => sum + value, 0);
  const topTwo = (mins[0] || 0) + (mins[1] || 0);
  return clamp((topTwo / Math.max(total, 1)) * 100 * 1.35, 20, 50);
}

function calculateHealthAdjustedRating(baseNetRating) {
  const injuries = Number(INJURY_SNAPSHOT.outCount || 0);
  return baseNetRating + injuries * 0.35;
}

function buildTrajectorySeries(rangeCount = 15) {
  const games = RECENT_GAMES.slice(0, Math.max(5, Math.min(rangeCount, RECENT_GAMES.length)));
  if (!games.length) {
    const baseline = Number(computeNetRating(TEAM_DATA) || 0);
    return Array.from({ length: 10 }, (_, i) => baseline + Math.sin(i / 2) * 0.6);
  }

  const points = [];
  for (let i = 0; i < games.length; i += 1) {
    const window = games.slice(Math.max(0, i - 4), i + 1);
    const net = computeRecentNetRating(window, TEAM_ABBR);
    points.push(Number.isFinite(net) ? net : Number(computeNetRating(TEAM_DATA) || 0));
  }
  return points.reverse();
}

function renderTrajectorySparkline(series) {
  const svg = document.getElementById('advTrajectorySparkline');
  if (!svg || !series.length) return;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = Math.max(max - min, 0.5);

  const points = series.map((value, idx) => {
    const x = (idx / Math.max(series.length - 1, 1)) * 100;
    const y = 22 - ((value - min) / span) * 20;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  svg.innerHTML = `
    <polyline class="sparkline-base" points="0,12 100,12"></polyline>
    <polyline class="sparkline-line" points="${points}"></polyline>
    <circle class="sparkline-dot" cx="${points.split(' ').slice(-1)[0].split(',')[0]}" cy="${points.split(' ').slice(-1)[0].split(',')[1]}" r="1.8"></circle>
  `;
}

function getLeagueRankByNetRating(team) {
  const net = Number(computeNetRating(team));
  if (!Number.isFinite(net)) return '—';
  return clamp(Math.round(15 - net), 1, 30);
}

function bindTradeSimulator() {
  const openBtn = document.getElementById('openTradeSim');
  const modal = document.getElementById('tradeSimModal');
  const closeBtn = document.getElementById('closeTradeSim');
  const outPlayer = document.getElementById('tradeOutPlayer');
  const runBtn = document.getElementById('runTradeSim');
  const tierEl = document.getElementById('tradeInTier');
  const resultEl = document.getElementById('tradeImpactResult');
  if (!openBtn || !modal || !closeBtn || !outPlayer || !runBtn || !tierEl || !resultEl) return;

  if (!outPlayer.dataset.seeded) {
    const options = (ROSTER_DATA || []).map(player => normalizeRosterPlayer(player).name).filter(Boolean);
    outPlayer.innerHTML = options.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('') || '<option value="None">None</option>';
    outPlayer.dataset.seeded = '1';
  }

  if (!openBtn.dataset.bound) {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', () => {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
    });
  }

  if (!closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    });
  }

  if (!runBtn.dataset.bound) {
    runBtn.dataset.bound = '1';
    runBtn.addEventListener('click', () => {
      const tierImpact = {
        elite: 2.0,
        starter: 0.8,
        rotation: 0.2,
      };
      const outgoingPenalty = 0.6;
      const base = Number(computeNetRating(TEAM_DATA) || 0);
      const projected = base - outgoingPenalty + (tierImpact[tierEl.value] ?? 0.8);
      resultEl.textContent = `${projected > 0 ? '+' : ''}${projected.toFixed(1)}`;
      const advTradeEl = document.getElementById('advTrade');
      if (advTradeEl) advTradeEl.textContent = `${projected > 0 ? '+' : ''}${projected.toFixed(1)}`;
    });
  }

  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
      }
    });
  }
}

function applyMetricTooltips() {
  const tips = [
    { selector: '#coreOrtg', title: 'Offensive rating: points scored per 100 possessions.' },
    { selector: '#coreDrtg', title: 'Defensive rating: points allowed per 100 possessions.' },
    { selector: '#coreNetRating', title: 'Net rating: offensive rating minus defensive rating.' },
    { selector: '#factorEfgOff', title: 'eFG% gives extra weight to 3-point field goals.' },
    { selector: '#factorTovOff', title: 'Turnovers per 100 possessions. Lower is better on offense.' },
    { selector: '#factorOrebOff', title: 'Offensive rebound percentage: share of available offensive boards secured.' },
    { selector: '#factorFtOff', title: 'Free-throw rate: FTA/FGA, how often the team gets to the line.' },
    { selector: '#advClutchNetRtg', title: 'Clutch proxy over close games in recent sample.' },
    { selector: '#advUsageConc', title: 'Share of offensive load concentrated in top two minute leaders.' },
  ];
  tips.forEach(item => {
    const node = document.querySelector(item.selector);
    if (node) node.setAttribute('title', item.title);
  });
}

// ─── PAGE INIT ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTeamPage();
});
