/**
 * Plus-Minus NBA Intelligence Platform
 * dashboard.js — Core business logic for the main dashboard
 */

const SPARK_VIEWBOX_W = 120; // px — sparkline chart width
const SPARK_VIEWBOX_H = 36;  // px — sparkline chart height
const SEARCH_MAX_RESULTS = 8;
const SKELETON_CARD_COUNT = 4;
const MVP_TOP_N = 3;
const SKELETON_KPI_HTML = Array(SKELETON_CARD_COUNT).fill(`
  <div class="kpi-card">
    <div class="skeleton-line" style="width:60%;margin-bottom:10px"></div>
    <div class="skeleton-line" style="height:26px;width:40%;margin-bottom:8px"></div>
    <div class="skeleton-line" style="width:70%"></div>
  </div>`).join('');



// Helper: get player initials for avatar fallback
function getInitials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// ── GET NBA PLAYER ID ───────────────────────────────────
// Now uses window.PMData.PLAYER_IDS defined in data.js
function getNBAPlayerId(name) {
  return window.PMData?.PLAYER_IDS?.[name] || '0';
}

// ── TAB PILL MOVEMENT ──────────────────────────────────
function movePill(el) {
  const pill = document.getElementById('tabPill');
  if (!pill || !el) return;
  const r = el.getBoundingClientRect(),
    pr = el.parentElement.getBoundingClientRect();
  pill.style.cssText = `left:${r.left - pr.left}px;top:${r.top - pr.top}px;width:${r.width}px;height:${r.height}px`;
}

let _kpiViewAbort = null;

function setDashView(view, tabEl) {
  // ── Tab pill + aria ──────────────────────────────────────
  document.querySelectorAll('.ttab[data-view]').forEach(t => {
    const on = t === tabEl || t.dataset.view === view;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.setAttribute('tabindex', on ? '0' : '-1');
  });
  if (tabEl) movePill(tabEl);

  const kpiRow = document.querySelector('.kpi-row');
  if (!kpiRow) return;

  // Cancel any in-flight async KPI fetch from the previous view
  let cancelled = false;
  if (_kpiViewAbort) { _kpiViewAbort(); }
  _kpiViewAbort = () => { cancelled = true; };

  // ── Static view definitions ──────────────────────────────
  const views = {
    season: {
      cards: [
        { icon: 'bar-chart-2', label: 'SEASON GAMES',   val: '1230', cls: '',      change: 'up',   txt: 'regular season total',  spark: '0,20 20,18 40,14 60,16 80,8 100,12 120,6',  sparkColor: 'rgba(197,248,42,.4)'  },
        { icon: 'target',      label: 'AVG PPG',         val: '113.2', cls: '',     change: 'up',   txt: 'league average',         spark: '0,22 20,20 40,16 60,18 80,12 100,10 120,8',  sparkColor: 'rgba(255,255,255,.2)' },
        { icon: 'trending-up', label: 'PACE',             val: '99.8',  cls: 'lime', change: 'up',   txt: 'possessions / 48 min',   spark: '0,24 20,18 40,20 60,10 80,12 100,6 120,4',  sparkColor: 'rgba(197,248,42,.3)'  },
        { icon: 'zap',         label: 'PLAYOFF SPOTS',   val: '16',    cls: 'amber', change: 'down', txt: '8 per conference',       spark: '0,10 20,18 40,8 60,22 80,14 100,26 120,20', sparkColor: 'rgba(255,179,0,.4)'   },
      ]
    },
    playoffs: {
      cards: [
        { icon: 'trophy',      label: 'ROUNDS LEFT',    val: '3',    cls: 'lime',  change: 'up',   txt: 'to the Finals',          spark: '0,20 20,16 40,12 60,10 80,6 100,4 120,2',   sparkColor: 'rgba(197,248,42,.4)'  },
        { icon: 'flame',       label: 'SERIES LIVE',    val: '4',    cls: 'coral', change: 'up',   txt: 'in progress now',        spark: '0,10 20,18 40,8 60,22 80,14 100,26 120,20', sparkColor: 'rgba(255,75,38,.4)'   },
        { icon: 'star',        label: 'TOP SEED',       val: 'BOS',  cls: '',      change: 'up',   txt: 'East bracket leader',    spark: '0,22 20,20 40,16 60,18 80,12 100,10 120,8',  sparkColor: 'rgba(255,255,255,.2)' },
        { icon: 'bar-chart-2', label: 'UPSET ALERT',    val: '2',    cls: 'amber', change: 'down', txt: 'lower seeds leading',    spark: '0,24 20,18 40,20 60,10 80,12 100,6 120,4',  sparkColor: 'rgba(255,179,0,.4)'   },
      ]
    },
  };

  // ── Today view: NBA NEWS FEED ──────────────────────────
  if (view === 'today') {
    kpiRow.innerHTML = SKELETON_KPI_HTML;
    const NEWS_TIMEOUT_MS = 8000;
    const newsPromise = window.fetchNBANews?.() ?? Promise.resolve([]);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NEWS_TIMEOUT_MS));
    Promise.race([newsPromise, timeoutPromise])
      .then(articles => {
        if (cancelled) return;
        _kpiViewAbort = null;
        renderNewsCards(articles);
      })
      .catch(err => {
        if (cancelled) return;
        console.warn('[PM] News fetch failed:', err);
        // Show a fallback rather than an empty state
        renderNewsCards([]);
      });
    return;
  }

  // ── Static views: skeleton → render ─────────────────────
  const data = views[view];
  if (!data) return;

  kpiRow.innerHTML = SKELETON_KPI_HTML;

  setTimeout(() => {
    if (cancelled) return;
    kpiRow.innerHTML = data.cards.map(c => `
      <div class="kpi-card">
        <div class="kpi-label">
          <svg class="lucide-icon" width="10" height="10"><use href="#icon-${c.icon}"/></svg>
          ${esc(c.label)}
        </div>
        <div class="kpi-value ${c.cls} ${c.val.length > 8 ? 'xl-long' : c.val.length > 5 ? 'long' : ''}">${esc(c.val)}</div>
        <div class="kpi-change ${c.change}">${esc(c.txt)}</div>
        <svg class="kpi-spark" viewBox="0 0 120 36" fill="none">
          <polyline points="${c.spark}" stroke="${c.sparkColor}" stroke-width="1.5" fill="none"/>
        </svg>
      </div>`).join('');
    kpiRow.style.opacity = '1';
    kpiRow.style.transition = 'opacity .3s';
  }, 150);
}

/** Format a timestamp into "2h ago", "15m ago", etc. */
function _timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function renderNewsCards(articles) {
  const kpiRow = document.querySelector('.kpi-row');
  if (!kpiRow) return;

  if (!articles || articles.length === 0) {
    kpiRow.innerHTML = `<div class="news-empty">
      <svg class="lucide-icon" width="14" height="14"><use href="#icon-activity"/></svg>
      <span>NBA NEWS FEED LOADING…</span>
    </div>`;
    return;
  }

  kpiRow.innerHTML = articles.slice(0, 4).map((a, i) => {
    const imgHtml = a.image
      ? `<div class="news-thumb"><img src="${esc(a.image)}" alt="" loading="lazy" /></div>`
      : `<div class="news-thumb news-thumb-empty"><svg class="lucide-icon" width="20" height="20"><use href="#icon-activity"/></svg></div>`;
    const ago = _timeAgo(a.published);

    return `
    <a class="kpi-card news-card pm-inview" href="${esc(a.url)}" target="_blank" rel="noopener"
       style="animation: fadeUp .35s var(--decel) ${i * 70}ms both; text-decoration: none; color: inherit; cursor: pointer;">
      ${imgHtml}
      <div class="news-body">
        <div class="news-headline">${esc(a.headline)}</div>
        <div class="news-desc">${esc(a.description)}</div>
        <div class="news-meta">
          <span class="news-source">${esc(a.source)}</span>
          <span class="news-time">${esc(ago)}</span>
        </div>
      </div>
    </a>`;
  }).join('');
}

// Keep legacy renderKPIs for other callers (live score refresh patches KPI values)
function renderKPIs(kpis) {
  // KPIs are now replaced by news cards on the Today view.
  // This is intentionally a no-op to prevent stale skeleton overwrite.
}



// ── STANDINGS RENDERING ────────────────────────────────
function renderStandings(conf, listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const data = window.PMData?.STANDINGS?.[conf] ?? [];
  if (!data.length) {
    list.innerHTML = '<div style="padding:16px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--muted)">NO DATA</div>';
    return;
  }
  function l10dots(str) {
    const [w, l] = str.split('-').map(Number);
    return [
      ...Array(w).fill('<div class="s-l10-dot w"></div>'),
      ...Array(l).fill('<div class="s-l10-dot l"></div>'),
    ].join('');
  }
  function strkBadge(s) {
    return `<span class="s-strk ${s.startsWith('W') ? 'w' : 'l'}">${s}</span>`;
  }
  const head = `<div class="standings-head"><div class="s-th"></div><div class="s-th"></div><div class="s-th" style="text-align:left">TEAM</div><div class="s-th">W</div><div class="s-th">L</div><div class="s-th">PCT</div><div class="s-th">GB</div><div class="s-th">HOME</div><div class="s-th">AWAY</div><div class="s-th">L10</div><div class="s-th">STRK</div></div>`;
  const rows = data.map((t, i) => `
    <div class="standings-row ${i === 0 ? 'first' : ''}">
      <div class="s-seed ${i === 0 ? 'first' : ''}">${esc(t.seed)}</div>
      <div class="s-dot" style="background:${t.color}"></div>
      <div class="s-name">${esc(t.abbr)} ${esc(t.team)}</div>
      <div class="s-mono">${esc(t.w)}</div>
      <div class="s-mono dim">${esc(t.l)}</div>
      <div class="s-pct">${esc(t.pct)}</div>
      <div class="s-mono dim">${esc(t.gb)}</div>
      <div class="s-mono">${esc(t.home)}</div>
      <div class="s-mono dim">${esc(t.away)}</div>
      <div class="s-l10">${l10dots(t.l10)}</div>
      <div>${strkBadge(esc(t.strk))}</div>
    </div>`).join('');
  list.innerHTML = head + rows;
}

// ── LEAGUE LEADERS ─────────────────────────────────────
function renderLeaders(cat) {
  const list = document.getElementById('leadersList');
  if (!list) return;
  const data = (window.PMData?.LEADERS?.[cat] ?? []).slice(0, 7);
  if (!data || data.length === 0) {
    list.innerHTML = '<div style="padding:24px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:1px">NO DATA AVAILABLE</div>';
    return;
  }
  list.innerHTML = data.map((p, i) => `
  <div class="leader-row ${i === 0 ? 'top' : ''}">
    <div class="l-rank ${i === 0 ? 'top' : ''}">${i === 0 ? '#1' : '#' + (i + 1)}</div>
    <div class="l-avatar-wrap ${i === 0 ? 'top' : ''}">
      <img class="l-avatar-img" 
        src="${p.img || 'https://cdn.nba.com/headshots/nba/latest/260x190/' + getNBAPlayerId(p.name) + '.png'}" 
        alt="${esc(p.name)}" loading="lazy" data-initials="${esc(getInitials(p.name))}" />
      <div class="l-avatar ${i === 0 ? 'top' : ''}" style="display:none"></div>
    </div>
    <div class="l-info">
      <div class="l-name">${esc(p.name)}</div>
      <div class="l-team">${esc(p.team)}</div>
    </div>
    <div class="l-bar-wrap">
      <div class="l-bar"><div class="l-fill ${i === 0 ? 'top' : ''}" style="width:${p.pct}%"></div></div>
    </div>
    <div class="l-val ${i === 0 ? 'top' : ''}">${esc(p.val)}</div>
  </div>`).join('');

  // Wire up images (CSP safe alternative to inline handlers)
  list.querySelectorAll('.l-avatar-img').forEach(img => {
    img.style.opacity = '0';
    img.style.transition = 'opacity .2s';
    img.addEventListener('load', () => { img.style.opacity = '1'; }, { once: true });
    img.addEventListener('error', () => {
      img.style.display = 'none';
      const fallback = img.nextElementSibling;
      if (fallback) {
        fallback.textContent = img.dataset.initials || '??';
        fallback.style.display = 'flex';
      }
    }, { once: true });
  });
}

function generateDeterministicSparkPoints(name, pct) {
  let seed = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const H = 28, W = 140, steps = 8, step = W / (steps - 1);
  const endY = H - (pct / 100) * (H * 0.8) - H * 0.1;
  return Array.from({ length: steps }, (_, i) => {
    const progress = i / (steps - 1);
    const y = endY + (1 - progress) * H * 0.4 + (rand() - 0.5) * H * 0.3;
    return `${Math.round(i * step)},${Math.max(2, Math.min(H - 2, Math.round(y)))}`;
  }).join(' ');
}

