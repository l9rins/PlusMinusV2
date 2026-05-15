// predictions.js — Plus-Minus NBA AI Predictions
// Complete overhaul: expandable insights, AI disclaimers, probability-first, skeleton loading

// ── State ───────────────────────────────────────────────────────────────────
let _predSection, _predLoading, _predError, _predCardsGrid, _predSlateSummary,
    _predTopPick, _predBadge, _predConnecting, _predSkeletonGrid;

function _initPredElements() {
  _predSection      = document.getElementById('predictionsSection');
  _predLoading      = document.getElementById('predLoading');
  _predError        = document.getElementById('predError');
  _predCardsGrid    = document.getElementById('predCardsGrid');
  _predSlateSummary = document.getElementById('predSlateSummary');
  _predTopPick      = document.getElementById('predTopPick');
  _predBadge        = document.getElementById('predBadge');
  _predConnecting   = document.getElementById('predConnecting');
  _predSkeletonGrid = document.getElementById('predSkeletonGrid');
}

function _predShowLoading(msg) {
  if (_predLoading) {
    const t = document.getElementById('predLoadingText');
    if (t) t.textContent = msg || 'Running ML model + Groq analysis…';
    _predLoading.style.display = 'flex';
  }
  if (_predSkeletonGrid) _predSkeletonGrid.style.display = 'grid';
  if (_predError) _predError.style.display = 'none';
  if (_predConnecting) _predConnecting.style.display = 'none';
  if (_predCardsGrid) _predCardsGrid.innerHTML = '';
  if (_predSlateSummary) _predSlateSummary.style.display = 'none';
}

function _predHideLoading() {
  if (_predLoading) _predLoading.style.display = 'none';
  if (_predSkeletonGrid) _predSkeletonGrid.style.display = 'none';
}

function _predShowError(msg, isTimeout) {
  _predHideLoading();
  if (isTimeout || msg.includes('unavailable') || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    // Show friendly connecting state instead of raw error
    if (_predConnecting) {
      _predConnecting.style.display = 'flex';
      const retryBtn = document.getElementById('predRetryBtn');
      if (retryBtn) {
        retryBtn.onclick = () => {
          _predConnecting.style.display = 'none';
          loadPredictionSlate();
        };
      }
    }
    if (_predError) _predError.style.display = 'none';
  } else {
    if (_predError) {
      const t = document.getElementById('predErrorText');
      if (t) t.textContent = msg;
      _predError.style.display = 'flex';
    }
    if (_predConnecting) _predConnecting.style.display = 'none';
  }
}

