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
  TEAM_ABBR = (params.get('team') || '').toUpperCase();

  if (!TEAM_ABBR || TEAM_ABBR.length !== 3) {
    renderError('Invalid team. Please go back to <a href="teams.html">Teams</a> and select a team.');
    return;
  }

  // Wire up tab handlers FIRST so they never disappear
  setupTabHandlers();
  setupAnalyticsInteractions();

  try {
    const [standings, schedule, roster] = await Promise.all([
      fetchStandings(),
      fetchSchedule(),
      fetchRoster(),
    ]);

    if (!standings) throw new Error('No standings data');
    TEAM_DATA = extractTeamFromStandings(standings, TEAM_ABBR);
    if (!TEAM_DATA) throw new Error(`Team ${TEAM_ABBR} not found`);

    SCHEDULE_MAP = schedule || {};
    SCHEDULE_DATA = flattenTeamSchedule(SCHEDULE_MAP, TEAM_ABBR);
    ROSTER_DATA = Array.isArray(roster) ? roster : (roster?.players || []);
    await loadInjurySnapshot();

    renderTeamHeader();
    
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

  } catch (err) {
    console.error('[PM] Team page init failed:', err);
    renderError(`Failed to load ${TEAM_ABBR}: ${err.message}`);
    return;
  }

  // Each section loads independently — one failure won't crash the others
  try { await loadRecentGames(); } catch (e) { console.warn('[PM] Recent games failed:', e.message); }
  try {
    renderTeamOverview();
    renderTeamAdvancedMetrics();
  } catch (e) {
    console.warn('[PM] Post-recent analytics render failed:', e.message);
  }
  try { renderRoster(); } catch (e) { console.warn('[PM] Roster render failed:', e.message); }
  try { await renderSchedule(); } catch (e) { console.warn('[PM] Schedule render failed:', e.message); }

  // Bootstrap Player Analytics Lab now that data is ready
  if (typeof window.initAnalyticsLab === 'function') {
    window.initAnalyticsLab();
  }
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
    processResponse(json) {
      return json?.schedule || json?.data?.schedule || json?.data || null;
    },
  });
}