// ── MVP RACE ───────────────────────────────────────────
function renderMVPRace() {
  const pts = window.PMData?.LEADERS?.pts ?? [];
  const grid = document.querySelector('.mvp-grid');
  const sentiment = document.querySelector('#mvpSentiment');
  if (!grid) return;

  if (pts.length < 3) {
    grid.innerHTML = `<div class="gc-empty">MVP DATA PROCESSING...</div>`;
    return;
  }

  const badge = document.getElementById('mvpUpdateBadge');
  if (badge) {
    badge.textContent = 'UPDATED';
    badge.className = 'panel-badge lime';
  }

  const top3 = pts.slice(0, 3);
  const rankColors = ['lime', 'amber', 'blue'];
  const rankLabels = ['1ST — MVP FRONTRUNNER', '2ND — CHASING', '3RD — IN THE MIX'];
  const reb = window.PMData?.LEADERS?.reb ?? [];
  const ast = window.PMData?.LEADERS?.ast ?? [];

  // Build a lookup of other stats by player name
  const getReb = name => reb.find(p => p.name === name)?.val ?? '—';
  const getAst = name => ast.find(p => p.name === name)?.val ?? '—';



  grid.innerHTML = top3.map((p, i) => {
    const clr = rankColors[i];
    const rebVal = getReb(p.name);
    const astVal = getAst(p.name);
    const initials = getInitials(p.name);
    const teamAbbr = p.team;
    const ptsBarW = Math.round(p.pct);
    const rebPct = reb[0]?.val ? Math.round((parseFloat(rebVal) / reb[0].val) * 100) : 50;
    const astPct = ast[0]?.val ? Math.round((parseFloat(astVal) / ast[0].val) * 100) : 50;

    return `
    <div class="mvp-card rank-${i + 1}">
      <div class="mvp-rank-badge r${i + 1}">${esc(rankLabels[i])}</div>
      <div class="mvp-avatar-row">
        <div class="mvp-avatar r${i + 1}">${esc(initials)}</div>
        <div class="mvp-name-block">
          <div class="mvp-name">${esc(p.name.split(' ').pop())}</div>
          <div class="mvp-team">${esc(teamAbbr)}</div>
        </div>
      </div>
      <div class="mvp-stats">
        <div class="mvp-stat-row">
          <div class="mvp-stat-val ${clr}">${esc(p.val)}</div>
          <div class="mvp-stat-bar"><div class="mvp-stat-fill ${clr}" style="width:${ptsBarW}%"></div></div>
          <div class="mvp-stat-label">PPG</div>
        </div>
        <div class="mvp-stat-row">
          <div class="mvp-stat-val ${clr}">${esc(rebVal)}</div>
          <div class="mvp-stat-bar"><div class="mvp-stat-fill ${clr}" style="width:${rebPct}%"></div></div>
          <div class="mvp-stat-label">RPG</div>
        </div>
        <div class="mvp-stat-row">
          <div class="mvp-stat-val ${clr}">${esc(astVal)}</div>
          <div class="mvp-stat-bar"><div class="mvp-stat-fill ${clr}" style="width:${astPct}%"></div></div>
          <div class="mvp-stat-label">APG</div>
        </div>
      </div>
      <svg class="mvp-spark" viewBox="0 0 140 28" fill="none">
        <polyline points="${generateDeterministicSparkPoints(p.name, p.pct)}"
          stroke="var(--${clr})" stroke-width="1.5" fill="none"/>
      </svg>
    </div>`;
  }).join('');

  if (sentiment) {
    const s = window.PMData?.MVPSentiment ?? { intl: 62, dom: 38 };
    sentiment.innerHTML = `
      <div class="voter-title">VOTER CLOUT (%)</div>
      <div class="voter-row">
        <span class="voter-abbr" style="color:var(--blue)">INTL</span>
        <div class="voter-track"><div class="voter-bar pulse-bar" style="width:${s.intl}%;background:var(--blue)"></div></div>
        <span class="voter-pct">${s.intl}%</span>
      </div>
      <div class="voter-row">
        <span class="voter-abbr" style="color:var(--lime)">DOM</span>
        <div class="voter-track"><div class="voter-bar pulse-bar" style="width:${s.dom}%;background:var(--lime)"></div></div>
        <span class="voter-pct">${s.dom}%</span>
      </div>`;
  }
}
window.renderMVPRace = renderMVPRace;

// Advanced analytics lab
const LAB_FALLBACK_PLAYERS = [
  { name: 'Shai Gilgeous-Alexander', team: 'OKC', pts: 30.1, reb: 5.5, ast: 6.2, stl: 1.9, blk: 0.9, tpm: 2.1 },
  { name: 'Nikola Jokic', team: 'DEN', pts: 28.7, reb: 12.8, ast: 9.8, stl: 1.7, blk: 0.7, tpm: 1.9 },
  { name: 'Luka Doncic', team: 'DAL', pts: 31.4, reb: 8.6, ast: 8.9, stl: 1.4, blk: 0.5, tpm: 3.8 },
  { name: 'Giannis Antetokounmpo', team: 'MIL', pts: 30.4, reb: 11.5, ast: 6.5, stl: 1.2, blk: 1.1, tpm: 0.6 },
  { name: 'Jayson Tatum', team: 'BOS', pts: 27.0, reb: 8.2, ast: 4.9, stl: 1.1, blk: 0.6, tpm: 3.1 },
  { name: 'Anthony Edwards', team: 'MIN', pts: 26.8, reb: 5.4, ast: 5.1, stl: 1.3, blk: 0.6, tpm: 2.7 },
  { name: 'Stephen Curry', team: 'GSW', pts: 26.4, reb: 4.4, ast: 5.2, stl: 0.9, blk: 0.4, tpm: 4.6 },
  { name: 'Jalen Brunson', team: 'NYK', pts: 26.0, reb: 3.2, ast: 7.1, stl: 0.9, blk: 0.2, tpm: 2.5 },
];

const LAB_TEAM_ROSTERS = {
  OKC: [
    { name: 'Shai Gilgeous-Alexander', role: 'creator', impact: 8.7, usage: 31 },
    { name: 'Jalen Williams', role: 'wing', impact: 5.4, usage: 24 },
    { name: 'Chet Holmgren', role: 'rim', impact: 5.9, usage: 22 },
    { name: 'Luguentz Dort', role: 'stopper', impact: 2.8, usage: 15 },
    { name: 'Cason Wallace', role: 'guard', impact: 2.4, usage: 14 },
    { name: 'Isaiah Hartenstein', role: 'screen', impact: 3.9, usage: 13 },
    { name: 'Aaron Wiggins', role: 'spacer', impact: 2.1, usage: 15 },
  ],
  BOS: [
    { name: 'Jayson Tatum', role: 'creator', impact: 6.7, usage: 30 },
    { name: 'Jaylen Brown', role: 'wing', impact: 4.8, usage: 28 },
    { name: 'Derrick White', role: 'connector', impact: 4.7, usage: 18 },
    { name: 'Jrue Holiday', role: 'stopper', impact: 3.8, usage: 17 },
    { name: 'Kristaps Porzingis', role: 'rim', impact: 4.3, usage: 24 },
    { name: 'Payton Pritchard', role: 'spacer', impact: 2.7, usage: 19 },
  ],
  DEN: [
    { name: 'Nikola Jokic', role: 'hub', impact: 9.4, usage: 30 },
    { name: 'Jamal Murray', role: 'creator', impact: 4.9, usage: 27 },
    { name: 'Aaron Gordon', role: 'cutter', impact: 3.6, usage: 18 },
    { name: 'Michael Porter Jr.', role: 'spacer', impact: 3.2, usage: 21 },
    { name: 'Christian Braun', role: 'wing', impact: 2.5, usage: 15 },
    { name: 'Kentavious Caldwell-Pope', role: 'stopper', impact: 2.2, usage: 13 },
  ],
  MIN: [
    { name: 'Anthony Edwards', role: 'creator', impact: 6.1, usage: 31 },
    { name: 'Rudy Gobert', role: 'rim', impact: 5.7, usage: 14 },
    { name: 'Jaden McDaniels', role: 'stopper', impact: 3.1, usage: 16 },
    { name: 'Mike Conley', role: 'organizer', impact: 2.8, usage: 15 },
    { name: 'Naz Reid', role: 'spacer', impact: 3.4, usage: 22 },
    { name: 'Nickeil Alexander-Walker', role: 'guard', impact: 2.0, usage: 14 },
  ],
  LAL: [
    { name: 'LeBron James', role: 'hub', impact: 6.2, usage: 29 },
    { name: 'Anthony Davis', role: 'rim', impact: 6.8, usage: 27 },
    { name: 'Austin Reaves', role: 'connector', impact: 3.0, usage: 20 },
    { name: 'Dangelo Russell', role: 'creator', impact: 2.3, usage: 24 },
    { name: 'Rui Hachimura', role: 'wing', impact: 1.9, usage: 18 },
  ],
  NYK: [
    { name: 'Jalen Brunson', role: 'creator', impact: 6.4, usage: 32 },
    { name: 'Karl-Anthony Towns', role: 'big', impact: 5.2, usage: 27 },
    { name: 'OG Anunoby', role: 'stopper', impact: 3.7, usage: 17 },
    { name: 'Mikal Bridges', role: 'wing', impact: 3.3, usage: 20 },
    { name: 'Josh Hart', role: 'connector', impact: 2.9, usage: 13 },
  ],
};

const LAB_STATE = {
  player: LAB_FALLBACK_PLAYERS[0].name,
  compare: LAB_FALLBACK_PLAYERS[1].name,
  metricView: 'advanced',
  shotMode: 'makes',
  garbageFilter: false,
  team: (new URLSearchParams(window.location.search).get('team') || 'OKC').toUpperCase(),
  minutes: 28,
  restEdge: true,
  selected: [],
  advancedData: null,
  rosterReady: true,
};

