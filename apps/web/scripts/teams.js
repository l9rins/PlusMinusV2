/**
 * teams.js — NBA Teams Index Page
 * Plus-Minus NBA Intelligence Platform
 * 
 * Fetches standings, renders 30-team grid with playoff probability,
 * conference filtering, and sortable columns.
 */

// ─────────────────────────────────────────────────────────────────────────────
// STATE & CONFIG
// ─────────────────────────────────────────────────────────────────────────────
let TEAMS_DATA = [];
let META_DATA = {};
let CURRENT_FILTER = 'all';
let CURRENT_SORT = 'playoff_prob';

const TEAM_LOGO_IDS = {
  ATL: 1610612737,
  BOS: 1610612738,
  BKN: 1610612751,
  BRK: 1610612751,
  CHA: 1610612766,
  CHI: 1610612741,
  CLE: 1610612739,
  DAL: 1610612742,
  DEN: 1610612743,
  DET: 1610612765,
  GSW: 1610612744,
  GS: 1610612744,
  HOU: 1610612745,
  IND: 1610612754,
  LAC: 1610612746,
  LAL: 1610612747,
  MEM: 1610612763,
  MIA: 1610612748,
  MIL: 1610612749,
  MIN: 1610612750,
  NOP: 1610612740,
  NO: 1610612740,
  NYK: 1610612752,
  NY: 1610612752,
  OKC: 1610612760,
  ORL: 1610612753,
  PHI: 1610612755,
  PHX: 1610612756,
  POR: 1610612757,
  SAC: 1610612758,
  SAS: 1610612759,
  SA: 1610612759,
  TOR: 1610612761,
  UTA: 1610612762,
  UTAH: 1610612762,
  WAS: 1610612764,
  WSH: 1610612764,
};

const SKELETON_CARD_COUNT = 6;
const SKELETON_HTML = Array(SKELETON_CARD_COUNT).fill(`
  <div class="team-card skeleton">
    <div class="skeleton-line" style="width:40%;height:20px;margin-bottom:12px"></div>
    <div class="skeleton-line" style="width:100%;height:14px;margin-bottom:8px"></div>
    <div class="skeleton-line" style="width:80%;height:14px;margin-bottom:8px"></div>
    <div class="skeleton-line" style="width:60%;height:14px"></div>
  </div>
`).join('');

// ─────────────────────────────────────────────────────────────────────────────
// DATA FETCH & PROCESSING
// ─────────────────────────────────────────────────────────────────────────────
async function initTeamsPage() {
  // Show skeleton immediately
  const grid = document.getElementById('teamsGrid');
  grid.innerHTML = SKELETON_HTML;

  try {
    // Parallel fetch: standings + meta
    const [standings, meta] = await Promise.all([
      fetchStandings(),
      fetchMeta(),
    ]);

    if (!standings) {
      grid.innerHTML = '<div class="error-state">Unable to load standings. Please refresh.</div>';
      return;
    }

    // Flatten standings into single array with team metadata
    TEAMS_DATA = flattenStandings(standings, meta);
    META_DATA = meta || {};

    // Update data freshness badge
    updateStandingsBadge();

    // Render the grid (filtered + sorted)
    applyFiltersAndRender();

    // Set up event listeners
    setupEventListeners();

  } catch (err) {
    console.error('[PM] Teams page init failed:', err);
    grid.innerHTML = '<div class="error-state">Error loading teams. Please try again.</div>';
  }
}

/**
 * Flatten {east: [...], west: [...]} into single array with seed info
 */
function flattenStandings(standings, meta) {
  const result = [];
  
  ['east', 'west'].forEach(conf => {
    const teams = standings[conf] || [];
    teams.forEach((team, idx) => {
      const seed = idx + 1;
      const playoffProb = parsePlayoffProbability(team);
      
      result.push({
        abbr: team.abbr || '???',
        name: team.name || team.team || team.teamName || team.fullName || 'Unknown',
        seed: seed,
        conference: conf === 'east' ? 'E' : 'W',
        w: team.w || 0,
        l: team.l || 0,
        pct: team.pct || '.000',
        streak: team.streak || team.strk || team.Streak || 'N/A',
        playoffProb: playoffProb,
        color: team.color || META_DATA[team.abbr]?.color || '#888888',
      });
    });
  });
  
  return result;
}

/**
 * Extract playoff probability heuristic from team object
 * Expected format: team.playoffProb might be a number (0-1) or
 * the result of seed+GB based heuristic (via backend)
 */