// ── Build a single prediction card ───────────────────────────────────────────
function _buildPredCard(game, delay) {
  const esc = window.esc || (s => String(s ?? ''));
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
  const risk     = ai.risk_factor ? esc(ai.risk_factor) : '';
  const isUpset  = ai.upset_alert ? 'upset-alert' : '';
  const upsetTag = ai.upset_alert
    ? `<span class="pred-b2b-tag" style="background:rgba(255,179,0,.1);color:var(--amber)">⚡ UPSET WATCH</span>` : '';

  const b2bHome = game.home_b2b ? `<span class="pred-b2b-tag">${home} B2B</span>` : '';
  const b2bAway = game.away_b2b ? `<span class="pred-b2b-tag">${away} B2B</span>` : '';

  // Winner probability — the primary number
  const winnerTeam = homeWins ? home : away;
  const winnerProb = homeWins ? homeProb : awayProb;

  const eloRow = (elo.home || elo.away) ? `
    <div class="pred-elo-row">
      <span>ELO</span>
      <span><span class="pred-elo-val">${esc(String(elo.home || '—'))}</span> vs <span class="pred-elo-val">${esc(String(elo.away || '—'))}</span>
      ${elo.diff ? `<span class="pred-elo-diff ${elo.diff > 0 ? 'pos' : 'neg'}">(${elo.diff > 0 ? '+' : ''}${elo.diff})</span>` : ''}</span>
    </div>` : '';

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

  // Build "Why this prediction?" expandable section
  const homeForm = game.home_form || {};
  const awayForm = game.away_form || {};
  const drivers = [];
  
  if (homeForm.avg_NET_RTG !== undefined && awayForm.avg_NET_RTG !== undefined) {
    const netDiff = (parseFloat(homeForm.avg_NET_RTG) - parseFloat(awayForm.avg_NET_RTG)).toFixed(1);
    drivers.push(`${netDiff > 0 ? home : away} ${netDiff > 0 ? '+' : ''}${netDiff} NET RTG advantage`);
  }
  if (elo.diff) {
    drivers.push(`ELO gap: ${Math.abs(elo.diff)} pts ${elo.diff > 0 ? `(${home} favored)` : `(${away} favored)`}`);
  }
  if (game.home_b2b) drivers.push(`${home} on back-to-back (fatigue factor)`);
  if (game.away_b2b) drivers.push(`${away} on back-to-back (fatigue factor)`);
  if (homeForm.Streak) drivers.push(`${home} streak: ${homeForm.Streak > 0 ? 'W' : 'L'}${Math.abs(homeForm.Streak)}`);
  if (awayForm.Streak) drivers.push(`${away} streak: ${awayForm.Streak > 0 ? 'W' : 'L'}${Math.abs(awayForm.Streak)}`);
  if (homeForm.avg_eFG_PCT && awayForm.avg_eFG_PCT) {
    const efgDiff = (parseFloat(homeForm.avg_eFG_PCT) - parseFloat(awayForm.avg_eFG_PCT)).toFixed(3);
    if (Math.abs(efgDiff) > 0.01) {
      drivers.push(`eFG% edge: ${efgDiff > 0 ? home : away} (${efgDiff > 0 ? '+' : ''}${(efgDiff * 100).toFixed(1)}%)`);
    }
  }

  const driversHtml = drivers.length > 0 ? `
    <div class="pred-why-section">
      <button class="pred-why-toggle" onclick="this.parentElement.classList.toggle('open')">
        <svg class="lucide-icon" width="12" height="12"><use href="#icon-chevron-down"/></svg>
        <span>Why this prediction?</span>
      </button>
      <div class="pred-why-content">
        <div class="pred-drivers">
          ${drivers.slice(0, 4).map(d => `<div class="pred-driver-item">
            <div class="pred-driver-dot"></div>
            <span>${esc(d)}</span>
          </div>`).join('')}
        </div>
      </div>
    </div>` : '';

  const cardId = `pred-card-${home}-${away}`.replace(/\s/g, '');

  return `
  <div class="pred-card ${isUpset}" id="${cardId}" style="animation-delay:${delay}ms">
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
      <div class="pred-hero-prob">
        <div class="pred-hero-pct">${winnerProb}%</div>
        <div class="pred-hero-team">${winnerTeam}</div>
      </div>
    </div>
    <div class="pred-meta">
      <span class="pred-conf-badge ${conf}">${conf.toUpperCase()}</span>
      ${margin ? `<span class="pred-margin">${margin}</span>` : ''}
      ${upsetTag}${b2bHome}${b2bAway}
    </div>
    ${insight ? `
    <div class="pred-insight-wrap">
      <div class="pred-ai-badge">
        <svg class="lucide-icon" width="10" height="10"><use href="#icon-sparkles"/></svg>
        AI-GENERATED
      </div>
      <div class="pred-insight">${insight}</div>
    </div>` : ''}
    ${risk ? `<div class="pred-risk">RISK: ${risk}</div>` : ''}
    ${eloRow}
    ${polyRow}
    ${driversHtml}
    <div class="pred-top-players">
      <div class="pred-top-home" data-team="${home}">Loading top players…</div>
      <div class="pred-top-away" data-team="${away}">Loading top players…</div>
    </div>
  </div>`;
}

const PRED_BACKEND = window.resolvePredictionApiBase
  ? window.resolvePredictionApiBase()
  : (window.PRED_BACKEND || 'http://localhost:8000');
const PRED_WORKER = window.PM_WORKER || 'https://nba-data-worker.lorenzbarangan112.workers.dev';

let _predRetryCount = 0;
const MAX_RETRIES = 2;