function _hashString(str) {
  return String(str).split('').reduce((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0) >>> 0;
}

function _seededRandom(seedText) {
  let seed = _hashString(seedText) || 1;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function _range(seed, min, max, decimals = 1) {
  const n = min + (_hashString(seed) % 1000) / 999 * (max - min);
  return Number(n.toFixed(decimals));
}

function _signed(n, decimals = 1) {
  const val = Number(n || 0).toFixed(decimals);
  return Number(val) > 0 ? `+${val}` : val;
}

function _pct(n) {
  return `${Math.round(Number(n || 0))}%`;
}

function getLabComparePlayers() {
  const byName = new Map(LAB_FALLBACK_PLAYERS.map(p => [p.name, { ...p }]));
  const cats = { pts: 'pts', reb: 'reb', ast: 'ast', stl: 'stl', blk: 'blk', tpm: 'tpm' };
  Object.entries(cats).forEach(([cat, key]) => {
    (window.PMData?.LEADERS?.[cat] || []).slice(0, 10).forEach(p => {
      const existing = byName.get(p.name) || { name: p.name, team: p.team };
      existing[key] = parseFloat(p.val);
      existing.team = existing.team || p.team;
      byName.set(p.name, existing);
    });
  });
  // Ensure active team's roster is always available in dropdowns
  const activeRoster = LAB_TEAM_ROSTERS[LAB_STATE.team] || [];
  activeRoster.forEach(p => {
    if (!byName.has(p.name)) byName.set(p.name, { ...p, team: LAB_STATE.team });
  });
  return [...byName.values()].map(p => ({
    ...p,
    pts: Number(p.pts ?? _range(`${p.name}:pts`, 18, 31, 1)),
    reb: Number(p.reb ?? _range(`${p.name}:reb`, 3, 12, 1)),
    ast: Number(p.ast ?? _range(`${p.name}:ast`, 3, 10, 1)),
    stl: Number(p.stl ?? _range(`${p.name}:stl`, .5, 2.1, 1)),
    blk: Number(p.blk ?? _range(`${p.name}:blk`, .2, 2.3, 1)),
    tpm: Number(p.tpm ?? _range(`${p.name}:tpm`, .8, 4.5, 1)),
  }));
}

function getLabPlayers() {
  return getLabComparePlayers();
}

function getLabRosterPlayers() {
  return currentRoster().map(player => ({
    ...player,
    name: String(player?.name || '').trim(),
    position: String(player?.position || player?.pos || player?.role || '').trim(),
    team: LAB_STATE.team,
  })).filter(player => player.name);
}

function formatLabPlayerLabel(player) {
  const position = String(player?.position || player?.pos || player?.role || '').trim();
  return position ? `${player.name} / ${position}` : `${player.name} / ${player.team || LAB_STATE.team || 'NBA'}`;
}

function buildPlayerProfile(name) {
  const base = getLabPlayers().find(p => p.name === name) || LAB_FALLBACK_PLAYERS[0];
  const bump = LAB_STATE.garbageFilter ? .8 : 0;
  const ts = _range(`${name}:ts`, 56.2, 66.4, 1) + (LAB_STATE.garbageFilter ? .7 : 0);
  const per = _range(`${name}:per`, 18.5, 32.8, 1) + bump;
  const bpm = _range(`${name}:bpm`, 2.8, 11.4, 1) + bump;
  const ws = _range(`${name}:ws`, 5.8, 14.9, 1) + (bump * .3);
  const vorp = _range(`${name}:vorp`, 2.4, 8.7, 1) + (bump * .25);
  const on = _range(`${name}:on`, 4.5, 16.8, 1) + bump;
  const off = _range(`${name}:off`, -4.4, 5.2, 1) - (bump * .35);
  const ortg = _range(`${name}:ortg`, 113.5, 126.4, 1) + bump;
  const drtg = _range(`${name}:drtg`, 106.2, 116.8, 1) - (bump * .4);
  const trend = _range(`${name}:trend`, -4.2, 5.8, 1);
  return {
    ...base,
    ts, per, ws, bpm, vorp,
    usage: _range(`${name}:usage`, 22, 34, 1) - (LAB_STATE.garbageFilter ? .5 : 0),
    ortg, drtg,
    on, off, impact: on - off,
    l5: Number((base.pts + trend).toFixed(1)),
    trend,
    pts100: Number((base.pts * 3.05 + _range(`${name}:p100`, -4, 7, 1)).toFixed(1)),
    reb100: Number((base.reb * 3.15).toFixed(1)),
    ast100: Number((base.ast * 3.2).toFixed(1)),
    tovRate: _range(`${name}:tov`, 8.5, 14.8, 1),
    pace: _range(`${name}:pace`, 96.5, 103.7, 1),
    blowout: _range(`${name}:blowout`, 9, 31, 0),
    variance: _range(`${name}:variance`, 6.8, 14.2, 1),
    clutch: _range(`${name}:clutch`, 3.2, 7.8, 1),
  };
}

function _sparkPolyline(seed, width = 100, height = 18) {
  const rand = _seededRandom(seed);
  return Array.from({ length: 7 }, (_, i) => {
    const x = Math.round((i / 6) * width);
    const y = Math.round(2 + rand() * (height - 4));
    return `${x},${y}`;
  }).join(' ');
}

function renderAdvancedMetrics(profile) {
  const grid = document.getElementById('advancedMetricGrid');
  if (!grid) return;
  const views = {
    advanced: [
      ['TS%', profile.ts.toFixed(1), 'true shooting', 'good'],
      ['PER', profile.per.toFixed(1), 'box score rate', profile.per > 25 ? 'hot' : 'good'],
      ['Win Shares', profile.ws.toFixed(1), 'season value', ''],
      ['BPM', _signed(profile.bpm), 'box plus-minus', 'good'],
      ['VORP', profile.vorp.toFixed(1), 'replacement value', ''],
      ['USG%', profile.usage.toFixed(1), 'play diet', profile.usage > 30 ? 'hot' : ''],
    ],
    splits: [
      ['On Court', _signed(profile.on), 'net rating', 'good'],
      ['Off Court', _signed(profile.off), 'team minutes', profile.off < 0 ? 'hot' : ''],
      ['Impact', _signed(profile.impact), 'with/without', 'good'],
      ['Lineup ORtg', profile.ortg.toFixed(1), 'selected units', 'good'],
      ['Lineup DRtg', profile.drtg.toFixed(1), 'lower is better', profile.drtg < 110 ? 'good' : ''],
      ['Last 5', profile.l5.toFixed(1), `${_signed(profile.trend)} vs season`, profile.trend > 2 ? 'hot' : ''],
    ],
    per100: [
      ['PTS / 100', profile.pts100.toFixed(1), 'possession based', 'good'],
      ['REB / 100', profile.reb100.toFixed(1), 'possession based', ''],
      ['AST / 100', profile.ast100.toFixed(1), 'possession based', ''],
      ['ORtg', profile.ortg.toFixed(1), 'per 100 poss', 'good'],
      ['DRtg', profile.drtg.toFixed(1), 'per 100 poss', profile.drtg < 110 ? 'good' : ''],
      ['TOV%', profile.tovRate.toFixed(1), 'possession cost', profile.tovRate > 13 ? 'hot' : ''],
    ],
    core: [
      ['PTS', profile.pts.toFixed(1), 'per game', 'hot'],
      ['REB', profile.reb.toFixed(1), 'per game', ''],
      ['AST', profile.ast.toFixed(1), 'per game', ''],
      ['STL', profile.stl.toFixed(1), 'per game', ''],
      ['BLK', profile.blk.toFixed(1), 'per game', ''],
      ['3PM', profile.tpm.toFixed(1), 'per game', 'good'],
    ],
  };
  const cards = views[LAB_STATE.metricView] || views.advanced;
  grid.innerHTML = cards.map(([label, value, note, cls], i) => `
    <div class="metric-tile ${cls}" style="animation-delay:${i * 0.05}s">
      <div class="metric-label">${esc(label)}</div>
      <div class="metric-value">${esc(value)}</div>
      <svg class="metric-sparkline" viewBox="0 0 100 18" fill="none">
        <polyline points="${_sparkPolyline(profile.name + label)}" stroke="var(--lime)" stroke-width="1.4" fill="none" opacity=".8"/>
      </svg>
      <div class="metric-note">${esc(note)}</div>
    </div>`).join('');
}

function _shotZones(profile) {
  const live = LAB_STATE.advancedData?.shotZones?.zones;
  if (live) {
    return {
      rim: Number(live.rim ?? 30),
      paint: Number(live.paint_non_rim ?? 12),
      mid: Number(live.mid_range ?? 14),
      corner: Number(live.corner_3 ?? 10),
      above: Number(live.above_break_3 ?? 34),
    };
  }
  return {
    rim: _range(`${profile.name}:rim`, 24, 38, 1),
    paint: _range(`${profile.name}:paint`, 8, 16, 1),
    mid: _range(`${profile.name}:mid`, 8, 20, 1),
    corner: _range(`${profile.name}:corner`, 6, 17, 1),
    above: _range(`${profile.name}:above`, 24, 42, 1),
  };
}

function _zonePoint(zone, rand) {
  if (zone === 'rim') return [250 + (rand() - .5) * 55, 382 + (rand() - .5) * 42];
  if (zone === 'paint') return [250 + (rand() - .5) * 116, 300 + (rand() - .5) * 86];
  if (zone === 'mid') return [120 + rand() * 260, 185 + rand() * 92];
  if (zone === 'corner') return [rand() > .5 ? 43 + rand() * 38 : 419 + rand() * 38, 306 + rand() * 92];
  return [105 + rand() * 290, 78 + rand() * 112];
}

function renderShotChart(profile) {
  const wrap = document.getElementById('shotChartSvg');
  const legend = document.getElementById('shotZoneLegend');
  if (!wrap || !legend) return;
  const zones = _shotZones(profile);
  const zoneList = [
    ['rim', 'Rim', zones.rim, 'var(--lime)'],
    ['paint', 'Paint', zones.paint, 'var(--blue)'],
    ['mid', 'Mid', zones.mid, 'var(--amber)'],
    ['corner', 'Corner 3', zones.corner, 'var(--coral)'],
    ['above', 'Above 3', zones.above, 'var(--lime)'],
  ];
  const total = zoneList.reduce((sum, z) => sum + z[2], 0) || 1;
  const rand = _seededRandom(`${profile.name}:shots:${LAB_STATE.shotMode}`);
  const shots = [];
  zoneList.forEach(([key, label, share]) => {
    const n = Math.max(4, Math.round((share / total) * 72));
    for (let i = 0; i < n; i++) {
      const [x, y] = _zonePoint(key, rand);
      const make = rand() < (profile.ts / 100 + (key === 'rim' ? .18 : key === 'mid' ? -.08 : .02));
      shots.push({ x, y, make, key, label });
    }
  });
  const heat = zoneList.map(([key, label, share, color]) => {
    const centers = { rim: [250, 382], paint: [250, 305], mid: [250, 218], corner: [78, 346], above: [250, 122] };
    const c = centers[key];
    const r = key === 'corner' ? 54 : 42 + share * 1.35;
    const secondCorner = key === 'corner'
      ? `<circle cx="422" cy="346" r="${r}" fill="${color}" opacity="${LAB_STATE.shotMode === 'zones' ? '.13' : '.09'}"/>`
      : '';
    return `<circle cx="${c[0]}" cy="${c[1]}" r="${r}" fill="${color}" opacity="${LAB_STATE.shotMode === 'zones' ? '.13' : '.08'}"><title>${label} ${share.toFixed(1)}%</title></circle>${secondCorner}`;
  }).join('');
  const dots = shots.map(s => `<circle class="shot-dot" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${LAB_STATE.shotMode === 'density' ? 3.2 : 2.5}"
      fill="${s.make ? 'var(--lime)' : 'var(--coral)'}" opacity="${LAB_STATE.shotMode === 'zones' ? .25 : s.make ? .82 : .48}">
      <title>${s.label}: ${s.make ? 'make' : 'miss'}</title>
    </circle>`).join('');
  wrap.innerHTML = `
    <svg class="shot-chart" viewBox="0 0 500 470" role="img" aria-label="Shot chart for ${esc(profile.name)}">
      <rect x="18" y="20" width="464" height="430" fill="rgba(255,255,255,.018)" stroke="rgba(255,255,255,.12)"/>
      <path d="M70 450 V305 M430 450 V305 M70 305 Q250 126 430 305" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="2"/>
      <rect x="190" y="300" width="120" height="150" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2"/>
      <path d="M190 300 Q250 247 310 300" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="2"/>
      <circle cx="250" cy="392" r="10" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
      <line x1="226" y1="408" x2="274" y2="408" stroke="rgba(255,255,255,.2)" stroke-width="2"/>
      ${LAB_STATE.shotMode !== 'makes' ? heat : ''}
      ${dots}
    </svg>`;
  legend.innerHTML = zoneList.map(([, label, share]) => `
    <div class="zone-pill">
      <b>${share.toFixed(1)}%</b>
      <span>${esc(label)}</span>
    </div>`).join('');
}

function renderRadar(profile, compareProfile) {
  const wrap = document.getElementById('radarChartSvg');
  if (!wrap) return;
  const axes = [
    ['PTS', profile.pts, compareProfile.pts, 34],
    ['TS', profile.ts, compareProfile.ts, 70],
    ['PER', profile.per, compareProfile.per, 34],
    ['AST', profile.ast, compareProfile.ast, 11],
    ['REB', profile.reb, compareProfile.reb, 14],
    ['IMP', profile.impact, compareProfile.impact, 20],
  ];
  const toPoints = (idx) => axes.map((a, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / axes.length;
    const raw = idx === 1 ? a[1] : a[2];
    const r = Math.max(16, Math.min(92, (raw / a[3]) * 92));
    return `${(Math.cos(angle) * r).toFixed(1)},${(Math.sin(angle) * r).toFixed(1)}`;
  }).join(' ');
  const axisLines = axes.map((a, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / axes.length;
    const x = Math.cos(angle) * 100;
    const y = Math.sin(angle) * 100;
    const lx = Math.cos(angle) * 114;
    const ly = Math.sin(angle) * 114;
    return `
      <!-- Solid tick spokes -->
      <line x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.09)" stroke-width="1"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.5" fill="rgba(255,255,255,0.3)" />
      <text class="radar-axis-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${a[0]}</text>`;
  }).join('');

  // Technical polygon web rings with subtle grid tick labels
  const rings = [25, 50, 75, 100].map(r => {
    const pts = axes.map((_, i) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * i) / axes.length;
      return `${(Math.cos(angle) * r).toFixed(1)},${(Math.sin(angle) * r).toFixed(1)}`;
    }).join(' ');
    
    // Add small percentage indicator label on the top vertical axis
    const label = r === 100 ? `<text x="5" y="${-r + 3}" font-family="var(--mono)" font-size="6" fill="var(--muted)" opacity="0.6">100%</text>` : '';

    return `
      <polygon points="${pts}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="0.8" stroke-dasharray="${r === 100 ? 'none' : '2 2'}"/>
      ${label}
    `;
  }).join('');

  const p1LastName = profile.name.split(' ').pop();
  const p2LastName = compareProfile.name.split(' ').pop();

  // Create highly interactive hover nodes
  const nodes = axes.flatMap((a, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / axes.length;
    const r1 = Math.max(16, Math.min(92, (a[1] / a[3]) * 92));
    const x1 = Math.cos(angle) * r1;
    const y1 = Math.sin(angle) * r1;
    const r2 = Math.max(16, Math.min(92, (a[2] / a[3]) * 92));
    const x2 = Math.cos(angle) * r2;
    const y2 = Math.sin(angle) * r2;

    return [
      `<circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="3.5" fill="#05050a" stroke="var(--lime)" stroke-width="1.6" class="radar-node" data-stat="${a[0]}" data-p1-val="${a[1]}" data-p2-val="${a[2]}" data-p1-name="${p1LastName}" data-p2-name="${p2LastName}" data-max-val="${a[3]}" style="cursor: pointer;" />`,
      `<circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="3.5" fill="#05050a" stroke="var(--blue)" stroke-width="1.6" class="radar-node" data-stat="${a[0]}" data-p1-val="${a[1]}" data-p2-val="${a[2]}" data-p1-name="${p1LastName}" data-p2-name="${p2LastName}" data-max-val="${a[3]}" style="cursor: pointer;" />`
    ];
  }).join('');

  wrap.innerHTML = `
    <svg class="radar-svg" viewBox="-135 -130 270 260" role="img" aria-label="Radar comparison" style="overflow: visible;">
      <!-- Center Telemetry Crosshairs -->
      <g stroke="rgba(255,255,255,0.06)" stroke-width="0.8" fill="none">
        <line x1="-12" y1="0" x2="12" y2="0" />
        <line x1="0" y1="-12" x2="0" y2="12" />
        <circle cx="0" cy="0" r="3" />
      </g>

      ${rings}
      ${axisLines}

      <!-- Comparison Shapes with mix-blend-mode for breathtaking neon overlap color -->
      <g style="mix-blend-mode: screen;">
        <polygon points="${toPoints(1)}" fill="rgba(197,248,42,.12)" stroke="var(--lime)" stroke-width="2" class="radar-shape" style="filter: drop-shadow(0 0 3px rgba(197,248,42,0.15));" />
        <polygon points="${toPoints(2)}" fill="rgba(60,174,255,.09)" stroke="var(--blue)" stroke-width="2" class="radar-shape" style="filter: drop-shadow(0 0 3px rgba(60,174,255,0.12));" />
      </g>

      ${nodes}

      <!-- Bottom player name tags styled as telemetry badges -->
      <g transform="translate(0, 118)" font-family="var(--mono)" font-size="7.5" font-weight="bold">
        <!-- Player 1 (Lime) Tag -->
        <text x="-92" y="2.5" fill="var(--lime)" text-anchor="middle">${esc(p1LastName.toUpperCase())}</text>

        <!-- Player 2 (Blue) Tag -->
        <text x="92" y="2.5" fill="var(--blue)" text-anchor="middle">${esc(p2LastName.toUpperCase())}</text>
      </g>
    </svg>`;
}