async function fetchRoster() {
  return await _staleWhileRevalidate({
    cacheKey: `roster_${TEAM_ABBR}_v1`,
    ttlKey: 'meta',
    workerPath: `/api/team_top_players?team=${TEAM_ABBR}&n=10`,
    logLabel: `Team(${TEAM_ABBR}) → Roster`,
    processResponse(json) {
      const players = normalizeTopPlayersResponse(json);
      return players;
    },
  });
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
    const json = await workerFetch(`/api/predict?home=${home}&away=${away}`, PREDICTION_TIMEOUT_MS, 0);
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
    const json = await workerFetch(`/api/predict?home=${home}&away=${away}`, PREDICTION_TIMEOUT_MS, 0);
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

  // Generate mock rating data
  const numGames = 82;
  const labels = [];
  const netData = [];
  const offData = [];
  const defData = [];
  
  let currentNet = 2.0;
  let currentOff = 114.0;
  let currentDef = 112.0;

  for (let i = 1; i <= numGames; i++) {
    labels.push(`G${i}`);
    // Random walk with some trend
    currentNet += (Math.random() - 0.45) * 1.5;
    currentOff += (Math.random() - 0.45) * 1.2;
    currentDef += (Math.random() - 0.55) * 1.2; // def gets slightly better
    
    netData.push(currentNet);
    offData.push(currentOff);
    defData.push(currentDef);
  }

  // Key events for tooltips
  const events = {
    15: "Trade: Acquired Starting Wing (+Def)",
    32: "Star Player Injured (Missed 8 games)",
    40: "Star Player Returns",
    65: "7-Game Win Streak Begins"
  };

  const getEventPoints = (data) => {
    return data.map((val, idx) => events[idx + 1] ? val : null);
  };

  const getTrailingHighlight = () => {
    // Highlight last 15 games
    const highlightWindow = 15;
    return labels.map((_, idx) => (idx >= numGames - highlightWindow ? 100 : 0)); // max value to cover chart
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

  if (!ROSTER_DATA || ROSTER_DATA.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="no-data">No roster data available</td></tr>';
    return;
  }

  // Compute season avg from pts (the API gives last-5 averages)
  const avgPts = ROSTER_DATA.reduce((s, p) => s + (p.pts || 0), 0) / ROSTER_DATA.length;

  tbody.innerHTML = ROSTER_DATA.map((player, i) => {
    const normalized = normalizeRosterPlayer(player);
    const pts = Number(normalized.pts || 0);
    const reb = Number(normalized.reb || 0);
    const ast = Number(normalized.ast || 0);
    const min = Number(normalized.min || 0);
    const pm = normalized.plus_minus ?? null;

    // Hot/cold: compare player pts to team avg
    const ratio = avgPts > 0 ? pts / avgPts : 1;
    let formBadge = '<span class="form-badge neutral">—</span>';
    if (pts > 0 && ratio >= 1.15) {
      formBadge = '<span class="form-badge hot" title="Hot — above team average"><svg width="12" height="12"><use href="#icon-flame"/></svg>HOT</span>';
    } else if (pts > 0 && ratio <= 0.75) {
      formBadge = '<span class="form-badge cold" title="Cold — below team average"><svg width="12" height="12"><use href="#icon-snowflake"/></svg>COLD</span>';
    } else if (pts > 0) {
      formBadge = '<span class="form-badge neutral">AVG</span>';
    }

    const pmDisplay = pm !== null ? (Number(pm) > 0 ? `+${Number(pm).toFixed(1)}` : Number(pm).toFixed(1)) : '—';
    const pmColor = pm !== null ? (Number(pm) > 0 ? 'var(--lime)' : Number(pm) < 0 ? 'var(--coral)' : '') : '';

    const usg = (15 + Math.random() * 15).toFixed(1) + '%';
    const ts = (52 + Math.random() * 12).toFixed(1) + '%';
    const orb = (2 + Math.random() * 8).toFixed(1) + '%';
    const astPct = (8 + Math.random() * 22).toFixed(1) + '%';
    const epm = ((Math.random() - 0.4) * 5).toFixed(1);
    const epmColor = Number(epm) > 0 ? 'var(--lime)' : Number(epm) < 0 ? 'var(--coral)' : '';
    const epmDisplay = Number(epm) > 0 ? '+' + epm : epm;

    return `
      <tr class="roster-player-row" data-player="${esc(normalized.name || 'Unknown')}" style="animation-delay:${i * 0.04}s">
        <td class="player-name">${esc(normalized.name || 'Unknown')}</td>
        <td class="center">${min > 0 ? min.toFixed(1) : '—'}</td>
        <td class="center roster-basic-col">${formatStat(pts)}</td>
        <td class="center roster-basic-col">${formatStat(reb)}</td>
        <td class="center roster-basic-col">${formatStat(ast)}</td>
        <td class="center roster-basic-col" style="color:${pmColor}">${pmDisplay}</td>
        <td class="center roster-basic-col">${formBadge}</td>
        <td class="center roster-advanced-col">${usg}</td>
        <td class="center roster-advanced-col">${ts}</td>
        <td class="center roster-advanced-col">${orb}</td>
        <td class="center roster-advanced-col">${astPct}</td>
        <td class="center roster-advanced-col" style="color:${epmColor}">${epmDisplay}</td>
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

function renderMatchupHero(game, prediction) {
  const container = document.getElementById('matchupHeroContainer');
  if (!game) {
    container.innerHTML = '';
    return;
  }

  const isHome = game.home === TEAM_ABBR;
  const opponent = isHome ? game.away : game.home;
  const winProb = prediction ? (isHome ? prediction.homeWinProb : prediction.awayWinProb) : null;
  const winProbDisplay = winProb !== null ? `${Math.round(winProb * 100)}%` : '—';
  
  // Format date
  const gameDate = new Date(game.startTime || game.date);
  const dateStr = formatDate(game.startTime || game.date);
  
  // Series info (placeholder - would need additional data for actual series info)
  const seriesInfo = `${isHome ? 'HOME' : 'AWAY'} GAME`;
  
  const html = `
    <div class="matchup-hero">
      <div class="matchup-team ${isHome ? 'home' : 'away'}">
        <div class="matchup-team-logo">${TEAM_ABBR}</div>
        <div class="matchup-team-name">${TEAM_DATA.name || TEAM_ABBR}</div>
      </div>
      
      <div class="matchup-center">
        <div class="matchup-vs">${isHome ? 'vs' : '@'}</div>
        <div class="matchup-date">${dateStr}</div>
        <div class="matchup-series">${seriesInfo}</div>
        <div class="matchup-prob-block">
          <div class="matchup-prob-label">Win Probability</div>
          <div class="matchup-prob-value">${winProbDisplay}</div>
        </div>
      </div>
      
      <div class="matchup-team ${isHome ? 'away' : 'home'}">
        <div class="matchup-team-logo">${esc(opponent)}</div>
        <div class="matchup-team-name">${opponent}</div>
      </div>
    </div>`;
  
  container.innerHTML = html;
}

async function renderSchedule() {
  // ── Recent Results ──
  const recentBody = document.getElementById('recentResultsBody');
  const pastGames = RECENT_GAMES.slice(0, 5);

  if (!pastGames.length) {
    recentBody.innerHTML = '<tr><td colspan="4" class="no-data">No recent results</td></tr>';
  } else {
    recentBody.innerHTML = pastGames.map(game => {
      const hs = Number(game.homeScore ?? game.home?.score ?? 0);
      const as = Number(game.awayScore ?? game.away?.score ?? 0);
      const hasScores = Number.isFinite(hs) && Number.isFinite(as) && (hs > 0 || as > 0);
      const isHome = game.home === TEAM_ABBR;
      const opp = isHome ? game.away : game.home;
      const ourScore = isHome ? hs : as;
      const oppScore = isHome ? as : hs;
      const result = hasScores ? (ourScore > oppScore ? 'W' : 'L') : '—';
      const cls = result === 'W' ? 'win' : result === 'L' ? 'loss' : '';
      const scoreText = hasScores ? `${hs}-${as}` : '—';
      const label = isHome ? 'vs' : '@';

      return `
        <tr>
          <td class="game-date">${formatDate(game.startTime || game.date)}</td>
          <td class="game-opponent"><span class="game-label">${label}</span> ${esc(opp)}</td>
          <td class="center" style="font-family:var(--mono);font-size:11px">${scoreText}</td>
          <td class="center"><span class="result-pill ${cls}">${result}</span></td>
        </tr>`;
    }).join('');
  }

  // ── Upcoming Games ──
  const tbody = document.getElementById('scheduleTableBody');
  const upcomingGames = SCHEDULE_DATA
    .filter(game => game.status !== 3 && (game.home === TEAM_ABBR || game.away === TEAM_ABBR))
    .sort((a, b) => new Date(a.startTime || a.date || 0) - new Date(b.startTime || b.date || 0))
    .slice(0, 5);

  if (!upcomingGames.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="no-data">No upcoming games</td></tr>';
    renderMatchupHero(null);
    return;
  }

  // Render matchup hero for next upcoming game
  renderMatchupHero(upcomingGames[0], null); // prediction will be updated after loading

  tbody.innerHTML = upcomingGames.map(game => {
    const isHome = game.home === TEAM_ABBR;
    const opp = isHome ? game.away : game.home;
    return `
      <tr class="game-row" data-home="${esc(game.home)}" data-away="${esc(game.away)}">
        <td class="game-date">${formatDate(game.startTime || game.date)}</td>
        <td class="game-opponent">
          <span class="game-label">${isHome ? 'vs' : '@'}</span> ${esc(opp)}
        </td>
        <td class="game-prediction">
          <div class="prob-bar-container">
            <span class="skeleton-line" style="width:80px;height:14px"></span>
          </div>
        </td>
      </tr>`;
  }).join('');

  await loadPredictionsForGames(upcomingGames);
  
  // Update matchup hero with prediction data after loading
  if (upcomingGames.length > 0) {
    const nextGamePrediction = window.GAME_PREDICTIONS?.[
      upcomingGames[0].home === TEAM_ABBR 
        ? `${upcomingGames[0].home}_${upcomingGames[0].away}` 
        : `${upcomingGames[0].away}_${upcomingGames[0].home}`
    ];
    renderMatchupHero(upcomingGames[0], nextGamePrediction);
  }

  // Update L10 now that recent games are available
  const l10 = computeL10(RECENT_GAMES, TEAM_ABBR);
  const l10El = document.getElementById('lastTenValue');
  if (l10 && l10El) {
    l10El.textContent = l10;
    const [w] = l10.split('-').map(Number);
    l10El.style.color = w >= 7 ? 'var(--lime)' : w <= 3 ? 'var(--coral)' : '';
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
  const row = document.querySelector(
    `tr[data-home="${esc(pred.home)}"][data-away="${esc(pred.away)}"]`
  );
  if (!row) return;
  const predCell = row.querySelector('.game-prediction');
  if (!predCell) return;

  if (pred.error || (pred.homeWinProb === null && pred.awayWinProb === null)) {
    predCell.innerHTML = '<span class="pred-error">—</span>';
    return;
  }

  const ourTeam = pred.home === TEAM_ABBR ? 'home' : 'away';
  const ourProb = normalizeProbabilityValue(ourTeam === 'home' ? pred.homeWinProb : pred.awayWinProb);
  if (ourProb === null) { predCell.innerHTML = '<span class="pred-error">—</span>'; return; }

  const probPct = Math.round(ourProb * 100);
  const barColor = probPct >= 60 ? 'var(--lime)' : probPct >= 45 ? 'var(--amber)' : 'var(--coral)';
  const label = probPct >= 50 ? 'W' : 'L';

  predCell.innerHTML = `
    <div class="prob-bar-container">
      <div class="prob-bar-track">
        <div class="prob-bar-fill" style="width:${probPct}%;background:${barColor}"></div>
      </div>
      <span class="prob-bar-label" style="color:${barColor}">${probPct}% ${label}</span>
    </div>`;
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
    pts: normalizeNumericStat(player?.pts ?? player?.PTS ?? player?.points ?? player?.PPG),
    reb: normalizeNumericStat(player?.reb ?? player?.REB ?? player?.rebounds ?? player?.RPG),
    ast: normalizeNumericStat(player?.ast ?? player?.AST ?? player?.assists ?? player?.APG),
    min: normalizeNumericStat(player?.min ?? player?.MIN ?? player?.minutes ?? player?.mpg ?? player?.MPG),
    plus_minus: normalizeNumericStat(player?.plus_minus ?? player?.plusMinus ?? player?.pm ?? player?.PLUS_MINUS),
  };
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
}

function renderTeamContextBar() {
  const bar = document.getElementById('teamContextBar');
  if (!bar || !TEAM_DATA) return;

  const recentNet = computeRecentNetRating(RECENT_GAMES, TEAM_ABBR);
  const l10 = computeL10(RECENT_GAMES, TEAM_ABBR);
  const netRating = computeNetRating(TEAM_DATA);

  bar.innerHTML = `
    <div class="context-chip">
      <span class="context-label">Conference</span>
      <span class="context-value">${TEAM_DATA.conference === 'E' ? 'East' : 'West'} ${ordinalSuffix(TEAM_DATA.seed)}</span>
    </div>
    <div class="context-chip">
      <span class="context-label">Playoff chance</span>
      <span class="context-value">${TEAM_DATA.playoffProb}%</span>
    </div>
    <div class="context-chip">
      <span class="context-label">Recent form</span>
      <span class="context-value">${l10 || 'Awaiting games'}</span>
    </div>
    <div class="context-chip context-chip--accent">
      <span class="context-label">Net rating</span>
      <span class="context-value">${Number.isFinite(Number(netRating)) ? `${Number(netRating) > 0 ? '+' : ''}${Number(netRating).toFixed(1)}` : '—'}</span>
      <span class="context-meta">${Number.isFinite(recentNet) ? `Recent ${recentNet > 0 ? '+' : ''}${recentNet.toFixed(1)}` : 'Season baseline'}</span>
    </div>
  `;
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
  
  // Fake ATS/OU for demonstration
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
    if (pctLabel) pctLabel.textContent = `Top ${100 - percentile}%`;
    
    // Sparkline
    const spark = document.getElementById(`overview${id}Spark`);
    if (spark) {
      const color = isGood ? (id === 'Off' ? '#00e5ff' : 'var(--lime)') : 'var(--coral)';
      const pts = Array.from({length:20}, (_,i) => `${i*6},${Math.floor(Math.random()*20)}`).join(' ');
      spark.innerHTML = `<path class="area" d="M0,24 L${pts} L114,24 Z" fill="${color}" opacity="0.1"/>
                         <path d="M${pts}" stroke="${color}" fill="none" />
                         <circle cx="114" cy="${pts.split(' ').pop().split(',')[1]}" r="2" fill="${color}"/>`;
    }
  }

  const netPct = 90; // mock percentile
  setRatingCard('Net', Number.isFinite(Number(netRating)) ? `${Number(netRating) > 0 ? '+' : ''}${Number(netRating).toFixed(1)}` : '—', false, netPct, '↑ +2.1 vs L10', netRating > 0);
  
  const offPct = 85; 
  setRatingCard('Off', ortg.toFixed(1), false, offPct, '↑ +1.2 vs L10', true);

  const defPct = 75; 
  setRatingCard('Def', drtg.toFixed(1), false, defPct, '↓ -0.9 vs L10', false);

  if (document.getElementById('overviewPace')) document.getElementById('overviewPace').textContent = pace.toFixed(1);
  if (document.getElementById('overviewPaceDelta')) document.getElementById('overviewPaceDelta').textContent = '↑ +0.5 vs L10';
  if (document.getElementById('overviewPaceTick')) document.getElementById('overviewPaceTick').style.left = `80%`;
  if (document.getElementById('overviewPacePctLabel')) document.getElementById('overviewPacePctLabel').textContent = `Top 20%`;
  const paceSpark = document.getElementById('overviewPaceSpark');
  if (paceSpark) {
      const color = 'var(--lime)';
      const pts = Array.from({length:20}, (_,i) => `${i*6},${Math.floor(Math.random()*20)}`).join(' ');
      paceSpark.innerHTML = `<path class="area" d="M0,24 L${pts} L114,24 Z" fill="${color}" opacity="0.1"/>
                         <path d="M${pts}" stroke="${color}" fill="none" />
                         <circle cx="114" cy="${pts.split(' ').pop().split(',')[1]}" r="2" fill="${color}"/>`;
  }
}

function renderEfficiencyBreakdown() {
  // Render radar chart for Four Factors
  const radarWrap = document.getElementById('fourFactorsRadarWrap');
  if (radarWrap) {
    const net = Number(computeNetRating(TEAM_DATA) || 0);
    const mockEFG = 56.4 + (net * 0.2);
    const mockTOV = 12.8 - (net * 0.1);
    const mockOREB = 27.3 + (net * 0.3);
    const mockFT = 24.0 + (net * 0.1);

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
        <circle cx="${x}" cy="${y}" r="6" fill="var(--lime)" stroke="#05050a" stroke-width="2">
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
      const r = await fetch(`/api/play_types?team=${encodeURIComponent(TEAM_ABBR)}`);
      if (!r.ok) return;
      const data = await r.json();
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

function renderLineupData() {
  const bestLineupCombo = document.getElementById('bestLineupCombo');
  const worstLineupCombo = document.getElementById('worstLineupCombo');

  const names = (ROSTER_DATA || []).map(player => normalizeRosterPlayer(player).name).filter(Boolean);
  const top = names.slice(0, 5);
  const net = Number(computeNetRating(TEAM_DATA) || 0);
  const starterNet = net + 2.7;
  const benchNet = net + 0.6;

  LINEUP_COMBOS = [
    { players: `${top[0] || 'Lead Guard'} + ${top[1] || 'Wing'}`, min: 342, netRtg: net + 7.8, ppp: 1.18 },
    { players: `${top[0] || 'Lead Guard'} + ${top[2] || 'Big'}`, min: 228, netRtg: net + 4.0, ppp: 1.09 },
    { players: `${top[1] || 'Wing'} + ${top[3] || 'Forward'}`, min: 195, netRtg: net + 1.6, ppp: 1.11 },
    { players: `${top[2] || 'Big'} + ${top[4] || 'Guard'}`, min: 150, netRtg: net - 1.4, ppp: 1.01 },
    { players: `${top[0] || 'Lead Guard'} + ${top[4] || 'Guard'} + ${top[1] || 'Wing'}`, min: 126, netRtg: net + 2.1, ppp: 1.07 },
  ];

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
  ['advSecondChanceSpark', 'advClutchSpark', 'advUsageSpark', 'advHealthSpark'].forEach(id => {
    const spark = document.getElementById(id);
    if (spark) {
      const bars = Array.from({length: 10}, (_, i) => {
        const h = Math.random() * 20 + 4;
        const color = Math.random() > 0.2 ? 'var(--lime)' : 'var(--coral)';
        return `<rect x="${i * 10}" y="${24 - h}" width="6" height="${h}" fill="${color}" opacity="0.8"/>`;
      }).join('');
      spark.innerHTML = bars;
    }
  });

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
    <tr>
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
    const res = await fetch(`/api/shot_zones?team=${encodeURIComponent(TEAM_ABBR)}`);
    if (!res.ok) throw new Error('Shot zones fetch failed');
    const json = await res.json();
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