function parsePlayoffProbability(team) {
  if (team.seed) {
    const seed = Number(team.seed);
    if (seed <= 6) {
      const values = [99, 98, 96, 94, 93, 92];
      return values[seed - 1] ?? 92;
    }
    if (seed <= 10) {
      const values = [75, 58, 38, 25];
      return values[seed - 7] ?? 25;
    }
    if (seed <= 15) {
      const values = [20, 16, 12, 7, 1];
      return values[seed - 11] ?? 1;
    }
  }
  return 50; // Default
}

async function fetchStandings() {
  return await _staleWhileRevalidate({
    cacheKey: 'standings',
    ttlKey: 'standings',
    workerPath: '/api/standings',
    logLabel: 'Teams → Standings',
    processResponse(json) {
      return json?.data || null;
    },
  });
}

async function fetchMeta() {
  return await _staleWhileRevalidate({
    cacheKey: 'meta',
    ttlKey: 'meta',
    workerPath: '/api/meta',
    logLabel: 'Teams → Meta',
    processResponse(json) {
      return json?.data || {};
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTERING & SORTING
// ─────────────────────────────────────────────────────────────────────────────
function applyFiltersAndRender() {
  let filtered = TEAMS_DATA;

  // Apply conference filter
  if (CURRENT_FILTER !== 'all') {
    const confLetter = CURRENT_FILTER === 'east' ? 'E' : 'W';
    filtered = filtered.filter(t => t.conference === confLetter);
  }

  // Apply sort
  filtered = sortTeams(filtered, CURRENT_SORT);

  // Render
  renderTeamsGrid(filtered);
  renderTeamsSummary(filtered);
}

function sortTeams(teams, sortKey) {
  const sorted = [...teams];
  
  switch (sortKey) {
    case 'playoff_prob':
      // Descending: highest playoff prob first
      sorted.sort((a, b) => b.playoffProb - a.playoffProb);
      break;
    case 'wins':
      // Descending: most wins first
      sorted.sort((a, b) => b.w - a.w);
      break;
    case 'record':
      // Ascending: seed 1-15 order (playoff seeds)
      sorted.sort((a, b) => a.seed - b.seed);
      break;
  }
  
  return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING
// ─────────────────────────────────────────────────────────────────────────────
function renderTeamsGrid(teams) {
  const grid = document.getElementById('teamsGrid');
  
  if (!teams || teams.length === 0) {
    grid.innerHTML = '<div class="empty-state">No teams match your filters</div>';
    return;
  }

  const html = teams.map(team => renderTeamCard(team)).join('');
  grid.innerHTML = html;
  
  // Fade in
  grid.style.opacity = '0';
  grid.offsetHeight; // Force reflow
  grid.style.transition = 'opacity 0.3s ease-in';
  grid.style.opacity = '1';
}

function renderTeamsSummary(teams) {
  const summary = document.getElementById('teamsSummary');
  if (!summary) return;

  if (!teams || teams.length === 0) {
    summary.innerHTML = '';
    return;
  }

  const topTeam = teams[0];
  const bestOdds = [...teams].sort((a, b) => b.playoffProb - a.playoffProb)[0];
  const avgWins = teams.reduce((sum, team) => sum + (Number(team.w) || 0), 0) / teams.length;
  const avgWinPct = teams.reduce((sum, team) => sum + (Number(team.pct) || 0), 0) / teams.length;

  summary.innerHTML = `
    <div class="summary-card">
      <span class="summary-label">Teams shown</span>
      <span class="summary-value">${teams.length}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">Top result</span>
      <span class="summary-value">${esc(topTeam.abbr)} ${esc(topTeam.seed)}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">Best odds</span>
      <span class="summary-value">${esc(bestOdds.abbr)} ${bestOdds.playoffProb}%</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">Avg wins</span>
      <span class="summary-value">${avgWins.toFixed(1)} / team</span>
    </div>
    <div class="summary-card summary-card--accent">
      <span class="summary-label">Avg win %</span>
      <span class="summary-value">${Math.round(avgWinPct * 100)}%</span>
    </div>
  `;
}

function renderTeamCard(team) {
  const recordStr = `${team.w}-${team.l}`;
  const pctNum = Number(team.pct) || 0;
  const pctDisplay = pctNum > 1 ? pctNum.toFixed(0) + '%' : (pctNum * 100).toFixed(1) + '%';
  const logoUrl = getTeamLogoUrl(team.abbr);
  const conf = team.conference === 'E' ? 'EAST' : 'WEST';
  const prob = team.playoffProb;
  const probColor = prob >= 90 ? 'var(--lime)' : prob >= 60 ? 'var(--blue)' : prob >= 30 ? 'var(--muted)' : 'var(--muted2)';
  const seedLabel = team.seed <= 6 ? 'Playoff' : team.seed <= 10 ? 'Play-In' : 'Lottery';
  const seedColor = team.seed <= 6 ? 'var(--lime)' : team.seed <= 10 ? 'var(--blue)' : 'var(--muted)';
  const winBarPct = Math.round((Number(team.w) / Math.max(Number(team.w) + Number(team.l), 1)) * 100);

  return `
    <a class="team-card" href="team.html?team=${esc(team.abbr)}" style="--card-accent:${esc(team.color)}">
      <div class="tc-accent" style="background:${esc(team.color)}"></div>
      <div class="tc-header">
        <div class="tc-logo-area">
          <div class="tc-logo-wrap">
            <img class="tc-logo" src="${esc(logoUrl)}" alt="${esc(team.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
            <div class="tc-logo-fallback" style="display:none;color:${esc(team.color)}">${esc(team.abbr)}</div>
          </div>
          <div class="tc-identity">
            <div class="tc-abbr" style="color:${esc(team.color)}">${esc(team.abbr)}</div>
            <div class="tc-name">${esc(team.name)}</div>
          </div>
        </div>
        <div class="tc-seed-wrap">
          <span class="tc-seed" style="color:${seedColor}">#${team.seed}</span>
          <span class="tc-conf">${conf}</span>
        </div>
      </div>
      <div class="tc-body">
        <div class="tc-record-row">
          <span class="tc-record">${esc(recordStr)}</span>
          <span class="tc-winpct">${pctDisplay}</span>
        </div>
        <div class="tc-bar-track"><div class="tc-bar-fill" style="width:${winBarPct}%;background:${esc(team.color)}"></div></div>
        <div class="tc-bottom">
          <div class="tc-streak">${esc(team.streak || 'N/A')}</div>
          <div class="tc-playoff">
            <span class="tc-prob-label">${seedLabel}</span>
            <span class="tc-prob-value" style="color:${probColor}">${prob}%</span>
          </div>
        </div>
      </div>
    </a>
  `;
}

function getTeamLogoUrl(abbr) {
  const id = TEAM_LOGO_IDS[String(abbr || '').toUpperCase()];
  return id ? `https://cdn.nba.com/logos/nba/${id}/global/L/logo.svg` : '';
}

/**
 * Format playoff probability with "Est." label
 * Example: "Playoff Est. 78%"
 */
function formatPlayoffEstimate(prob) {
  if (prob >= 90) return `<span style="color:var(--lime)">Playoff Est. ${prob}%</span>`;
  if (prob >= 70) return `<span style="color:var(--amber)">Playoff Est. ${prob}%</span>`;
  if (prob >= 40) return `<span style="color:var(--text)">Playoff Est. ${prob}%</span>`;
  return `<span style="color:var(--muted)">Playoff Est. ${prob}%</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI UPDATES
// ─────────────────────────────────────────────────────────────────────────────
function updateStandingsBadge() {
  const age = PM_CLIENT_CACHE?.age?.('standings');
  const badge = document.getElementById('standingsAge');
  if (age !== null && badge) {
    const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
    badge.textContent = ageStr;
  }
}

function setupEventListeners() {
  // Conference filter
  const conferenceFilter = document.getElementById('conferenceFilter');
  if (conferenceFilter) {
    conferenceFilter.addEventListener('change', (e) => {
      CURRENT_FILTER = e.target.value;
      applyFiltersAndRender();
    });
  }

  // Sort select
  const sortSelect = document.getElementById('sortSelect');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      CURRENT_SORT = e.target.value;
      applyFiltersAndRender();
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE INIT
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTeamsPage();
  
  // Periodic refresh: pull fresh standings every 5 min while page is visible
  visibilityInterval(async () => {
    const standings = await fetchStandings();
    if (standings) {
      TEAMS_DATA = flattenStandings(standings, META_DATA);
      applyFiltersAndRender();
      updateStandingsBadge();
    }
  }, 5 * 60_000);
});