function renderWinProbability(profile) {
  const wrap = document.getElementById('winProbChartSvg');
  const meta = document.getElementById('winProbMeta');
  if (!wrap) return;
  const games = window.PMData?.SCOREBOARD || [];
  const live = games.find(g => g.status === 2) || games[0];
  const rand = _seededRandom(`${profile.name}:winprob:${live?.id || 'demo'}`);
  const base = live ? 50 + ((live.home?.score || 0) - (live.away?.score || 0)) * 1.6 : _range(`${profile.name}:wpbase`, 45, 95, 1);
  let current = Math.max(45, Math.min(95, base));
  
  // Y-axis minimum is 45%, maximum is 95%. Range = 50.
  // 1 percentage point = 5.6px.
  // y = 310 - (current - 45) * 5.6
  const points = Array.from({ length: 14 }, (_, i) => {
    current = Math.max(45, Math.min(95, current + (rand() - .45) * 12));
    return { x: 24 + i * 25, y: 310 - (current - 45) * 5.6, p: current };
  });

  // Calculate high-fidelity smooth cubic Bezier path
  let smoothPath = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = (p1.x - p0.x) / 2;
    const cp1x = p0.x + dx;
    const cp1y = p0.y;
    const cp2x = p1.x - dx;
    const cp2y = p1.y;
    smoothPath += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }

  const areaPath = `${smoothPath} L ${points.at(-1).x.toFixed(1)} 310 L ${points[0].x.toFixed(1)} 310 Z`;
  const last = points.at(-1)?.p ?? current;
  
  if (meta) {
    meta.textContent = live ? `${live.away?.tricode || 'AWY'} @ ${live.home?.tricode || 'HOME'} / ${Math.round(last)}%` : `SIM / ${Math.round(last)}%`;
  }
  
  const homeCode = live?.home?.tricode || 'HOME';
  const awayCode = live?.away?.tricode || 'AWY';

  // Store the points JSON and active team codes in the container dataset for the interactive hover scrubber
  wrap.dataset.points = JSON.stringify(points);
  wrap.dataset.homeTeam = homeCode;
  wrap.dataset.awayTeam = awayCode;

  wrap.innerHTML = `
    <svg class="winprob-svg" viewBox="0 0 380 350" preserveAspectRatio="none" role="img" aria-label="Win probability chart" style="overflow: visible; width: 100%; height: 100%;">
      <defs>
        <!-- Premium glassmorphic area gradient - clean, subtle, and themed in solid blue -->
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.09" />
          <stop offset="50%" stop-color="var(--blue)" stop-opacity="0.02" />
          <stop offset="100%" stop-color="var(--blue)" stop-opacity="0" />
        </linearGradient>
        
        <!-- Glowing scrubber hover pulse radial gradient - themed in solid blue -->
        <radialGradient id="scrubberGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <style>
        @keyframes livePulse {
          0% { transform: scale(1); opacity: 0.6; }
          50% { transform: scale(1.4); opacity: 0.1; }
          100% { transform: scale(1); opacity: 0.6; }
        }
        .live-pulse-ring {
          transform-origin: ${points.at(-1).x.toFixed(1)}px ${points.at(-1).y.toFixed(1)}px;
          animation: livePulse 2s infinite ease-in-out;
        }
        .winprob-node {
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .winprob-node:hover {
          r: 4.5px !important;
          stroke-width: 2.0px !important;
        }
      </style>

      <!-- Dynamic team watermark labels (Premium sports design element) -->
      <text x="24" y="22" font-family="var(--mono)" font-size="8.5" font-weight="bold" fill="var(--text)" opacity="0.32">${homeCode}</text>
      <text x="24" y="324" font-family="var(--mono)" font-size="8.5" font-weight="bold" fill="var(--text)" opacity="0.32">${awayCode}</text>

      <!-- Grid lines - fine-tuned, extremely subtle, and aligned to 350px height -->
      <g class="grid-lines" opacity="0.08">
        <line x1="24" y1="30" x2="352" y2="30" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" />
        <line x1="24" y1="100" x2="352" y2="100" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" />
        <line x1="24" y1="170" x2="352" y2="170" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" />
        <line x1="24" y1="240" x2="352" y2="240" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" />
        <line x1="24" y1="310" x2="352" y2="310" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" />
      </g>

      <!-- Side Grid Labels - beautifully aligned to new grid coordinate layout -->
      <text x="14" y="33" class="winprob-label" text-anchor="end" font-size="7" fill="var(--muted)">95%</text>
      <text x="14" y="103" class="winprob-label" text-anchor="end" font-size="7" fill="var(--muted)">82%</text>
      <text x="14" y="173" class="winprob-label" text-anchor="end" font-size="7" fill="var(--muted)">70%</text>
      <text x="14" y="243" class="winprob-label" text-anchor="end" font-size="7" fill="var(--muted)">57%</text>
      <text x="14" y="313" class="winprob-label" text-anchor="end" font-size="7" fill="var(--muted)">45%</text>

      <!-- Spline Area under curve -->
      <path d="${areaPath}" fill="url(#areaGradient)" />

      <!-- Primary dynamic spline curve - solid blue branding, sharp and high-precision -->
      <path d="${smoothPath}" fill="none" stroke="var(--blue)" stroke-width="2.2" />

      <!-- Grid Nodes - sharp, sleek, blue branded -->
      ${points.map((p, i) => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.2" fill="#05050a" stroke="${i === points.length - 1 ? 'var(--lime)' : 'var(--blue)'}" stroke-width="1.4" class="winprob-node" data-index="${i}">
          <title>Possession ${i + 1}: ${Math.round(p.p)}%</title>
        </circle>
      `).join('')}

      <!-- Pulsing halo for live state -->
      <circle cx="${points.at(-1).x.toFixed(1)}" cy="${points.at(-1).y.toFixed(1)}" r="6" fill="none" stroke="var(--lime)" stroke-width="1.0" opacity="0.6" class="live-pulse-ring" />

      <!-- Dynamic cursor crosshair tracker & dynamic badges (High-fidelity overlay) -->
      <g id="winProbScrubberGroup" opacity="0" style="transition: opacity 0.25s ease;">
        <!-- Vertical crosshair -->
        <line id="winProbVerticalLine" x1="0" y1="30" x2="0" y2="310" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="2 2" />
        
        <!-- Horizontal crosshair (Premium design addition) -->
        <line id="winProbHorizontalLine" x1="24" y1="0" x2="352" y2="0" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="2 2" />
        
        <!-- Y-Axis Value Badge (Floats dynamically on y-axis) -->
        <g id="winProbYBadgeGroup" transform="translate(0, 0)">
          <rect x="-1" y="-7" width="22" height="14" rx="3" fill="#0d0d18" stroke="rgba(255,255,255,0.15)" stroke-width="0.8" />
          <text id="winProbYBadgeText" x="10" y="3.2" font-size="7.5" font-family="var(--mono)" fill="var(--blue)" text-anchor="middle" font-weight="bold">50%</text>
        </g>

        <!-- X-Axis Value Badge (Floats dynamically on timeline axis) -->
        <g id="winProbXBadgeGroup" transform="translate(0, 0)">
          <rect x="-24" y="3" width="48" height="13" rx="3" fill="#0d0d18" stroke="rgba(255,255,255,0.15)" stroke-width="0.8" />
          <text id="winProbXBadgeText" x="0" y="12" font-size="7.5" font-family="var(--mono)" fill="var(--muted)" text-anchor="middle">Poss. 1</text>
        </g>

        <circle id="winProbTrackGlow" cx="0" cy="0" r="8" fill="url(#scrubberGlow)" pointer-events="none" />
        <circle id="winProbTrackCircle" cx="0" cy="0" r="3.5" fill="var(--blue)" stroke="#05050a" stroke-width="1.8" pointer-events="none" />
      </g>

      <!-- X-Axis Labels -->
      <text x="24" y="336" class="winprob-label" font-size="8" fill="var(--muted)">Possession Flow ➔</text>
      <text x="352" y="336" text-anchor="end" class="winprob-label" font-size="8" fill="var(--muted)">4th Quarter</text>
    </svg>`;
}

function renderContextCards(profile) {
  const el = document.getElementById('contextCards');
  if (!el) return;
  const heat = profile.trend > 2 ? 'HOT' : profile.trend < -2 ? 'COLD' : 'STEADY';
  const cards = [
    ['Hot/Cold', heat, `${_signed(profile.trend)} PPG vs season`],
    ['Game Pace', profile.pace.toFixed(1), 'possessions per 48'],
    ['Blowout Risk', _pct(profile.blowout), 'garbage-time sensitivity'],
    ['Variance', profile.variance.toFixed(1), 'prop volatility index'],
  ];
  el.innerHTML = cards.map(([label, value, note]) => `
    <div class="context-card"><div class="cc-label">${esc(label)}</div><div class="cc-value">${esc(value)}</div><div class="cc-note">${esc(note)}</div></div>`).join('');
}

function renderAnalyticsLab() {
  const panel = document.getElementById('analyticsLab');
  if (!panel) return;
  if (!LAB_STATE.rosterReady) {
    renderAnalyticsLabSkeleton();
    return;
  }
  try {
    const player = buildPlayerProfile(LAB_STATE.player);
    const compareName = LAB_STATE.compare === LAB_STATE.player ? LAB_FALLBACK_PLAYERS[1].name : LAB_STATE.compare;
    const compare = buildPlayerProfile(compareName);
    if (!player || !compare) { console.warn('[PM] Analytics lab: player profile unavailable'); return; }
    renderAdvancedMetrics(player);
    renderShotChart(player);
    renderRadar(player, compare);
    renderWinProbability(player);
    renderContextCards(player);
    renderShareAndArchive(player, compare);
  } catch (err) {
    console.warn('[PM] Analytics lab render error:', err);
  }
}

function renderAnalyticsLabSkeleton() {
  setAnalyticsControlsEnabled(false);

  const playerSelect = document.getElementById('advancedPlayerSelect');
  const compareSelect = document.getElementById('advancedCompareSelect');
  const teamSelect = document.getElementById('lineupTeamSelect');
  const metricGrid = document.getElementById('advancedMetricGrid');
  const shotSvg = document.getElementById('shotChartSvg');
  const shotLegend = document.getElementById('shotZoneLegend');
  const radarSvg = document.getElementById('radarChartSvg');
  const winProbSvg = document.getElementById('winProbChartSvg');
  const contextCards = document.getElementById('contextCards');
  const lineupPool = document.getElementById('lineupPool');
  const lineupSummary = document.getElementById('lineupSummary');
  const matchupMatrix = document.getElementById('matchupMatrix');
  const pairingList = document.getElementById('pairingList');
  const propCards = document.getElementById('propContextCards');
  const dataPipeline = document.getElementById('dataPipelineList');

  [playerSelect, compareSelect, teamSelect].forEach(select => {
    if (!select) return;
    select.disabled = true;
    select.innerHTML = '<option>Loading…</option>';
  });

  if (metricGrid) {
    metricGrid.innerHTML = `
      <div class="skeleton-line" style="height:76px;border-radius:16px"></div>
      <div class="skeleton-line" style="height:76px;border-radius:16px"></div>
      <div class="skeleton-line" style="height:76px;border-radius:16px"></div>
      <div class="skeleton-line" style="height:76px;border-radius:16px"></div>`;
  }
  if (shotSvg) shotSvg.innerHTML = `<div class="skeleton-line" style="height:260px;border-radius:18px"></div>`;
  if (shotLegend) shotLegend.innerHTML = `<div class="skeleton-line" style="height:18px;width:70%"></div>`;
  if (radarSvg) radarSvg.innerHTML = `<div class="skeleton-line" style="height:260px;border-radius:18px"></div>`;
  if (winProbSvg) winProbSvg.innerHTML = `<div class="skeleton-line" style="height:260px;border-radius:18px"></div>`;
  if (contextCards) contextCards.innerHTML = `<div class="skeleton-line" style="height:56px;border-radius:14px"></div><div class="skeleton-line" style="height:56px;border-radius:14px"></div><div class="skeleton-line" style="height:56px;border-radius:14px"></div><div class="skeleton-line" style="height:56px;border-radius:14px"></div>`;

  if (lineupPool) {
    lineupPool.innerHTML = Array.from({ length: 5 }, () => `<div class="skeleton-line" style="height:34px;border-radius:12px;margin-bottom:10px"></div>`).join('');
  }
  if (lineupSummary) lineupSummary.innerHTML = `<div class="skeleton-line" style="height:64px;border-radius:16px"></div>`;
  if (matchupMatrix) matchupMatrix.innerHTML = Array.from({ length: 4 }, () => `<div class="skeleton-line" style="height:30px;border-radius:10px;margin-bottom:8px"></div>`).join('');
  if (pairingList) pairingList.innerHTML = Array.from({ length: 3 }, () => `<div class="skeleton-line" style="height:30px;border-radius:10px;margin-bottom:8px"></div>`).join('');
  if (propCards) propCards.innerHTML = Array.from({ length: 3 }, () => `<div class="skeleton-line" style="height:58px;border-radius:14px;margin-bottom:10px"></div>`).join('');
  if (dataPipeline) dataPipeline.innerHTML = `<div class="skeleton-line" style="height:80px;border-radius:16px"></div>`;

  const freshness = document.getElementById('analyticsFreshness');
  if (freshness) {
    freshness.textContent = 'LOADING';
    freshness.className = 'panel-badge muted';
  }
}

function setAnalyticsControlsEnabled(enabled) {
  const controls = [
    ...document.querySelectorAll('.metric-toggle'),
    ...document.querySelectorAll('.shot-toggle'),
  ];
  controls.forEach(btn => { btn.disabled = !enabled; });

  const garbage = document.getElementById('garbageFilter');
  const gatherBtn = document.getElementById('dataGatherBtn');
  const nlBtn = document.getElementById('nlSearchBtn');
  const shareBtn = document.getElementById('shareRadarBtn');
  const teamSelect = document.getElementById('lineupTeamSelect');
  const playerSelect = document.getElementById('advancedPlayerSelect');
  const compareSelect = document.getElementById('advancedCompareSelect');

  [garbage, gatherBtn, nlBtn, shareBtn, teamSelect, playerSelect, compareSelect].forEach(el => {
    if (!el) return;
    el.disabled = !enabled;
  });
}

function populateLabSelects() {
  if (!LAB_STATE.rosterReady) {
    const loadingMarkup = '<option>Loading…</option>';
    const playerSelect = document.getElementById('advancedPlayerSelect');
    const compareSelect = document.getElementById('advancedCompareSelect');
    const teamSelect = document.getElementById('lineupTeamSelect');
    if (playerSelect) {
      playerSelect.innerHTML = loadingMarkup;
      playerSelect.disabled = true;
    }
    if (compareSelect) {
      compareSelect.innerHTML = loadingMarkup;
      compareSelect.disabled = true;
    }
    if (teamSelect) {
      teamSelect.disabled = true;
    }
    return;
  }

  const rosterPlayers = getLabRosterPlayers();
  const comparePlayers = getLabComparePlayers();
  const playerSelect = document.getElementById('advancedPlayerSelect');
  const compareSelect = document.getElementById('advancedCompareSelect');
  if (playerSelect) {
    const current = playerSelect.value || LAB_STATE.player;
    playerSelect.innerHTML = rosterPlayers.map(p => `<option value="${esc(p.name)}">${esc(formatLabPlayerLabel(p))}</option>`).join('');
    playerSelect.value = rosterPlayers.some(p => p.name === current) ? current : rosterPlayers[0]?.name;
  }
  if (compareSelect) {
    const current = compareSelect.value || LAB_STATE.compare;
    compareSelect.innerHTML = comparePlayers.map(p => `<option value="${esc(p.name)}">${esc(p.name)} / ${esc(p.team || 'NBA')}</option>`).join('');
    compareSelect.value = comparePlayers.some(p => p.name === current) ? current : comparePlayers[0]?.name;
  }
  LAB_STATE.player = playerSelect?.value || LAB_STATE.player;
  LAB_STATE.compare = compareSelect?.value || LAB_STATE.compare;
}

function currentRoster() {
  return LAB_TEAM_ROSTERS[LAB_STATE.team] || LAB_TEAM_ROSTERS.OKC;
}

function syncAnalyticsLabRoster(team, rosterData) {
  const normalizedTeam = String(team || '').trim().toUpperCase();
  if (!normalizedTeam || !Array.isArray(rosterData) || rosterData.length === 0) return false;

  const existingRoster = LAB_TEAM_ROSTERS[normalizedTeam] || [];
  const fallbackRoles = ['creator', 'wing', 'connector', 'stopper', 'rim', 'guard', 'big'];
  const nextRoster = rosterData.map((player, index) => {
    const normalized = typeof normalizeRosterPlayer === 'function'
      ? normalizeRosterPlayer(player)
      : { name: String(player?.name || player?.fullName || player?.playerName || 'Unknown') };
    const existing = existingRoster.find(entry => entry.name === normalized.name) || {};
    const usage = Number.isFinite(existing.usage) ? existing.usage : Number(normalized.usage || player?.usage || 0);
    const impact = Number.isFinite(existing.impact)
      ? existing.impact
      : Number.isFinite(normalized.plus_minus) && normalized.plus_minus !== 0
        ? Number(normalized.plus_minus) / 5
        : (Number(normalized.pts) || 0) * 0.18
          + (Number(normalized.reb) || 0) * 0.12
          + (Number(normalized.ast) || 0) * 0.14
          + (Number(normalized.stl) || 0) * 0.35
          + (Number(normalized.blk) || 0) * 0.35
          - (Number(normalized.tov) || 0) * 0.15;

    return {
      name: normalized.name,
      position: normalized.position || player?.position || player?.pos || existing.position || existing.role || '',
      role: existing.role || player?.role || fallbackRoles[index % fallbackRoles.length],
      impact: Number(impact.toFixed(1)),
      usage,
      personId: player?.personId ?? player?.player_id ?? player?.id ?? existing.personId ?? null,
      pts: normalized.pts,
      reb: normalized.reb,
      ast: normalized.ast,
      stl: normalized.stl,
      blk: normalized.blk,
      tov: normalized.tov,
      orb: normalized.orb,
      drb: normalized.drb,
      plus_minus: normalized.plus_minus,
      tsPct: normalized.tsPct,
    };
  });

  LAB_TEAM_ROSTERS[normalizedTeam] = nextRoster;

  if (LAB_STATE.team === normalizedTeam) {
    LAB_STATE.rosterReady = true;
    const rosterNames = new Set(nextRoster.map(player => player.name));
    const preservedSelection = LAB_STATE.selected.filter(name => rosterNames.has(name));
    LAB_STATE.selected = preservedSelection.length ? preservedSelection : nextRoster.slice(0, 5).map(player => player.name);

    if (!rosterNames.has(LAB_STATE.player)) LAB_STATE.player = nextRoster[0]?.name || LAB_STATE.player;
    if (!rosterNames.has(LAB_STATE.compare) || LAB_STATE.compare === LAB_STATE.player) {
      LAB_STATE.compare = nextRoster[1]?.name || LAB_STATE.player;
    }

    setAnalyticsControlsEnabled(true);
    populateLabSelects();
    renderAnalyticsLab();
    renderLineupLab();
  }

  return true;
}
window.syncAnalyticsLabRoster = syncAnalyticsLabRoster;

function renderLineupPool() {
  const pool = document.getElementById('lineupPool');
  if (!pool) return;
  const roster = currentRoster();
  if (!LAB_STATE.selected.length) LAB_STATE.selected = roster.slice(0, 5).map(p => p.name);
  pool.innerHTML = roster.map(p => {
    const selected = LAB_STATE.selected.includes(p.name);
    return `<label class="player-chip ${selected ? 'selected' : ''}">
      <input type="checkbox" value="${esc(p.name)}" ${selected ? 'checked' : ''} />
      <span><span class="pc-name">${esc(p.name)}</span><span class="pc-role">${esc(p.role)} / ${p.usage}% USG</span></span>
      <span class="pc-impact">${_signed(p.impact)}</span>
    </label>`;
  }).join('');
  pool.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      const checked = [...pool.querySelectorAll('input:checked')].map(x => x.value);
      if (checked.length > 5) {
        input.checked = false;
        return;
      }
      LAB_STATE.selected = checked;
      renderLineupLab();
    });
  });
}

function renderLineupSummary() {
  const el = document.getElementById('lineupSummary');
  if (!el) return;
  const roster = currentRoster();
  const selected = roster.filter(p => LAB_STATE.selected.includes(p.name));
  
  let net = 0;
  let ortg = 113.0;
  let synergy = 50;
  
  // Real data calc if available
  const logs = LAB_STATE.advancedData?.logs || {};
  let validPlayers = 0;
  let sumPlusMinus = 0;
  let sumTsPct = 0;

  selected.forEach(p => {
    // If real data from roster
    if (p.plus_minus !== undefined) {
      sumPlusMinus += Number(p.plus_minus) || 0;
      sumTsPct += Number(p.tsPct) || 0;
      validPlayers++;
    }
  });

  if (validPlayers > 0) {
    net = (sumPlusMinus / validPlayers) * 5; // Rough extrapolation to 5-man net
    ortg = 100 + (sumTsPct / validPlayers) * 0.3; // Rough offensive approximation
    synergy = Math.max(42, Math.min(96, 50 + net * 2));
  } else {
    // Fallback heuristic
    const impact = selected.reduce((sum, p) => sum + p.impact, 0);
    const spacing = selected.filter(p => ['spacer', 'creator', 'wing', 'connector'].includes(p.role)).length;
    const size = selected.filter(p => ['rim', 'big', 'screen', 'hub'].includes(p.role)).length;
    net = impact * .72 + spacing * .8 + size * .4 - Math.abs(5 - selected.length) * 1.5;
    ortg = 113 + net * .62;
    synergy = Math.max(42, Math.min(96, 56 + net * 3.1 + selected.length * 2));
  }

  const stats = [['Players', `${selected.length}/5`], ['Net', _signed(net)], ['ORtg', ortg.toFixed(1)], ['Synergy', _pct(synergy)]];
  el.innerHTML = stats.map(([label, value]) => `<div class="summary-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
}