async function loadPredictionSlate() {
  _initPredElements();
  if (!_predSection) return;
  _predSection.style.display = 'block';
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
    _predRetryCount = 0;
    if (!data.games || data.games.length === 0) {
      _predShowError('No games scheduled today. Check back on a game day!', false);
      if (_predBadge) _predBadge.textContent = 'NO GAMES';
      return;
    }
    if (_predBadge) _predBadge.textContent = `${data.game_count} GAMES`;
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
    if (_predCardsGrid) {
      _predCardsGrid.innerHTML = data.games.map((g, i) => _buildPredCard(g, i * 80)).join('');
      // After rendering cards, populate top players for each card
      (async function populateAllTopPlayers() {
        for (const g of data.games) {
          try {
            const home = (g.home_team || g.home).toUpperCase();
            const away = (g.away_team || g.away).toUpperCase();
            const cardId = `pred-card-${home}-${away}`.replace(/\s/g, '');
            const card = document.getElementById(cardId);
            if (!card) continue;
            const homeEl = card.querySelector('.pred-top-home');
            const awayEl = card.querySelector('.pred-top-away');
            if (homeEl) {
              try {
                const resH = await fetch(`${PRED_WORKER}/api/team_top_players?team=${encodeURIComponent(home)}&n=3`, { signal: AbortSignal.timeout(8000) });
                if (resH.ok) {
                  const jh = await resH.json();
                  homeEl.innerHTML = (jh.players || []).map(p => `<div class="tp-row">${p.name} ${p.pts.toFixed(1)} PTS / ${p.reb.toFixed(1)} REB / ${p.ast.toFixed(1)} AST</div>`).join('');
                } else {
                  homeEl.textContent = 'Top players unavailable';
                }
              } catch (e) { homeEl.textContent = 'Top players unavailable'; }
            }
            if (awayEl) {
              try {
                const resA = await fetch(`${PRED_WORKER}/api/team_top_players?team=${encodeURIComponent(away)}&n=3`, { signal: AbortSignal.timeout(8000) });
                if (resA.ok) {
                  const ja = await resA.json();
                  awayEl.innerHTML = (ja.players || []).map(p => `<div class="tp-row">${p.name} ${p.pts.toFixed(1)} PTS / ${p.reb.toFixed(1)} REB / ${p.ast.toFixed(1)} AST</div>`).join('');
                } else {
                  awayEl.textContent = 'Top players unavailable';
                }
              } catch (e) { awayEl.textContent = 'Top players unavailable'; }
            }
          } catch (err) {
            console.warn('[Predictions] populate top players failed', err);
          }
        }
      })();
    }
  } catch (err) {
    console.error('[Predictions] Slate load failed:', err);
    if (err.name === 'TimeoutError') {
      _predShowError('Request timed out. The prediction engine may still be loading the model.', true);
    } else {
      _predShowError(`Prediction engine unavailable. Please try again shortly.`, true);
    }
    if (_predBadge) _predBadge.textContent = 'CONNECTING…';
    // Auto-retry once after 5s
    if (_predRetryCount < MAX_RETRIES) {
      _predRetryCount++;
      setTimeout(() => loadPredictionSlate(), 5000);
    }
  } finally {
    if (slateBtn) slateBtn.disabled = false;
    if (goBtn) goBtn.disabled = false;
  }
}

async function loadSinglePrediction(homeTeam, awayTeam) {
  _initPredElements();
  if (!_predSection) return;
  _predSection.style.display = 'block';
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
      const cardHtml = _buildPredCard({
        home_team: homeTeam.toUpperCase(),
        away_team: awayTeam.toUpperCase(),
        ml_probs: data.final_probs || data.layers?.ml_model,
        ai_analysis: data.ai_analysis,
        elo: data.elo,
        layers: data.layers,
        home_form: data.home_form,
        away_form: data.away_form,
        home_b2b: data.home_form?.home_b2b,
        away_b2b: data.away_form?.away_b2b,
      }, 0);
      _predCardsGrid.innerHTML = `<div style="grid-column:1/-1;max-width:520px">${cardHtml}</div>`;
    }
  } catch (err) {
    console.error('[Predictions] Single predict failed:', err);
    if (err.name === 'TimeoutError') {
      _predShowError('Request timed out. The ML model may still be warming up.', true);
    } else {
      _predShowError(`Prediction unavailable. Please try again shortly.`, true);
    }
    if (_predBadge) _predBadge.textContent = 'RETRY';
  } finally {
    if (goBtn) goBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  _initPredElements();
  // Button handlers
  const slateBtn = document.getElementById('predSlateBtn');
  if (slateBtn) slateBtn.addEventListener('click', loadPredictionSlate);
  const goBtn = document.getElementById('predGoBtn');
  if (goBtn) goBtn.addEventListener('click', () => {
    const home = document.getElementById('predHomeInput').value.trim();
    const away = document.getElementById('predAwayInput').value.trim();
    if (home && away) loadSinglePrediction(home, away);
  });
  
  // Enter key support on inputs
  ['predHomeInput', 'predAwayInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const home = document.getElementById('predHomeInput').value.trim();
        const away = document.getElementById('predAwayInput').value.trim();
        if (home && away) loadSinglePrediction(home, away);
      }
    });
  });

  // Auto-load slate on page load
  loadPredictionSlate();

  // Nav rail positioning
  const activeNav = document.querySelector('.nav-item.active');
  if (activeNav) {
    const rail = document.getElementById('navRail');
    const nav = document.getElementById('sideNav');
    if (rail && nav) {
      const navRect = nav.getBoundingClientRect();
      const itemRect = activeNav.getBoundingClientRect();
      rail.style.top = (itemRect.top - navRect.top + nav.scrollTop) + 'px';
    }
  }
});