function renderMatchupsAndPairs() {
  const matchup = document.getElementById('matchupMatrix');
  const pairs = document.getElementById('pairingList');
  if (!matchup || !pairs) return;
  const roster = currentRoster();
  const selected = roster.filter(p => LAB_STATE.selected.includes(p.name));
  const defenders = selected.length ? selected : roster.slice(0, 5);
  matchup.innerHTML = defenders.slice(0, 5).map((p, i) => {
    // Real Data Calc
    let stl = Number(p.stl) || 0;
    let blk = Number(p.blk) || 0;
    let drb = Number(p.drb) || 0;
    
    // Attempt to pull from live logs if available
    const pLogs = LAB_STATE.advancedData?.logs?.[p.name];
    if (pLogs && pLogs.length > 0) {
      let lStl = 0, lBlk = 0;
      pLogs.forEach(g => {
        lStl += Number(g.STL) || 0;
        lBlk += Number(g.BLK) || 0;
      });
      stl = lStl / pLogs.length;
      blk = lBlk / pLogs.length;
    }
    
    const stocks = stl + blk;
    let tier = stocks > 2.0 ? 'A' : stocks > 1.2 ? 'B+' : 'B';
    // Fallback if no real data
    if (!p.stl && !pLogs) {
      tier = p.role === 'stopper' || p.role === 'rim' ? 'A' : p.impact > 4 ? 'B+' : 'B';
    }
    const val = stocks > 0 ? `${stocks.toFixed(1)} stk` : `${(22 - p.impact + i * .7).toFixed(1)} adj`;
    
    return `<div class="matchup-row"><div class="matchup-name">${esc(p.name)}</div><div class="tier-badge">TIER ${esc(tier)}</div><div class="matchup-pts">${val}</div></div>`;
  }).join('');
  const backendCombos = LAB_STATE.advancedData?.lineups?.combos;
  if (Array.isArray(backendCombos) && backendCombos.length) {
    pairs.innerHTML = backendCombos.slice(0, 3).map(c => `
      <div class="pairing-row"><div><strong>${esc(c.players)}</strong><span>${esc(c.min)} min / ${esc(c.ppp)} PPP</span></div><b>${_signed(c.netRtg)}</b></div>`).join('');
    return;
  }
  const pairRows = [];
  for (let i = 0; i < defenders.length - 1 && pairRows.length < 3; i++) {
    const a = defenders[i], b = defenders[i + 1];
    pairRows.push({ names: `${a.name} + ${b.name}`, net: (a.impact + b.impact) * .7, ppp: 1 + (a.impact + b.impact) / 70 });
  }
  pairs.innerHTML = pairRows.map(c => `
    <div class="pairing-row"><div><strong>${esc(c.names)}</strong><span>2-man unit / ${c.ppp.toFixed(2)} PPP</span></div><b>${_signed(c.net)}</b></div>`).join('');
}

function renderPropCards() {
  const el = document.getElementById('propContextCards');
  if (!el) return;
  const roster = currentRoster();
  const selected = roster.filter(p => LAB_STATE.selected.includes(p.name));
  const players = (selected.length ? selected : roster).slice(0, 3);
  const rest = LAB_STATE.restEdge ? 4 : -2;
  el.innerHTML = players.map(p => {
    const pLogs = LAB_STATE.advancedData?.logs?.[p.name];
    let recent = 0;
    let color = 'neutral';
    
    if (pLogs && pLogs.length > 0) {
      // Real API Hit-Rate
      const limit = Math.min(10, pLogs.length);
      let hits = 0;
      for (let i = 0; i < limit; i++) {
        const minsPlayed = parseFloat(pLogs[i].MIN) || 0;
        if (minsPlayed >= LAB_STATE.minutes) hits++;
      }
      recent = (hits / limit) * 100;
      color = recent >= 60 ? 'green' : recent <= 40 ? 'red' : 'neutral';
    } else {
      // Fallback simulated prop
      recent = Math.round(52 + p.impact * 5 + rest + (LAB_STATE.minutes - 28) * .9);
      color = recent > 70 ? 'green' : recent > 55 ? 'neutral' : 'red';
    }
    
    return `<div class="prop-card"><b>${esc(p.name.split(' ').pop())}</b><span>${LAB_STATE.minutes}+ min / matchup ${color}</span><div class="prop-meter"><div style="width:${Math.max(12, Math.min(94, recent))}%"></div></div></div>`;
  }).join('');
}

function renderDataPipeline() {
  const el = document.getElementById('dataPipelineList');
  if (!el) return;
  const ok = LAB_STATE.advancedData?.ok;
  const rows = [
    ['Shot zones', LAB_STATE.advancedData?.shotZones ? 'live' : ok ? 'stale' : 'ready'],
    ['Lineups', LAB_STATE.advancedData?.lineups ? 'live' : ok ? 'stale' : 'ready'],
    ['Play types', LAB_STATE.advancedData?.playTypes ? 'live' : ok ? 'stale' : 'ready'],
    ['Injuries', LAB_STATE.advancedData?.injuries ? 'live' : ok ? 'stale' : 'ready'],
  ];
  el.innerHTML = rows.map(([name, status]) => `
    <div class="data-row"><div class="data-name">${esc(name)}</div><div class="data-status ${status === 'live' ? 'live' : status === 'stale' ? 'stale' : ''}">${esc(status.toUpperCase())}</div></div>`).join('');
}

function renderLineupLab() {
  const panel = document.getElementById('lineupLab');
  if (!panel) return;
  if (!LAB_STATE.rosterReady) {
    renderAnalyticsLabSkeleton();
    return;
  }
  renderLineupPool();
  renderLineupSummary();
  renderMatchupsAndPairs();
  renderPropCards();
  renderDataPipeline();
}

async function gatherAdvancedContext() {
  const badge = document.getElementById('lineupDataBadge');
  if (badge) {
    badge.textContent = 'GATHERING';
    badge.className = 'panel-badge muted';
  }
  try {
    if (typeof window.fetchAdvancedTeamContext !== 'function') throw new Error('Advanced fetcher unavailable');
    const data = await window.fetchAdvancedTeamContext(LAB_STATE.team);
    LAB_STATE.advancedData = data;
    
    // Fetch logs for the selected players
    const roster = currentRoster();
    const topPlayers = roster.filter(p => LAB_STATE.selected.includes(p.name)).slice(0, 5);
    if (topPlayers.length === 0) topPlayers.push(...roster.slice(0, 5));
    
    const logs = await Promise.allSettled(
      topPlayers.map(p => {
        const id = p.personId;
        return id ? window.workerFetch(`/api/playerlog?player_id=${id}`, 8000, 1) : Promise.resolve([]);
      })
    );
    LAB_STATE.advancedData.logs = {};
    topPlayers.forEach((p, i) => {
      if (logs[i].status === 'fulfilled' && logs[i].value) {
        const games = Array.isArray(logs[i].value) ? logs[i].value : (logs[i].value.games || []);
        LAB_STATE.advancedData.logs[p.name] = games;
      }
    });
    if (badge) {
      badge.textContent = data.ok ? 'LIVE DATA' : 'LOCAL MODEL';
      badge.className = data.ok ? 'panel-badge lime' : 'panel-badge muted';
    }
  } catch (err) {
    console.warn('[PM] advanced context failed:', err.message);
    LAB_STATE.advancedData = null;
    if (badge) {
      badge.textContent = 'LOCAL MODEL';
      badge.className = 'panel-badge muted';
    }
  }
  renderAnalyticsLab();
  renderLineupLab();
}

function renderShareAndArchive(profile, compare) {
  const archive = document.getElementById('archiveCards');
  const share = document.getElementById('shareCardPreview');
  const daily = document.getElementById('dailyGameCard');
  if (archive) {
    const otd = (window.PMData?.OTD || []).slice(0, 3);
    const cards = otd.length ? otd : [
      { year: 2016, tag: 'ERA COMP', headline: `${profile.name.split(' ').pop()} statistical twin: high-usage creator with elite efficiency.` },
      { year: 2024, tag: 'MILESTONE', headline: `${profile.team || 'NBA'} profile tracks as a two-way contender signal.` },
      { year: 2006, tag: 'ARCHIVE', headline: 'Shot diet and usage similarity model is ready for deeper archive search.' },
    ];
    archive.innerHTML = cards.map(c => `
      <div class="archive-card"><div class="archive-year">${esc(c.year || 'NBA')}</div><div class="archive-label">${esc(c.tag || 'ARCHIVE')}</div><div class="archive-text">${esc(c.headline || c.detail || '')}</div></div>`).join('');
  }
  if (share) {
    share.innerHTML = `
      <div class="share-brand">PLUS-MINUS SHARE CARD</div>
      <div class="share-main">${esc(profile.name.split(' ').pop())}<br>${esc(_signed(profile.impact))} IMPACT</div>
      <div class="share-foot"><span>${esc(profile.ts.toFixed(1))}% TS / ${esc(profile.per.toFixed(1))} PER</span><button class="lab-action" type="button" id="copyShareCardBtn">Copy</button></div>`;
    document.getElementById('copyShareCardBtn')?.addEventListener('click', () => copyShareText(profile, compare));
  }
  if (daily) {
    const mystery = buildPlayerProfile(compare.name);
    daily.innerHTML = `
      <div class="daily-title">Daily Mystery Player</div>
      <div class="mystery-bars">
        <div class="mystery-bar"><div style="width:${Math.min(96, mystery.pts * 2.6)}%"></div></div>
        <div class="mystery-bar"><div style="width:${Math.min(96, mystery.reb * 6)}%"></div></div>
        <div class="mystery-bar"><div style="width:${Math.min(96, mystery.ast * 7)}%"></div></div>
      </div>
      <div class="daily-answer">Lineup challenge target: build a +8 net unit around a ${esc(mystery.team || 'NBA')} creator.</div>`;
  }
}

async function copyShareText(profile, compare) {
  const text = `${profile.name}: ${profile.ts.toFixed(1)} TS%, ${profile.per.toFixed(1)} PER, ${_signed(profile.impact)} on/off impact vs ${compare.name}.`;
  try {
    await navigator.clipboard?.writeText(text);
    const badge = document.getElementById('discoveryBadge');
    if (badge) badge.textContent = 'COPIED';
  } catch {
    const badge = document.getElementById('discoveryBadge');
    if (badge) badge.textContent = 'READY';
  }
}

function runNaturalSearch() {
  const input = document.getElementById('nlSearchInput');
  const answer = document.getElementById('nlAnswer');
  if (!input || !answer) return;
  const q = input.value.trim() || 'Who led clutch scoring this month?';
  const players = getLabPlayers().slice(0, 8).map(p => buildPlayerProfile(p.name));
  let ranked = [...players].sort((a, b) => b.clutch - a.clutch);
  let title = 'Clutch scoring';
  let body = `${ranked[0].name} leads this slice at ${ranked[0].clutch.toFixed(1)} clutch points, with ${ranked[1]?.name || 'the field'} next.`;
  if (/usage|per.?100|poss/i.test(q)) {
    ranked = [...players].sort((a, b) => b.usage - a.usage);
    title = 'Usage load';
    body = `${ranked[0].name} has the highest modeled usage at ${ranked[0].usage.toFixed(1)}%, with ${ranked[0].pts100.toFixed(1)} points per 100 possessions.`;
  } else if (/lineup|net|impact|with/i.test(q)) {
    const roster = currentRoster();
    const net = roster.slice(0, 5).reduce((sum, p) => sum + p.impact, 0) * .72;
    title = 'Lineup impact';
    body = `${LAB_STATE.team}'s selected five grades at ${_signed(net)} net rating with ${LAB_STATE.selected.length}/5 slots active.`;
  } else if (/shot|zone|rim|three|3/i.test(q)) {
    const z = _shotZones(buildPlayerProfile(LAB_STATE.player));
    title = 'Shot profile';
    body = `${LAB_STATE.player} is concentrated at the rim (${z.rim.toFixed(1)}%) and above-break threes (${z.above.toFixed(1)}%).`;
  }
  answer.innerHTML = `<div class="nl-answer-title">${esc(title)}</div><div class="nl-answer-body">${esc(body)}</div>`;
}

function initAnalyticsLab() {
  if (!document.getElementById('analyticsLab')) return;

  // Sync lab team with page context
  const pageTeam = (window.TEAM_ABBR || new URLSearchParams(window.location.search).get('team') || '').toUpperCase();
  if (pageTeam) {
    LAB_STATE.team = pageTeam;
    LAB_STATE.rosterReady = false;
    LAB_STATE.player = '';
    LAB_STATE.compare = '';
    LAB_STATE.selected = [];

    // If team isn't hardcoded but we have ROSTER_DATA on team.js, dynamically populate it
    if (!LAB_TEAM_ROSTERS[pageTeam] && typeof ROSTER_DATA !== 'undefined' && typeof normalizeRosterPlayer !== 'undefined' && ROSTER_DATA.length) {
      LAB_TEAM_ROSTERS[pageTeam] = ROSTER_DATA.map(p => {
        const norm = normalizeRosterPlayer(p);
        return {
          name: norm.name,
          personId: p.personId || p.player_id || p.id,
          role: 'creator',
          impact: (Number(norm.pts) || 0) / 4,
          usage: 20,
          stl: norm.stl,
          blk: norm.blk,
          orb: norm.orb,
          drb: norm.drb,
          plus_minus: norm.plus_minus,
          tsPct: norm.tsPct
        };
      }).sort((a, b) => b.impact - a.impact);
    }
  } else if (!LAB_STATE.selected.length) {
    LAB_STATE.selected = currentRoster().slice(0, 5).map(p => p.name);
  }

  populateLabSelects();
  const playerSelect = document.getElementById('advancedPlayerSelect');
  const compareSelect = document.getElementById('advancedCompareSelect');
  const teamSelect = document.getElementById('lineupTeamSelect');
  const garbage = document.getElementById('garbageFilter');
  const minutes = document.getElementById('propThreshold');
  const minutesVal = document.getElementById('propThresholdVal');
  const rest = document.getElementById('propRestToggle');
  if (teamSelect && !teamSelect.dataset.optionsBound && LAB_STATE.rosterReady) {
    teamSelect.innerHTML = Object.keys(LAB_TEAM_ROSTERS).map(t => `<option value="${t}">${t}</option>`).join('');
    teamSelect.value = LAB_STATE.team;
    teamSelect.dataset.optionsBound = '1';
  }
  const metricControls = document.getElementById('metricModeControls');
  if (metricControls && !metricControls.dataset.bound) {
    metricControls.addEventListener('click', e => {
      const btn = e.target.closest('.metric-toggle[data-metric-view]');
      if (!btn) return;
      LAB_STATE.metricView = btn.dataset.metricView;
      document.querySelectorAll('.metric-toggle').forEach(b => b.classList.toggle('active', b === btn));
      renderAnalyticsLab();
    });
    metricControls.dataset.bound = '1';
  }
  const shotControls = document.getElementById('shotModeControls');
  if (shotControls && !shotControls.dataset.bound) {
    shotControls.addEventListener('click', e => {
      const btn = e.target.closest('.shot-toggle[data-shot-mode]');
      if (!btn) return;
      LAB_STATE.shotMode = btn.dataset.shotMode;
      document.querySelectorAll('.shot-toggle').forEach(b => b.classList.toggle('active', b === btn));
      renderShotChart(buildPlayerProfile(LAB_STATE.player));
    });
    shotControls.dataset.bound = '1';
  }
  if (playerSelect && !playerSelect.dataset.bound) {
    playerSelect.addEventListener('change', () => {
      LAB_STATE.player = playerSelect.value;
      renderAnalyticsLab();
    });
    playerSelect.dataset.bound = '1';
  }
  if (compareSelect && !compareSelect.dataset.bound) {
    compareSelect.addEventListener('change', () => {
      LAB_STATE.compare = compareSelect.value;
      renderAnalyticsLab();
    });
    compareSelect.dataset.bound = '1';
  }
  if (garbage && !garbage.dataset.bound) {
    garbage.addEventListener('change', () => {
      LAB_STATE.garbageFilter = garbage.checked;
      renderAnalyticsLab();
    });
    garbage.dataset.bound = '1';
  }
  if (teamSelect && !teamSelect.dataset.bound) {
    teamSelect.addEventListener('change', () => {
      LAB_STATE.team = teamSelect.value;
      LAB_STATE.selected = currentRoster().slice(0, 5).map(p => p.name);
      LAB_STATE.advancedData = null;
      renderLineupLab();
      gatherAdvancedContext();
    });
    teamSelect.dataset.bound = '1';
  }
  if (minutes && !minutes.dataset.bound) {
    minutes.addEventListener('input', () => {
      LAB_STATE.minutes = Number(minutes.value);
      if (minutesVal) minutesVal.textContent = `${LAB_STATE.minutes}+`;
      renderPropCards();
    });
    minutes.dataset.bound = '1';
  }
  if (rest && !rest.dataset.bound) {
    rest.addEventListener('change', () => {
      LAB_STATE.restEdge = rest.checked;
      renderPropCards();
    });
    rest.dataset.bound = '1';
  }
  const gatherBtn = document.getElementById('dataGatherBtn');
  if (gatherBtn && !gatherBtn.dataset.bound) {
    gatherBtn.addEventListener('click', gatherAdvancedContext);
    gatherBtn.dataset.bound = '1';
  }
  const nlBtn = document.getElementById('nlSearchBtn');
  if (nlBtn && !nlBtn.dataset.bound) {
    nlBtn.addEventListener('click', runNaturalSearch);
    nlBtn.dataset.bound = '1';
  }
  const nlInput = document.getElementById('nlSearchInput');
  if (nlInput && !nlInput.dataset.bound) {
    nlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') runNaturalSearch();
    });
    nlInput.dataset.bound = '1';
  }
  const shareBtn = document.getElementById('shareRadarBtn');
  if (shareBtn && !shareBtn.dataset.bound) {
    shareBtn.addEventListener('click', () => {
      copyShareText(buildPlayerProfile(LAB_STATE.player), buildPlayerProfile(LAB_STATE.compare));
    });
    shareBtn.dataset.bound = '1';
  }
  try {
    if (LAB_STATE.rosterReady) {
      renderAnalyticsLab();
      renderLineupLab();
      runNaturalSearch();
    } else {
      renderAnalyticsLabSkeleton();
      renderLineupLab();
    }
  } catch (err) {
    console.warn('[PM] Analytics lab init render error:', err);
  }
}

// ── GLOBAL SEARCH ─────────────────────────────────────
let SEARCH_INDEX = [];

function rebuildSearchIndex() {
  const items = [];
  // All stat leaders
  Object.entries(window.PMData?.LEADERS || {}).forEach(([cat, players]) => {
    players.forEach(p => items.push({ type: 'player', name: p.name, sub: `${p.team} · ${cat.toUpperCase()} ${p.val}`, cat }));
  });
  // Standings teams
  ['west', 'east'].forEach(conf => {
    (window.PMData?.STANDINGS?.[conf] || []).forEach(t => {
      items.push({ type: 'team', name: t.team, sub: `${t.abbr} · ${conf.toUpperCase()} #${t.seed} · ${t.record}` });
      items.push({ type: 'team', name: t.abbr, sub: `${t.team} · ${conf.toUpperCase()} #${t.seed}` });
    });
  });
  // Live games
  (window.PMData?.SCOREBOARD || []).forEach(g => {
    const score = g.status === 2
      ? `LIVE Q${g.period}  ${g.away.score}–${g.home.score}`
      : g.status === 3 ? `FINAL ${g.away.score}–${g.home.score}` : 'Upcoming';
    items.push({ type: 'game', name: `${g.away.tricode} vs ${g.home.tricode}`, sub: score });
  });
  // On This Day
  (window.PMData?.OTD || []).forEach(m => {
    items.push({ type: 'history', name: m.headline, sub: String(m.year) });
    m.players.forEach(p => items.push({ type: 'history', name: p, sub: m.year + ' · ' + m.tag }));
  });
  [
    ['Who led clutch scoring this month?', 'Natural language stat search'],
    ['Best 5-man lineup by net rating', 'Lineup Lab'],
    ['Shot zones and density heat map', 'Player Analytics Lab'],
    ['Prop context with minutes threshold', 'Prop Lab'],
  ].forEach(([name, sub]) => items.push({ type: 'query', name, sub }));
  SEARCH_INDEX = items;
}
const _rebuildSearchIndexDebounced = window.debounce ? debounce(rebuildSearchIndex, 300) : rebuildSearchIndex;

function handleGlobalSearch(query) {
  const q = query.toLowerCase().trim();
  const list = document.getElementById('leadersList');
  if (!list) return;

  const index = [...SEARCH_INDEX];

  if (!q) { renderLeaders(document.querySelector('.ltab.active')?.dataset?.cat || 'pts'); return; }

  const seen = new Set();
  const matches = index.filter(item => {
    const key = item.name + item.sub;
    if (seen.has(key)) return false;
    if (item.name.toLowerCase().includes(q) || item.sub.toLowerCase().includes(q)) {
      seen.add(key);
      return true;
    }
    return false;
  }).slice(0, 8);

  if (!matches.length) {
    list.innerHTML = `<div style="padding:24px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--muted)">NO RESULTS FOR "${esc(query.toUpperCase())}"</div>`;
    return;
  }

  const typeColors = { player: 'var(--lime)', team: 'var(--blue)', history: 'var(--amber)', game: 'var(--coral)', query: 'var(--coral)' };
  list.innerHTML = matches.map((item, i) => `
    <div class="leader-row" style="cursor:pointer" data-type="${esc(item.type)}" data-name="${esc(item.name)}">
      <div class="l-rank" style="color:${typeColors[item.type]};font-size:9px">${esc(item.type.toUpperCase().slice(0, 3))}</div>
      <div class="l-info" style="flex:1">
        <div class="l-name">${esc(item.name)}</div>
        <div class="l-team">${esc(item.sub)}</div>
      </div>
      <svg width="10" height="10" style="color:var(--muted);flex-shrink:0">
        <use href="#icon-chevron-right"/>
      </svg>
    </div>`).join('');

  // Add click handler after rendering
  list.querySelectorAll('.leader-row[data-type]').forEach(row => {
    row.addEventListener('click', () => {
      const type = row.dataset.type;
      const name = row.dataset.name;
      // Clear search
      const searchInput = document.getElementById('globalSearch');
      if (searchInput) searchInput.value = '';
      if (type === 'player') {
        const ptsTab = document.querySelector('.ltab[data-cat="pts"]');
        if (ptsTab) ptsTab.click();
      } else if (type === 'team') {
        const conf = (['west', 'east']).find(c =>
          (window.PMData?.STANDINGS?.[c] ?? []).some(t => t.team === name || t.abbr === name)
        );
        const panel = document.querySelector('.standings-panel');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (type === 'query') {
        const nl = document.getElementById('nlSearchInput');
        if (nl) nl.value = name;
        document.getElementById('discoveryLab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        runNaturalSearch();
      } else {
        renderLeaders('pts');
      }
    });
  });
}



// ── INITIALIZATION ─────────────────────────────────────
let tickerHandle = null;
let _dashInitialized = false;
window._pmSimActive = true; // Expose for shared.js

function initDashboard() {
  if (_dashInitialized) return; // Guard against double init
  _dashInitialized = true;
  if (tickerHandle) { tickerHandle.clear(); tickerHandle = null; }

  // ── HYDRATE DYNAMIC LABELS ──
  const now = new Date();
  const yr = now.getFullYear();
  const mo = now.getMonth(); // 0-indexed
  // NBA season spans Oct–Jun, so Oct-Dec = this year, Jan-Jun = last year started
  const seasonStart = mo >= 9 ? yr : yr - 1; // Oct(9)+ = current year
  const seasonEnd = seasonStart + 1;
  const seasonStr = `${seasonStart}–${String(seasonEnd).slice(-2)} SEASON`;
  const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  const seasonLabel = document.getElementById('pmSeasonLabel');
  if (seasonLabel) seasonLabel.textContent = `STATS: ${seasonStr} · LIVE`;
  const mvpSeasonLabel = document.getElementById('mvpSeasonLabel');
  if (mvpSeasonLabel) mvpSeasonLabel.textContent = seasonStr;
  const calMonthBadge = document.getElementById('calMonthBadge');
  if (calMonthBadge) calMonthBadge.textContent = `${MONTHS_SHORT[mo]} ${yr}`;
  // ── GAME TIMELINE SKELETON ──
  (function () {
    const timeline = document.querySelector('.games-timeline');
    if (!timeline) return;
    const existingChips = timeline.querySelectorAll('.game-chip');
    if (existingChips.length === 0) {
      timeline.innerHTML = Array(6).fill('<div class="gc-skeleton"></div>').join('');
    }
    existingChips.forEach((chip, i) => {
      chip.style.opacity = '0';
      chip.style.transform = 'translateY(6px)';
      chip.style.transition = `opacity .3s ${i * 60}ms, transform .3s ${i * 60}ms`;
      requestAnimationFrame(() => {
        chip.style.opacity = '1';
        chip.style.transform = 'translateY(0)';
      });
    });
  })();

  // ── TAB PILL ──
  const tabs = document.querySelectorAll('.ttab[data-view]');
  tabs.forEach((t, i, all) => {
    t.addEventListener('click', () => {
      setDashView(t.dataset.view, t);
    });
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') {
        const next = all[(i + 1) % all.length];
        setDashView(next.dataset.view, next);
        next.focus();
      } else if (e.key === 'ArrowLeft') {
        const prev = all[(i - 1 + all.length) % all.length];
        setDashView(prev.dataset.view, prev);
        prev.focus();
      }
    });

    // Initial accessibility state
    if (t.classList.contains('active')) {
      t.setAttribute('tabindex', '0');
    } else {
      t.setAttribute('tabindex', '-1');
    }
  });
  const activeTab = document.querySelector('.ttab.active');
  if (activeTab) setTimeout(() => movePill(activeTab), 50);

  // ── LIVE SCORE SIM ──
  let lScore = 125, rScore = 125, tMin = 0, tSec = 19, quarter = 4, gameOver = false;
  function flashScore(el) {
    if (!el) return;
    el.style.transition = 'none';
    el.style.color = '#fff';
    el.style.textShadow = '0 0 8px rgba(255,255,255,.6)';
    requestAnimationFrame(() => {
      setTimeout(() => {
        el.style.transition = 'color .6s, text-shadow .6s';
        el.style.color = '';
        el.style.textShadow = '';
      }, 120);
    });
  }
  function syncTicker(scoredSide) {
    const tkL = document.getElementById('tkL'), tkR = document.getElementById('tkR'), tkProb = document.getElementById('tkProb');
    if (tkL) tkL.textContent = lScore;
    if (tkR) tkR.textContent = rScore;
    if (tkProb) tkProb.style.width = Math.round((lScore / (lScore + rScore)) * 100) + '%';
    const sb = document.getElementById('sbLive');
    if (sb) {
      sb.textContent = `${lScore}–${rScore} Q${quarter}`;
    } else {
      const activePill = document.querySelector('.team-pill.active .tp-rec');
      if (activePill) activePill.textContent = `${lScore}–${rScore} Q${quarter}`;
    }
    if (scoredSide) {
      flashScore(scoredSide === 'l' ? tkL : tkR);
      const announcement = document.getElementById('scoreAnnouncer');
      if (announcement) {
        announcement.textContent = `Score update: ${lScore} to ${rScore}, Quarter ${quarter}`;
      }
    }
  }

  if (window.visibilityInterval) {
    tickerHandle = window.visibilityInterval(() => {
      if (!window._pmSimActive || gameOver) {
        if (tickerHandle) tickerHandle.clear();
        return;
      }
      if (tSec > 0) tSec--; else if (tMin > 0) { tMin--; tSec = 59; } else {
        gameOver = true;
        if (tickerHandle) tickerHandle.clear();
        return;
      }
      if (Math.random() > .72) {
        const h = Math.random() > .5;
        const pts = Math.random() > .4 ? 2 : 3;
        if (h) { lScore += pts; syncTicker('l'); } else { rScore += pts; syncTicker('r'); }
      } else {
        syncTicker();
      }
    }, 1000);
    if (!window._pmPagehideBound) {
      window._pmPagehideBound = true;
      window.addEventListener('pagehide', () => { if (tickerHandle) tickerHandle.clear(); });
    }
  }
  syncTicker();

  // ── CALENDAR ──
  // Prefer live schedule from shared.js (fetched from /api/schedule).
  // Falls back to a minimal static set so the calendar is never completely empty.
  function getLiveSchedule() {
    return window._pmSchedule ?? {};
  }

  // Static fallback for current month — will be overwritten when live data arrives
  const SCHEDULE_FALLBACK = {};

  // Use real today's date (not hardcoded 2026-04-10)
  let viewDate = (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); })();
  const today = new Date();

  let _calLastMonth = -1, _calLastYear = -1, _calLastHash = '';

  function renderCalendar(force) {
    const schedule = getLiveSchedule();
    const y = viewDate.getFullYear(), m = viewDate.getMonth();

    // Skip full DOM rebuild if month and schedule haven't changed (perf optimisation)
    const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}`;
    const schedHash = Object.keys(schedule).filter(k => k.startsWith(monthPrefix)).sort().join(',');
    if (!force && y === _calLastYear && m === _calLastMonth && schedHash === _calLastHash) return;
    _calLastYear = y; _calLastMonth = m; _calLastHash = schedHash;

    const label = document.getElementById('calMonthLabel');
    if (label) label.textContent = viewDate.toLocaleString('default', { month: 'long', year: 'numeric' });
    const container = document.getElementById('calDays');
    if (!container) return;
    
    const frag = document.createDocumentFragment();

    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();

    let totalGames = 0, gameDays = 0;

    for (let i = firstDay - 1; i >= 0; i--) {
      const d = document.createElement('div');
      d.className = 'cal-day other-month';
      d.textContent = prevDays - i;
      frag.appendChild(d);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement('div');
      const dateKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = y === today.getFullYear() && m === today.getMonth() && d === today.getDate();
      const games = schedule[dateKey];
      const hasGames = !!games;
      const gameCount = games ? games.length : 0;
      let cls = 'cal-day';
      if (isToday) cls += ' today';
      if (hasGames) cls += ' has-games';
      if (gameCount >= 2 && gameCount < 5) cls += ' multi-game';
      if (gameCount >= 5) cls += ' big-slate';
      cell.className = cls;
      cell.textContent = d;

      if (hasGames) {
        totalGames += games.length;
        gameDays++;
        // Keyboard-accessible game-day cells (WCAG 2.1.1)
        cell.setAttribute('tabindex', '0');
        cell.setAttribute('role', 'button');
        cell.setAttribute('aria-label',
          `${new Date(y, m, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}: ${gameCount} game${gameCount > 1 ? 's' : ''}`);
        if (games.length > 1) {
          const gc = document.createElement('span');
          gc.className = 'game-count';
          gc.textContent = games.length + 'g';
          cell.appendChild(gc);
        }
        cell.dataset.games = JSON.stringify(games);
        cell.dataset.dateLabel = new Date(y, m, d).toLocaleDateString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric'
        });
      }
      frag.appendChild(cell);
    }
    
    // Fill remaining to complete 6 rows (42 cells)
    const totalCells = frag.childElementCount;
    const rows6 = 42;
    const remaining = rows6 - totalCells;
    for (let d = 1; d <= remaining; d++) {
      const div = document.createElement('div');
      div.className = 'cal-day other-month';
      div.textContent = d;
      frag.appendChild(div);
    }

    container.innerHTML = '';
    container.appendChild(frag);

    const gCount = document.getElementById('calGameCount');
    if (gCount) gCount.textContent = totalGames;
    const gDays = document.getElementById('calGameDays');
    if (gDays) gDays.textContent = gameDays;

    const todayDateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    let foundNext = false;
    const nextGameEl = document.getElementById('calNextGame');
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    for (let d = today.getDate(); d <= daysInMonth; d++) {
      const dk = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (schedule[dk] && dk >= todayDateKey) {
        if (nextGameEl) nextGameEl.textContent = dk === todayDateKey ? 'TODAY' : `${months[m]} ${d}`;
        foundNext = true;
        break;
      }
    }
    if (!foundNext && nextGameEl) nextGameEl.textContent = '—';
  }
  renderCalendar();
  window.renderCalendar = renderCalendar;

  const prevBtn = document.getElementById('calPrev');
  if (prevBtn) prevBtn.addEventListener('click', () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1); renderCalendar(); });
  const nextBtn = document.getElementById('calNext');
  if (nextBtn) nextBtn.addEventListener('click', () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1); renderCalendar(); });

  // ── CALENDAR TOOLTIP ──
  let calTooltip = document.getElementById('calTooltip');
  if (!calTooltip) {
    calTooltip = document.createElement('div');
    calTooltip.id = 'calTooltip';
    calTooltip.className = 'cal-tooltip';
    document.body.appendChild(calTooltip);
  }

  const calDaysContainer = document.getElementById('calDays');
  if (calDaysContainer) {
    calDaysContainer.addEventListener('mouseover', (e) => {
      const day = e.target.closest('.cal-day.has-games');
      if (!day || !day.dataset.games) return;

      const games = JSON.parse(day.dataset.games);
      const dateLabel = day.dataset.dateLabel || 'GAME DAY';

      let html = `<div class="cal-tooltip-date">${dateLabel.toUpperCase()}</div>`;
      games.forEach(g => {
        const tv = g.tv ? `<span class="gc-channel">${g.tv}</span>` : '';
        html += `
          <div class="cal-tt-game">
            <div class="gc-team-dot" style="background:#555"></div>
            <div class="cal-tt-teams">${g.away} @ ${g.home}</div>
            <div class="cal-tt-time">
              ${tv}
              <span style="color:var(--muted)">${g.time}</span>
            </div>
          </div>
        `;
      });
      calTooltip.innerHTML = html;

      const r = day.getBoundingClientRect();
      calTooltip.style.visibility = 'hidden';
      calTooltip.style.left = '-9999px';
      calTooltip.style.top = '-9999px';
      calTooltip.classList.add('visible');

      requestAnimationFrame(() => {
        const tooltipRect = calTooltip.getBoundingClientRect();
        
        // Pure fixed positioning — no scroll offset needed
        let top = r.top - tooltipRect.height - 8;
        let left = r.left + (r.width / 2) - (tooltipRect.width / 2);

        // Bounds checks
        if (top < 10) top = r.bottom + 8;
        if (left < 10) left = 10;
        if (left + tooltipRect.width > window.innerWidth - 10) {
          left = window.innerWidth - tooltipRect.width - 10;
        }

        calTooltip.style.cssText = `position:fixed;top:${top}px;left:${left}px;visibility:visible`;
      });
    });

    calDaysContainer.addEventListener('mouseout', (e) => {
      const day = e.target.closest('.cal-day.has-games');
      if (day) {
        calTooltip.classList.remove('visible');
      }
    });

    // Keyboard support for game-day cells (WCAG 2.1.1)
    calDaysContainer.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('has-games')) {
        e.preventDefault();
        if (calTooltip.classList.contains('visible')) {
          calTooltip.classList.remove('visible');
        } else {
          e.target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }
      }
    });

    calDaysContainer.addEventListener('focusout', () => {
      calTooltip.classList.remove('visible');
    });
  }

  // ── LEADERS ──
  const leadersTabs = document.getElementById('leadersTabs');
  const ltabRail = document.getElementById('ltabRail');

  function moveLtabRail(el) {
    if (!ltabRail) return;
    const r = el.getBoundingClientRect(),
      pr = el.parentElement.getBoundingClientRect();
    ltabRail.style.left = (r.left - pr.left) + 'px';
    ltabRail.style.width = r.width + 'px';
  }

  function activateLtab(el) {
    const ltabs = document.querySelectorAll('.ltab[data-cat]');
    ltabs.forEach(x => {
      x.classList.remove('active');
      x.setAttribute('aria-selected', 'false');
      x.setAttribute('tabindex', '-1');
    });
    el.classList.add('active');
    el.setAttribute('aria-selected', 'true');
    el.setAttribute('tabindex', '0');
    moveLtabRail(el);
    renderLeaders(el.dataset.cat);
  }

  if (leadersTabs) {
    leadersTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.ltab[data-cat]');
      if (tab) activateLtab(tab);
    });

    leadersTabs.addEventListener('keydown', (e) => {
      const tab = e.target.closest('.ltab[data-cat]');
      if (!tab) return;

      const ltabs = Array.from(document.querySelectorAll('.ltab[data-cat]'));
      const i = ltabs.indexOf(tab);

      if (e.key === 'ArrowRight') {
        const next = ltabs[i + 1] || ltabs[0];
        activateLtab(next);
        next.focus();
      } else if (e.key === 'ArrowLeft') {
        const prev = ltabs[i - 1] || ltabs[ltabs.length - 1];
        activateLtab(prev);
        prev.focus();
      }
    });
  }

  // ── ON THIS DAY — rendered by shared.js refreshOTD()
  // called on DOMContentLoaded via _pmBootstrap, but we also call it here
  // in case shared.js loaded first (data.js ensures PMData.OTD is set)
  if (typeof window.refreshOTD === 'function') {
    window.refreshOTD();
  }

  // ── STANDINGS ──
  window.renderStandings = renderStandings;
  renderStandings('west', 'standingsListWest');
  renderStandings('east', 'standingsListEast');



  _rebuildSearchIndexDebounced();
  renderLeaders('pts');
  initAnalyticsLab();
  if (!window.PM_CONFIG?.isFile) {
    setTimeout(gatherAdvancedContext, 700);
  }
  const firstLtab = document.querySelector('.ltab.active');
  if (firstLtab) moveLtabRail(firstLtab);
}

// Global search handling
window.handleGlobalSearch = handleGlobalSearch;
window.setDashView = setDashView;
window.initDashboard = initDashboard;
window.initAnalyticsLab = initAnalyticsLab;
window.renderLeaders = renderLeaders;
window.renderStandings = renderStandings;

if (window.PMData) {
  window.PMData.on('standings:updated', (data) => {
    window.PMData.STANDINGS = data;
    renderStandings('west', 'standingsListWest');
    renderStandings('east', 'standingsListEast');
    _rebuildSearchIndexDebounced();
    document.querySelectorAll('.standings-panel .panel-badge').forEach(b => {
      b.textContent = 'LIVE';
      b.style.background = 'rgba(255,75,38,.15)';
      b.style.color = 'var(--coral)';
    });
  });

  window.PMData.on('leaders:updated', () => {
    const activeCat = document.querySelector('.ltab.active')?.dataset?.cat ?? 'pts';
    renderLeaders(activeCat);
    renderMVPRace();
    populateLabSelects();
    renderAnalyticsLab();
    _rebuildSearchIndexDebounced();
  });

  window.PMData.on('schedule:updated', (schedule) => {
    window._pmSchedule = schedule;
    if (typeof window.renderCalendar === 'function') window.renderCalendar();
  });

  window.PMData.on('scoreboard:updated', (games) => {
    window.PMData.SCOREBOARD = games;
    renderWinProbability(buildPlayerProfile(LAB_STATE.player));
    _rebuildSearchIndexDebounced();
    if (tickerHandle) {
      tickerHandle.clear();
      tickerHandle = null;
    }
  });

  // Initial dashboard load
  setDashView('today');
}

// ── BOOTSTRAP ──
// Note: shared.js also calls initDashboard() via _pmBootstrap.
// The _dashInitialized guard prevents double initialization.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboard);
} else {
  setTimeout(initDashboard, 10);
}

// ── UX RESILIENCE ──
// Listen for bfcache restores
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    console.log('[PM] bfcache restore — re-syncing meta');
    if (typeof window.syncMeta === 'function') window.syncMeta();
    if (typeof window.refreshLiveUI === 'function') window.refreshLiveUI();
  }
});

// ── TICKER CLOCK ───────────────────────────────────────
// Only start the interval if the tkClock element exists (dashboard pages only)
if (document.getElementById('tkClock')) {
  setInterval(() => {
    const clock = document.getElementById('tkClock');
    if (clock) {
      const now = new Date();
      clock.textContent = now.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
      }).replace(/\s/g, ' ');
    }
  }, 1000);
}

// ── PM CHAT WIDGET ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// PREDICTIONS MODULE
// Talks to the Python FastAPI backend via the Cloudflare Worker proxy.
// Worker route: /api/predict?home=X&away=Y  →  backend /api/predict
//               /api/slate                  →  backend /api/slate
// ═══════════════════════════════════════════════════════════════════════════

const IS_LOCAL_DEV = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const PRED_BACKEND = window.resolvePredictionApiBase
  ? window.resolvePredictionApiBase()
  : (IS_LOCAL_DEV ? 'http://127.0.0.1:8000' : 'https://nba-data-worker.lorenzbarangan112.workers.dev');

// ── State ───────────────────────────────────────────────────────────────────
let _predSection = null;
let _predLoading = null;
let _predError = null;
let _predCardsGrid = null;
let _predSlateSummary = null;
let _predTopPick = null;
let _predBadge = null;

function _initPredElements() {
  _predSection     = document.getElementById('predictionsSection');
  _predLoading     = document.getElementById('predLoading');
  _predError       = document.getElementById('predError');
  _predCardsGrid   = document.getElementById('predCardsGrid');
  _predSlateSummary = document.getElementById('predSlateSummary');
  _predTopPick     = document.getElementById('predTopPick');
  _predBadge       = document.getElementById('predBadge');
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function _predShowLoading(msg) {
  if (_predLoading) {
    const t = document.getElementById('predLoadingText');
    if (t) t.textContent = msg || 'Running ML model + Groq analysis…';
    _predLoading.style.display = 'flex';
  }
  if (_predError) _predError.style.display = 'none';
  if (_predCardsGrid) _predCardsGrid.innerHTML = '';
  if (_predSlateSummary) _predSlateSummary.style.display = 'none';
}

function _predHideLoading() {
  if (_predLoading) _predLoading.style.display = 'none';
}

function _predShowError(msg) {
  _predHideLoading();
  if (_predError) {
    const t = document.getElementById('predErrorText');
    if (t) t.textContent = msg;
    _predError.style.display = 'flex';
  }
}

// ── Confidence star helper ────────────────────────────────────────────────────
function _confStars(conf) {
  const map = { high: '★★★', medium: '★★☆', low: '★☆☆' };
  return map[conf] || '★☆☆';
}

// ── Build a single prediction card HTML ─────────────────────────────────────
function _buildPredCard(game, delay) {
  const home = esc(game.home_team || game.home || '???');
  const away = esc(game.away_team || game.away || '???');
  const ml   = game.ml_probs || game.final_probs || {};
  const ai   = game.ai_analysis || {};
  const elo  = game.elo || {};

  const homeProb = Math.round((ml.home_win || 0.5) * 100);
  const awayProb = 100 - homeProb;
  const homeWins = homeProb >= awayProb;
  const conf     = (ai.confidence || 'low').toLowerCase();
  const margin   = ai.expected_margin ? `±${Math.abs(ai.expected_margin)} pts` : '';
  const insight  = esc(ai.key_insight || '');
  const risk     = ai.risk_factor ? `RISK: ${esc(ai.risk_factor)}` : '';
  const isUpset  = ai.upset_alert ? 'upset-alert' : '';
  const upsetTag = ai.upset_alert
    ? `<span class="pred-b2b-tag" style="background:rgba(255,179,0,.1);color:var(--amber)">⚡ UPSET WATCH</span>` : '';

  const b2bHome = game.home_b2b ? `<span class="pred-b2b-tag">${home} B2B</span>` : '';
  const b2bAway = game.away_b2b ? `<span class="pred-b2b-tag">${away} B2B</span>` : '';

  const eloRow = (elo.home || elo.away) ? `
    <div class="pred-elo-row">
      <span>ELO</span>
      <span><span class="pred-elo-val">${esc(String(elo.home || '—'))}</span> vs <span class="pred-elo-val">${esc(String(elo.away || '—'))}</span></span>
    </div>` : '';

  // Polymarket row if available
  const poly = game.layers?.polymarket;
  const polyRow = poly ? `
    <div class="pred-poly-row">
      <div class="pred-poly-dot"></div>
      <span>POLYMARKET</span>
      <span style="margin-left:auto">
        <span class="pred-poly-val">${home} ${Math.round(poly.home_win * 100)}%</span>
        <span style="color:var(--border);margin:0 4px">/</span>
        <span>${away} ${Math.round(poly.away_win * 100)}%</span>
      </span>
    </div>` : '';

  return `
  <div class="pred-card ${isUpset}" style="animation-delay:${delay}ms">
    <div class="pred-card-header">
      <div class="pred-teams">
        <div class="pred-team-row">
          <span class="pred-team-abbr ${homeWins ? 'winner' : 'loser'}">${home}</span>
          <span class="pred-team-label">HOME</span>
          <div class="pred-prob-bar-wrap">
            <div class="pred-prob-bar ${homeWins ? 'winner' : 'loser'}" style="width:${homeProb}%"></div>
          </div>
          <span class="pred-prob-pct ${homeWins ? 'winner' : 'loser'}">${homeProb}%</span>
        </div>
        <div class="pred-team-row">
          <span class="pred-team-abbr ${!homeWins ? 'winner' : 'loser'}">${away}</span>
          <span class="pred-team-label">AWAY</span>
          <div class="pred-prob-bar-wrap">
            <div class="pred-prob-bar ${!homeWins ? 'winner' : 'loser'}" style="width:${awayProb}%"></div>
          </div>
          <span class="pred-prob-pct ${!homeWins ? 'winner' : 'loser'}">${awayProb}%</span>
        </div>
      </div>
    </div>

    <div class="pred-meta">
      <span class="pred-conf-badge ${conf}">${_confStars(conf)} ${conf.toUpperCase()}</span>
      ${margin ? `<span class="pred-margin">${margin}</span>` : ''}
      ${upsetTag}${b2bHome}${b2bAway}
    </div>

    ${insight ? `<div class="pred-insight">${insight}</div>` : ''}
    ${risk ? `<div class="pred-risk">${risk}</div>` : ''}
    ${eloRow}
    ${polyRow}
  </div>`;
}

// ── LOAD TODAY'S SLATE ───────────────────────────────────────────────────────
async function loadPredictionSlate() {
  _initPredElements();
  if (!_predSection) return;

  _predSection.style.display = 'block';
  _predSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  _predShowLoading('Fetching today\'s games + running predictions…');
  if (_predBadge) _predBadge.textContent = 'LOADING…';

  const slateBtn = document.getElementById('predSlateBtn');
  const goBtn    = document.getElementById('predGoBtn');
  if (slateBtn) slateBtn.disabled = true;
  if (goBtn) goBtn.disabled = true;

  try {
    const res = await fetch(`${PRED_BACKEND}/api/slate`, { signal: AbortSignal.timeout(35000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    _predHideLoading();

    if (!data.games || data.games.length === 0) {
      _predShowError('No games scheduled today. Check back on a game day!');
      if (_predBadge) _predBadge.textContent = 'NO GAMES';
      return;
    }

    // Badge
    if (_predBadge) _predBadge.textContent = `${data.game_count} GAMES`;

    // Slate summary banner
    const sa = data.slate_analysis;
    if (sa && _predSlateSummary) {
      const summaryText = document.getElementById('predSlateSummaryText');
      if (summaryText) summaryText.textContent = sa.summary || '';
      if (sa.top_pick && _predTopPick) {
        const pickTeam = document.getElementById('predTopPickTeam');
        if (pickTeam) pickTeam.textContent = sa.top_pick.pick || '—';
        _predTopPick.style.display = 'flex';
      }
      _predSlateSummary.style.display = 'flex';
    }

    // Render cards
    if (_predCardsGrid) {
      _predCardsGrid.innerHTML = data.games.map((g, i) => _buildPredCard(g, i * 60)).join('');
    }

  } catch (err) {
    console.error('[Predictions] Slate load failed:', err);
    _predShowError(
      err.name === 'TimeoutError'
        ? 'Request timed out. The backend may still be loading the model.'
        : `Backend unavailable: ${err.message}. Make sure uvicorn is running on port 8000.`
    );
    if (_predBadge) _predBadge.textContent = 'OFFLINE';
  } finally {
    if (slateBtn) slateBtn.disabled = false;
    if (goBtn) goBtn.disabled = false;
  }
}

// ── SINGLE GAME PREDICTION ────────────────────────────────────────────────────
async function loadSinglePrediction(homeTeam, awayTeam) {
  _initPredElements();
  if (!_predSection) return;

  _predSection.style.display = 'block';
  _predSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  _predShowLoading(`Analyzing ${homeTeam.toUpperCase()} vs ${awayTeam.toUpperCase()}…`);
  if (_predBadge) _predBadge.textContent = 'ANALYZING…';

  const goBtn = document.getElementById('predGoBtn');
  if (goBtn) goBtn.disabled = true;

  try {
    const url = `${PRED_BACKEND}/api/predict?home=${encodeURIComponent(homeTeam)}&away=${encodeURIComponent(awayTeam)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    _predHideLoading();
    if (_predBadge) _predBadge.textContent = `${homeTeam.toUpperCase()} vs ${awayTeam.toUpperCase()}`;

    if (_predCardsGrid) {
      // Single card, full width
      const cardHtml = _buildPredCard({
        home_team: homeTeam.toUpperCase(),
        away_team: awayTeam.toUpperCase(),
        ml_probs: data.final_probs || data.layers?.ml_model,
        ai_analysis: data.ai_analysis,
        elo: data.elo,
        layers: data.layers,
      }, 0);
      _predCardsGrid.innerHTML = `<div style="grid-column:1/-1;max-width:520px">${cardHtml}</div>`;
    }

  } catch (err) {
    console.error('[Predictions] Single predict failed:', err);
    _predShowError(
      err.name === 'TimeoutError'
        ? 'Request timed out. The ML model may still be warming up.'
        : `Prediction failed: ${err.message}`
    );
    if (_predBadge) _predBadge.textContent = 'ERROR';
  } finally {
    if (goBtn) goBtn.disabled = false;
  }
}

// ── INIT PREDICTIONS UI ───────────────────────────────────────────────────────
function initPredictions() {
  // Nav item click — show panel
  const navPred = document.getElementById('navPredictions');
  if (navPred) {
    navPred.addEventListener('click', (e) => {
      e.preventDefault();
      _initPredElements();
      if (!_predSection) return;

      // Mark nav item active
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      navPred.classList.add('active');

      // Show panel, scroll to it
      _predSection.style.display = 'block';
      _predSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Auto-load slate the first time
      if (!_predCardsGrid || _predCardsGrid.innerHTML.trim() === '') {
        loadPredictionSlate();
      }
    });
  }

  // Slate button
  const slateBtn = document.getElementById('predSlateBtn');
  if (slateBtn) {
    slateBtn.addEventListener('click', () => loadPredictionSlate());
  }

  // Single predict button
  const goBtn = document.getElementById('predGoBtn');
  if (goBtn) {
    goBtn.addEventListener('click', () => {
      const homeEl = document.getElementById('predHomeInput');
      const awayEl = document.getElementById('predAwayInput');
      const home = (homeEl?.value || '').trim().toUpperCase();
      const away = (awayEl?.value || '').trim().toUpperCase();
      if (home.length < 2 || away.length < 2) {
        if (homeEl) homeEl.focus();
        return;
      }
      loadSinglePrediction(home, away);
    });
  }

  // Enter key on inputs
  ['predHomeInput', 'predAwayInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('predGoBtn')?.click();
      });
      // Auto-uppercase as user types
      el.addEventListener('input', () => { el.value = el.value.toUpperCase(); });
    }
  });
}

// Bootstrap predictions after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPredictions);
} else {
  initPredictions();
}

// Expose globally
window.loadPredictionSlate = loadPredictionSlate;
window.loadSinglePrediction = loadSinglePrediction;
