// ─────────────────────────────────────────────────────────────────────────────
// Plus-Minus NBA — Cloudflare Worker  (worker.js)
import { OTD_ANCHORS } from './nba_otd_anchors.js';

// Single point of truth: all ESPN / NBA CDN calls happen HERE, never in browsers.
//
// Endpoints
//  GET /api/leaders    → season stat leaders          · KV cache 24 h
//  GET /api/standings  → conference standings         · KV cache  1 h
//  GET /api/scoreboard → today's live scores          · KV cache 60 s
//  GET /api/schedule   → upcoming + recent schedule   · KV cache 30 m
//  GET /api/team_top_players → team top-3 recent form · KV cache 15 m
//  GET /api/shot_zones → proxy to backend /api/shot_zones · no cache
//  GET /api/lineups    → proxy to backend /api/lineups    · no cache
//  GET /api/play_types → proxy to backend /api/play_types · no cache
//  GET /api/injuries   → proxy to backend /api/injuries   · no cache
//  GET /api/predict    → proxy to backend /api/predict · no cache
//  GET /api/slate      → proxy to backend /api/slate   · no cache
//  GET /api/proxy?url= → CORS pass-through            · no cache
//  GET /api/status     → health / cache info          · no cache
//
// Cron schedule (wrangler.toml):  "0 */6 * * *"  — pre-warm every 6 hours
//
// KV namespace binding in wrangler.toml:
//   [[kv_namespaces]]
//   binding = "PM_CACHE"
//   id = "<your-kv-namespace-id>"
// ─────────────────────────────────────────────────────────────────────────────

// ── Source URLs ──────────────────────────────────────────────────────────────
const ESPN_LEADERS = 'https://site.api.espn.com/apis/site/v3/sports/basketball/nba/leaders';
const ESPN_STANDINGS = 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings';
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const ESPN_SCHEDULE = (date) => `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`;
const NBA_SCOREBOARD = 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';
const NBA_STANDINGS = 'https://cdn.nba.com/static/json/liveData/standings/standings_00.json';

// ── KV TTLs (seconds) ────────────────────────────────────────────────────────
const TTL_LEADERS = 86400;  // 24 h — season stats barely change day-to-day
const TTL_STANDINGS = 3600;  //  1 h — W/L records update after each game
const TTL_SCOREBOARD = 60;  // 60 s — live scores; short but safe from rate limits
const TTL_SCHEDULE = 1800;   // 30 min — schedule/status can shift on game days
const TTL_TEAM_TOP_PLAYERS = 900; // 15 min — top-player form can stay warm for repeated slate loads
const NBA_TIME_ZONE = 'America/New_York';

// ── ESPN stat category name → internal key ───────────────────────────────────
// These must match the keys used in shared.js PMData.LEADERS
const ESPN_CAT_MAP = {
  pointsPerGame: 'pts',
  reboundsPerGame: 'reb',
  assistsPerGame: 'ast',
  stealsPerGame: 'stl',
  blocksPerGame: 'blk',

  '3PointsMadePerGame': 'tpm',
  threePointFieldGoalsMade: 'tpm',
  threePointFieldGoalMade: 'tpm',
  threePointsMadePerGame: 'tpm',
  '3-PointFieldGoalsMade': 'tpm',
  threePointersMade: 'tpm',
  threePointMade: 'tpm',
  threePtMade: 'tpm',
  '3ptMade': 'tpm',
};

// Categories that are integer season totals (not per-game decimals)
const INT_CATS = new Set([]);

// ── Team brand colors ────────────────────────────────────────────────────────
// Authoritative source. shared.js fetches these via /api/meta (syncMeta).
// When adding a team, update HERE — clients receive the change automatically.
const TEAM_COLORS = {
  ATL: '#E03A3E', BOS: '#007A33', BKN: '#000000', CHA: '#00788C', CHI: '#CE1141',
  CLE: '#860038', DAL: '#00538C', DEN: '#0E2240', DET: '#C8102E', GSW: '#1D428A',
  HOU: '#CE1141', IND: '#002D62', LAC: '#C8102E', LAL: '#552583', MEM: '#5D76A9',
  MIA: '#98002E', MIL: '#00471B', MIN: '#0C2340', NOP: '#0C2340', NYK: '#006BB6',
  OKC: '#007AC1', ORL: '#0077C0', PHI: '#006BB6', PHX: '#E56020', POR: '#E03C31',
  SAC: '#5A2D81', SAS: '#C4CED4',  TOR: '#CE1141', UTA: '#002B5C', WAS: '#002B5C',
};

const TEAM_COLORS_ALT = {
  ATL: '#C1D32F', BOS: '#BA9653', BKN: '#FFFFFF', CHA: '#1D1160', CHI: '#000000',
  CLE: '#041E42', DAL: '#007BC3', DEN: '#FEC524', DET: '#006BB6', GSW: '#FFC72C',
  HOU: '#000000', IND: '#FDB927', LAC: '#006BB6', LAL: '#FDB927', MEM: '#12173F',
  MIA: '#000000', MIL: '#EEE1C6', MIN: '#236192', NOP: '#B4975A', NYK: '#F58426',
  OKC: '#EF3B24', ORL: '#C4CED4', PHI: '#ED174C', PHX: '#1D1160', POR: '#000000',
  SAC: '#63727A', SAS: '#000000', TOR: '#000000', UTA: '#F9A01B', WAS: '#E31837',
};

// ── CORS headers ─────────────────────────────────────────────────────────────
// Internal default — overridden per-request by corsHeaders() in the fetch handler.
const CORS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Set ALLOWED_ORIGINS in wrangler.toml [vars] or via `wrangler secret put ALLOWED_ORIGINS`.
// Comma-separated, e.g. "https://myapp.pages.dev"
// Note: all localhost / 127.0.0.1 origins are always allowed in development.
const _DEFAULT_ORIGINS = new Set([
  'http://localhost:8080', 'http://localhost:3000', 'http://localhost:5500',
  'http://127.0.0.1:8080', 'http://127.0.0.1:3000', 'http://127.0.0.1:5500',
]);

/** Returns true if the origin is any localhost / loopback port — always safe to allow in dev. */
function _isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** Build CORS headers with origin checking — blocks requests from unknown origins. */
function corsHeaders(request, env) {
  const origin = request?.headers?.get('Origin') ?? '';
  const explicit = env?.ALLOWED_ORIGINS
    ? new Set(env.ALLOWED_ORIGINS.split(',').map(s => s.trim()))
    : _DEFAULT_ORIGINS;

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  // Allow any localhost/127.0.0.1 origin (any port) plus explicit production list
  if (_isLocalOrigin(origin) || explicit.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// ── Allowed upstream hosts for the /api/proxy pass-through ───────────────────
const PROXY_ALLOWED = new Set([
  'site.api.espn.com',
  'cdn.nba.com',
  'stats.nba.com',
]);

// ── Browser-like headers — avoids 403s from CDNs ────────────────────────────
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, */*;q=0.9',
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─────────────────────────────────────────────────────────────────────────────
// WORKER ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Route — handlers return raw responses; CORS is applied at the boundary below
    let response;
    switch (url.pathname) {
      case '/api/leaders':    response = await handleLeaders(env); break;
      case '/api/standings':  response = await handleStandings(env); break;
      case '/api/scoreboard': response = await handleScoreboard(env); break;
      case '/api/schedule':   response = await handleSchedule(env, url); break;
      case '/api/team_top_players': response = await handleTeamTopPlayers(env, url); break;
      case '/api/full_roster': response = await handleBackendDataProxy(env, url, '/api/full_roster', 20000); break;
      case '/api/shot_zones': response = await handleBackendDataProxy(env, url, '/api/shot_zones', 12000); break;
      case '/api/lineups':    response = await handleBackendDataProxy(env, url, '/api/lineups', 20000); break;
      case '/api/play_types': response = await handleBackendDataProxy(env, url, '/api/play_types', 12000); break;
      case '/api/injuries':   response = await handleBackendDataProxy(env, url, '/api/injuries', 12000); break;
      case '/api/playerlog':  response = await handleBackendDataProxy(env, url, '/api/playerlog', 12000); break;
      case '/api/team_stats': response = await handleBackendDataProxy(env, url, '/api/team_stats', 12000); break;
      case '/api/predict':    response = await handlePredictProxy(env, url); break;
      case '/api/slate':      response = await handleSlateProxy(env, url); break;
      case '/api/backend-health': response = await handleBackendHealth(env); break;
      case '/api/proxy':      response = await handleProxy(url, env, request); break;
      case '/api/status':     response = await handleStatus(env); break;
      case '/api/meta':       response = await handleMeta(env); break;
      case '/api/otd':        response = await handleOTD(env, url); break;
      case '/api/chat':       response = await handleChat(env, request); break;
      case '/api/news':       response = await handleNews(env); break;
      default:
        response = new Response('Not found', { status: 404 });
    }

    // Apply origin-checked CORS to every response
    const out = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
    for (const [k, v] of Object.entries(cors)) {
      out.headers.set(k, v);
    }
    return out;
  },

  /**
   * Cron: pre-warm all caches every 6 hours.
   * Ensures users always hit KV, not origin (especially critical for leaders + standings).
   */
  async scheduled(event, env) {
    const tasks = [
      { label: 'leaders',    fn: () => handleLeaders(env) },
      { label: 'standings',  fn: () => handleStandings(env) },
      { label: 'scoreboard', fn: () => handleScoreboard(env) },
      { label: 'schedule',   fn: () => handleSchedule(env, null) },
      { label: 'otd', fn: () => {
        const now = new Date();
        const mmdd = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const mockUrl = new URL(`https://worker/api/otd?date=${mmdd}`);
        return handleOTD(env, mockUrl);
      }},
    ];

    const results = await Promise.allSettled(tasks.map(t => t.fn()));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[PM Cron] ✗ ${tasks[i].label}:`, r.reason?.message ?? r.reason);
      } else {
        console.log(`[PM Cron] ✓ ${tasks[i].label}`);
      }
    });
    // Surface failures as a Cloudflare Analytics data point
    const failCount = results.filter(r => r.status === 'rejected').length;
    if (failCount > 0) {
      console.error(`[PM Cron] ${failCount}/${tasks.length} tasks failed — check Worker logs`);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap a payload in a JSON response with CORS and cache-control headers */
function jsonOk(payload, extra = {}) {
  return Response.json(payload, {
    headers: {
      ...CORS,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'", // Workers usually don't need this but it's safe for data APIs
      ...extra
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/meta  — expose global configuration to clients
// ─────────────────────────────────────────────────────────────────────────────
async function handleMeta(env) {
  return jsonOk({
    TEAM_COLORS,
    versions: { worker: '1.2.1' },
    timestamp: Date.now()
  });
}

// ── /api/chat ───────────────────────────────────────────────────────────────
async function handleChat(env, request) {
  if (request.method !== 'POST') {
    return new Response('POST only', { status: 405, headers: CORS });
  }
  // Guard against oversized payloads before parsing body
  const contentLength = parseInt(request.headers.get('Content-Length') ?? '0');
  if (contentLength > 2048) {
    return new Response('Payload too large', { status: 413, headers: CORS });
  }
  if (!env.GROQ_API_KEY) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY not configured' }), {
      status: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await request.json(); } 
  catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }

  const userMsg = String(body.message ?? '').trim().slice(0, 500);
  if (!userMsg) return new Response('Missing message', { status: 400, headers: CORS });

  // Pull live context from KV to ground the model's answers
  const [{ value: leaders }, { value: standings }] = await Promise.all([
    kvGet(env, 'leaders_nba_v5'),
    kvGet(env, 'standings_espn_v5'),
  ]);

  const context = JSON.stringify({
    leaders: leaders ?? {},
    standings: standings ?? {},
    asOf: new Date().toISOString(),
  });

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: `You are PM, the Plus-Minus NBA assistant. Answer questions about NBA stats concisely (1-3 sentences max). Use the live data context below. If asked about something not in the data, say so honestly.\n\nLIVE DATA:\n${context}`
        },
        { role: 'user', content: userMsg }
      ]
    })
  });

  if (!res.ok) {
    console.error(`[Chat] Groq error: ${res.status}`);
    return new Response(JSON.stringify({ error: `AI service error (${res.status})` }), {
      status: 502, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
  const data = await res.json();
  const reply = data.choices[0]?.message?.content ?? 'No response generated.';
  return jsonOk({ reply });
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/otd  — AI-generated "On This Day" moments via Groq
// ─────────────────────────────────────────────────────────────────────────────
const OTD_EVERGREEN = [
  {
    color: 'var(--lime)', tag: 'DYNASTY', tagIcon: 'trophy',
    headline: 'The NBA\'s greatest dynasties across eras',
    detail: 'From the Bill Russell Celtics (11 titles in 13 years) to the Michael Jordan Bulls (6-for-6 in Finals) to the Warriors dynasty, the NBA has seen dominance that shaped the sport.',
    statChip: { cls: 'up', text: '11 TITLES' }, players: ['Bill Russell', 'Michael Jordan', 'Stephen Curry']
  },
  {
    color: 'var(--coral)', tag: 'MILESTONE', tagIcon: 'star',
    headline: 'Kareem\'s skyhook: the most unstoppable shot ever',
    detail: 'Kareem Abdul-Jabbar\'s skyhook helped him score 38,387 career points, a record that stood for 39 years until LeBron James surpassed it in 2023.',
    statChip: { cls: 'up', text: '38,387 PTS' }, players: ['Kareem Abdul-Jabbar']
  },
  {
    color: 'var(--amber)', tag: 'RECORD', tagIcon: 'crown',
    headline: 'Triple-double kings who changed the stat sheet',
    detail: 'Oscar Robertson averaged a triple-double for an entire season in 1961-62. Russell Westbrook matched the feat in 2017 and went on to break the all-time triple-double record.',
    statChip: { cls: 'up', text: '198 3×D' }, players: ['Oscar Robertson', 'Russell Westbrook']
  }
];



function filterWikiEvents(events) {
  const teams = ["Knicks","Lakers","Bulls","Celtics","Warriors","Spurs","Heat","Pistons","76ers","Bucks","Suns","Nets","Nuggets","Rockets","Mavericks","Thunder","Clippers","Hawks","Pacers","Wizards","Hornets","Grizzlies","Pelicans","Kings","Jazz","Blazers","Timberwolves","Magic","Raptors","Cavaliers"];
  return events.filter(ev => {
    const text = ev.text ?? '';
    const lower = text.toLowerCase();
    // 1. Core basketball terms
    if (text.includes("NBA") || lower.includes("basketball") || text.includes("Basketball Association")) return true;
    // 2. Performance stats
    if (lower.includes("triple-double")) return true;
    if (lower.includes("points") && (lower.includes("game") || lower.includes("season"))) return true;
    // 3. High-stakes events
    if (text.includes("NBA Finals") || text.includes("NBA championship")) return true;
    // 4. Draft/Offseason
    if (lower.includes("nba draft") && lower.includes("selected")) return true;
    // 5. Championship + Team Name
    if ((lower.includes("championship") || lower.includes("defeated")) && teams.some(t => text.includes(t))) return true;
    
    return false;
  }).slice(0, 5);
}

async function handleOTD(env, url) {
  const mmdd = url.searchParams.get('date');
  if (!mmdd) return new Response('Missing ?date=MM-DD', { status: 400, headers: CORS });

  const KV_KEY = `otd_wiki_v10_${mmdd}`;

  const { value: cached } = await kvGet(env, KV_KEY);
  if (cached) return jsonOk({ source: 'cache', data: cached });

  const [m, d] = mmdd.split('-');

  try {
    // 1. Fetch from Wikipedia "On This Day" API
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${m}/${d}`;
    const wikiRes = await fetch(wikiUrl, { headers: BROWSER_HEADERS });
    if (!wikiRes.ok) throw new Error(`Wikipedia API error: ${wikiRes.status}`);
    const wikiData = await wikiRes.json();

    // 2. Filter for basketball/NBA related events
    const filtered = filterWikiEvents(wikiData.events ?? []);

    let data = [];

    if (filtered.length > 0 && env.GROQ_API_KEY) {
      // 3. Send raw facts to Groq for formatting (RAG style)
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1000,
          temperature: 0.7,
          messages: [
            {
              role: 'system',
              content: 'You are an NBA content writer. You receive raw historical facts and format them into JSON cards. You NEVER invent facts — you only rewrite what you are given. Return ONLY valid JSON, no markdown.'
            },
            {
              role: 'user',
              content: `Format these ${filtered.length} verified NBA events into exactly ${filtered.length} JSON cards.\n\nRAW FACTS:\n${JSON.stringify(filtered)}\n\nReturn this structure for each:\n[{ "date_mmdd": "${mmdd}", "year": 1987, "color": "var(--lime)", "tag": "RECORD", "tagIcon": "trending-up", "headline": "Short punchy headline", "detail": "Sports-voice detail", "statChip": { "cls": "up", "text": "36 PTS" }, "players": ["Player Name"] }]\n\nRules: color must be one of var(--lime) var(--coral) var(--amber) var(--blue). Tag must be one of RECORD MILESTONE DEBUT DYNASTY COMEBACK PLAYOFFS FAREWELL. Vary colors and tags. Rewrite the detail in punchy sports-voice — do not copy Wikipedia verbatim.`
            }
          ]
        })
      });

      if (groqRes.ok) {
        const groqData = await groqRes.json();
        const raw = groqData.choices[0]?.message?.content ?? '';
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          data = JSON.parse(jsonMatch[0]);
        }
      }
    }

    // 4. Merge with static OTD_ANCHORS if needed
    if (data.length < 3) {
      const fallback = OTD_ANCHORS.filter(e => e.date_mmdd === mmdd);
      const aiYears = new Set(data.map(d => String(d.year)));
      for (const f of fallback) {
        if (data.length >= 3) break;
        if (f.year && aiYears.has(String(f.year))) continue;
        data.push(f);
        if (f.year) aiYears.add(String(f.year));
      }
    }

    // 5. Tier 3: Relaxed Groq Recall (if still < 3)
    if (data.length < 3 && env.GROQ_API_KEY) {
      const needed = 3 - data.length;
      const seenYears = data.map(d => d.year).filter(Boolean);
      const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const dateLabel = `${months[parseInt(m)-1]} ${parseInt(d)}`;

      const groqRecall = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1000,
          messages: [
            {
              role: 'system',
              content: 'You are an NBA historian. List NBA events that occurred on the given date that you are highly confident about. Return valid JSON only.'
            },
            {
              role: 'user',
              content: `List exactly ${needed} NBA events that occurred on ${dateLabel}. You must be certain of the DATE. You can be flexible on the exact final score or minor stats if you are certain of the year, teams, and outcome.

Return exactly ${needed} JSON objects in a list. Skip these years: ${seenYears.join(', ')}.

Structure:
[{ "date_mmdd": "${mmdd}", "year": 1987, "color": "var(--lime)", "tag": "PLAYOFFS", "tagIcon": "flame", "headline": "Headline", "detail": "Sports-voice detail", "statChip": { "cls": "up", "text": "Score or Stat" }, "players": ["Names"] }]`
            }
          ]
        })
      });

      if (groqRecall.ok) {
        const recallData = await groqRecall.json();
        const raw = recallData.choices[0]?.message?.content ?? '';
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const recalled = JSON.parse(jsonMatch[0]);
          for (const r of recalled) {
            if (data.length >= 3) break;
            data.push(r);
          }
        }
      }
    }

    // 6. Tier 4: Evergreen Last Resort
    if (data.length < 3) {
      const seenHeadlines = new Set(data.map(d => d.headline));
      for (const e of OTD_EVERGREEN) {
        if (data.length >= 3) break;
        if (seenHeadlines.has(e.headline)) continue;
        data.push(e);
      }
    }

    await kvPut(env, KV_KEY, data, 86400); // 24h
    return jsonOk({ source: 'live', data });

  } catch (err) {
    console.error('[OTD] Wikipedia/Groq flow failed:', err.message);
    const filteredFallback = buildStaticFallback(mmdd);
    return jsonOk({ source: 'fallback', data: filteredFallback, error: err.message });
  }

}


// Build a best-effort static fallback for a given MM-DD. Pads with evergreen
// entries (those without an mmdd) so the client never receives an empty array.
function buildStaticFallback(mmdd) {
  // ONLY return verified anchors for this date. No evergreen padding.
  return OTD_ANCHORS.filter(e => e.date_mmdd === mmdd).slice(0, 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/news  — NBA news from ESPN, with fallback to NBA.com RSS-like API
// ─────────────────────────────────────────────────────────────────────────────

const TTL_NEWS = 1800; // 30 min
const ESPN_NEWS = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=6';
const NBA_NEWS_API = 'https://content-api-prod.nba.com/public/1/endeavor/layout/page/content/news?limit=6';

async function handleNews(env) {
  const KV_KEY = 'news_v2';

  // 1. KV cache
  const { value: cached, metadata } = await kvGet(env, KV_KEY);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return jsonOk({ source: 'cache', data: cached, cachedAt: metadata?.ts });
  }

  // 2. ESPN primary source
  let articles = [];
  try {
    articles = await fetchESPNNews();
  } catch (err) {
    console.warn('[News] ESPN fetch failed:', err.message);
  }

  // 3. NBA.com fallback
  if (!articles.length) {
    try {
      articles = await fetchNBAComNews();
    } catch (err) {
      console.warn('[News] NBA.com fallback failed:', err.message);
    }
  }

  // 4. Static fallback
  if (!articles.length) {
    articles = STATIC_NEWS_FALLBACK;
  }

  // Take top 4
  const top4 = articles.slice(0, 4);

  if (top4.length > 0 && top4 !== STATIC_NEWS_FALLBACK) {
    await kvPut(env, KV_KEY, top4, TTL_NEWS);
  }

  return jsonOk({ source: articles === STATIC_NEWS_FALLBACK ? 'fallback' : 'live', data: top4 });
}

async function fetchESPNNews() {
  const json = await upstreamFetch(ESPN_NEWS);
  const raw = json.articles ?? [];
  return raw.slice(0, 6).map(a => {
    const img = a.images?.[0];
    return {
      headline: a.headline ?? 'NBA Update',
      description: (a.description ?? '').slice(0, 120),
      image: img?.url ?? null,
      published: a.published ?? new Date().toISOString(),
      url: a.links?.web?.href ?? 'https://www.espn.com/nba/',
      source: 'ESPN',
    };
  }).filter(a => a.headline);
}

async function fetchNBAComNews() {
  // NBA.com content API endpoint
  const res = await fetch('https://www.nba.com/news', {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`NBA.com HTTP ${res.status}`);
  const html = await res.text();

  // Extract JSON-LD structured data from the page
  const ldMatch = html.match(/<script type="application\/ld\+json">(\[.+?\])<\/script>/s);
  if (!ldMatch) throw new Error('No structured data found');
  const items = JSON.parse(ldMatch[1]);
  return items.slice(0, 6).map(item => ({
    headline: item.headline ?? 'NBA News',
    description: (item.description ?? '').slice(0, 120),
    image: item.image?.url ?? item.thumbnailUrl ?? null,
    published: item.datePublished ?? new Date().toISOString(),
    url: item.url ?? 'https://www.nba.com/news',
    source: 'NBA.com',
  })).filter(a => a.headline);
}

const STATIC_NEWS_FALLBACK = [
  {
    headline: 'NBA Playoffs 2026: Full bracket and schedule',
    description: 'The complete bracket for the 2026 NBA Playoffs including matchups, dates, and TV info.',
    image: null, published: new Date().toISOString(),
    url: 'https://www.nba.com/playoffs', source: 'NBA.com',
  },
  {
    headline: 'Shai Gilgeous-Alexander continues MVP-caliber season',
    description: 'OKC\'s star guard is putting up historic numbers as the Thunder chase the #1 seed.',
    image: null, published: new Date().toISOString(),
    url: 'https://www.espn.com/nba/', source: 'ESPN',
  },
  {
    headline: 'Trade deadline winners and losers: Full analysis',
    description: 'A deep dive into the biggest moves and which teams improved their championship odds.',
    image: null, published: new Date().toISOString(),
    url: 'https://www.espn.com/nba/', source: 'ESPN',
  },
  {
    headline: 'Rookie Watch: Top first-year players making an impact',
    description: 'From Victor Wembanyama\'s growth to surprise contributors across the league.',
    image: null, published: new Date().toISOString(),
    url: 'https://www.nba.com/news', source: 'NBA.com',
  },
];

/** KV get with error handling */
async function kvGet(env, key) {
  try {
    const { value, metadata } = await env.PM_CACHE.getWithMetadata(key, { type: 'json' });
    return { value, metadata };
  } catch (e) {
    console.error(`[KV] get(${key}) failed:`, e.message);
    return { value: null, metadata: null };
  }
}

/** KV put with error handling */
async function kvPut(env, key, data, ttl, meta = {}) {
  try {
    await env.PM_CACHE.put(key, JSON.stringify(data), {
      expirationTtl: ttl,
      metadata: { ts: Date.now(), ...meta },
    });
  } catch (e) {
    console.error(`[KV] put(${key}) failed:`, e.message);
  }
}

/** Fetch from upstream with browser-like headers and a hard timeout */
async function upstreamFetch(url, signal) {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** Returns YYYY-MM-DD for the NBA operational date (Eastern Time). */
function todayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NBA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Format YYYYMMDD string */
function dateToCompact(date) {
  return date.replace(/-/g, '');
}

/** Resolve backend API base URL. */
function backendBaseUrl(env) {
  const configured = String(env?.PM_BACKEND_URL ?? '').trim();
  // Local default only works for wrangler dev. In production set PM_BACKEND_URL.
  return (configured || 'http://127.0.0.1:8000').replace(/\/+$/, '');
}

/** Proxy helper for backend JSON endpoints. */
async function proxyBackendJson(path, timeoutMs = 30000) {
  try {
    const upstream = await fetch(path, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Backend unreachable: ${err.message}` }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/leaders  — ESPN stat leaders, 24 h KV cache
// ─────────────────────────────────────────────────────────────────────────────
async function handleLeaders(env) {
  const KV_KEY = 'leaders_nba_v5';
  // NOTE: This is the canonical KV key for leader data. Keep chat and any
  // other consumers in sync with this name to avoid silent context failures.
  // See: handleLeaders() which writes to `leaders_nba_v5`.

  // 1. KV cache hit
  const { value: cached, metadata } = await kvGet(env, KV_KEY);
  if (cached && Object.keys(cached).length > 0) {
    const ageMs = Date.now() - (metadata?.ts ?? 0);
    const ageHrs = Math.floor(ageMs / 3_600_000);
    return jsonOk({ source: 'cache', cachedAt: metadata?.ts, ageHours: ageHrs, data: cached });
  }

  // 2. Live fetch (NBA stats primary, ESPN fallback)
  let result = {};
  try {
    result = await fetchLeadersNBAAll();
    if (Object.keys(result).length === 0) {
      console.warn('[Leaders] NBA stats returned empty result, falling back to ESPN');
      result = await fetchLeadersESPN();
    }
  } catch (err) {
    console.warn('[Leaders] NBA stats failed, trying ESPN fallback:', err.message);
    try {
      result = await fetchLeadersESPN();
    } catch (espnErr) {
      console.error('[Leaders] All leader sources failed:', espnErr.message);
      return jsonOk({ source: 'error', error: espnErr.message, data: {} });
    }
  }

  // 3. Persist (even partial)
  if (Object.keys(result).length > 0) {
    await kvPut(env, KV_KEY, result, TTL_LEADERS);
  }

  return jsonOk({ source: 'live', cachedAt: Date.now(), data: result });
}

function currentSeasonLabel() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const start = m >= 10 ? y : y - 1;
  const end = String((start + 1) % 100).padStart(2, '0');
  return `${start}-${end}`;
}

async function fetchLeadersNBAAll() {
  const season = currentSeasonLabel();
  const cats = [
    { stat: 'PTS', out: 'pts' },
    { stat: 'REB', out: 'reb' },
    { stat: 'AST', out: 'ast' },
    { stat: 'STL', out: 'stl' },
    { stat: 'BLK', out: 'blk' },
    { stat: 'FG3M', out: 'tpm' },
  ];

  const pairs = await Promise.all(cats.map(async ({ stat, out }) => {
    const rows = await fetchNBALeaderCategory(stat, season);
    return [out, rows];
  }));

  return Object.fromEntries(pairs.filter(([, rows]) => Array.isArray(rows) && rows.length > 0));
}

async function fetchNBALeaderCategory(statCategory, season) {
  const url = `https://stats.nba.com/stats/leagueleaders?LeagueID=00&PerMode=PerGame&Scope=S&Season=${encodeURIComponent(season)}&SeasonType=Regular%20Season&StatCategory=${encodeURIComponent(statCategory)}`;
  const res = await fetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      'x-nba-stats-origin': 'stats',
      'x-nba-stats-token': 'true',
      'Referer': 'https://www.nba.com/',
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`NBA stats ${statCategory} HTTP ${res.status}`);

  const json = await res.json();
  const rows = json.resultSet?.rowSet ?? [];
  const headers = json.resultSet?.headers ?? [];

  const idxPlayer = headers.indexOf('PLAYER');
  const idxTeam = headers.indexOf('TEAM');
  const idxStat = headers.indexOf(statCategory);
  const idxPlayerId = headers.indexOf('PLAYER_ID');

  if (idxPlayer < 0 || idxTeam < 0 || idxStat < 0) return [];

  const top = rows.slice(0, 9);
  const max = Number(top[0]?.[idxStat] ?? 0) || 1;

  return top.map(r => {
    const raw = Number(r[idxStat] ?? 0);
    const pid = idxPlayerId >= 0 ? String(r[idxPlayerId] ?? '') : '';
    return {
      name: String(r[idxPlayer] ?? '—'),
      team: String(r[idxTeam] ?? '—'),
      img: pid ? `https://cdn.nba.com/headshots/nba/latest/260x190/${pid}.png` : null,
      val: parseFloat(raw.toFixed(1)),
      pct: Math.round((raw / max) * 100),
    };
  }).filter(p => p.name !== '—');
}

async function fetchLeadersESPN() {
  const json = await upstreamFetch(ESPN_LEADERS);
  const categories = json.categories
    ?? json.leaders?.categories
    ?? json.results?.[0]?.leaders?.categories
    ?? [];

  const result = {};
  for (const cat of categories) {
    const key = ESPN_CAT_MAP[cat.name];
    if (!key) continue;

    const leaders = (cat.leaders ?? cat.entries ?? cat.athletes ?? []).slice(0, 8);
    if (!leaders.length) continue;

    const getValue = l => l.value ?? l.val?.value ?? 0;
    const top = getValue(leaders[0]) || 1;
    const isInt = INT_CATS.has(key);

    result[key] = leaders.map(l => {
      const raw = getValue(l);
      const athlete = l.athlete ?? l;
      const team = athlete.team ?? l.team ?? {};
      return {
        name: athlete.displayName ?? athlete.fullName ?? l.displayName ?? '—',
        team: team.abbreviation ?? '—',
        img: athlete.headshot?.href ?? athlete.headshots?.[0]?.href ?? null,
        val: isInt ? Math.round(raw) : parseFloat(raw.toFixed(1)),
        pct: Math.round((raw / top) * 100),
      };
    }).filter(p => p.name !== '—');
  }

  return result;
}

async function fetchThreePointLeadersNBA() {
  const url = 'https://stats.nba.com/stats/leagueleaders?LeagueID=00&PerMode=PerGame&Scope=S&Season=2024-25&SeasonType=Regular%20Season&StatCategory=FG3M';
  try {
    const res = await fetch(url, {
      headers: {
        ...BROWSER_HEADERS,
        'x-nba-stats-origin': 'stats',
        'x-nba-stats-token': 'true',
        'Referer': 'https://www.nba.com/'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    
    const json = await res.json();
    const rows = json.resultSet?.rowSet || [];
    const headers = json.resultSet?.headers || [];
    
    const idxPlayer = headers.indexOf('PLAYER');
    const idxTeam = headers.indexOf('TEAM');
    const idxFG3M = headers.indexOf('FG3M');
    
    if (idxPlayer < 0 || idxFG3M < 0) return [];
    
    const leaders = rows.slice(0, 8);
    const topVal = leaders[0]?.[idxFG3M] || 1;
    
    return leaders.map(r => ({
      name: r[idxPlayer],
      team: r[idxTeam] || '—',
      img: 'https://cdn.nba.com/headshots/nba/latest/260x190/fallback.png', // no simple NBA headshot API without player ID, but we can assume generic
      val: parseFloat(r[idxFG3M].toFixed(1)),
      pct: Math.round((r[idxFG3M] / topVal) * 100)
    }));
  } catch (err) {
    console.warn('[Leaders] NBA 3PM fallback failed:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/standings  — conference standings, 1 h KV cache
// Strategy: NBA CDN first → ESPN fallback
// ─────────────────────────────────────────────────────────────────────────────
async function handleStandings(env) {
  const KV_KEY = 'standings_espn_v5';

  // 1. KV cache hit
  const { value: cached, metadata } = await kvGet(env, KV_KEY);
  if (cached && (cached.west?.length || cached.east?.length)) {
    return jsonOk({ source: 'cache', cachedAt: metadata?.ts, data: cached });
  }

  // 2. Live — NBA CDN preferred, ESPN as fallback
  const result = (await fetchStandingsNBACDN()) ?? (await fetchStandingsESPN());
  if (!result || (!result.west?.length && !result.east?.length)) {
    return jsonOk({ source: 'error', error: 'All standings sources failed', data: { west: [], east: [] } });
  }

  await kvPut(env, KV_KEY, result, TTL_STANDINGS);
  return jsonOk({ source: 'live', cachedAt: Date.now(), data: result });
}

async function fetchStandingsNBACDN() {
  try {
    const json = await upstreamFetch(NBA_STANDINGS);
    const rows = json.resultSets?.[0];
    if (!rows?.rowSet?.length) return null;

    const hdrs = rows.headers ?? [];
    const idx = k => hdrs.indexOf(k);

    const teams = rows.rowSet.map(r => {
      const w = r[idx('WINS')] || 0;
      const l = r[idx('LOSSES')] || 0;
      const pct = (w + l) > 0 ? w / (w + l) : 0;
      const abbr = r[idx('TeamAbbreviation')] ?? '???';
      const strk = r[idx('CurrentStreak')] ?? 0;

      return {
        team: r[idx('TeamName')],
        abbr,
        conf: r[idx('Conference')]?.toLowerCase().startsWith('w') ? 'west' : 'east',
        seed: r[idx('PlayoffRank')] ?? 0,
        w, l, pct,
        pctStr: '.' + String(Math.round(pct * 1000)).padStart(3, '0'),
        gb: r[idx('ConferenceGamesBack')] === 0 ? '—' : String(r[idx('ConferenceGamesBack')] ?? '—'),
        home: r[idx('HOME_RECORD')] ?? '—',
        away: r[idx('ROAD_RECORD')] ?? '—',
        l10: r[idx('L10')] ?? '5-5',
        strk: strk > 0 ? `W${strk}` : `L${Math.abs(strk)}`,
        color: TEAM_COLORS[abbr] ?? '#888888',
        record: `${w}-${l}`,
        net: (() => {
          const n = r[idx('NetRtg')] ?? 0;
          return n >= 0 ? '+' + Number(n).toFixed(1) : Number(n).toFixed(1);
        })(),
      };
    });

    if (!teams.length) return null;

    const sort = (a, b) => {
      const pd = b.pct - a.pct;
      if (Math.abs(pd) > 0.0001) return pd;
      if (b.w !== a.w) return b.w - a.w;
      return (parseFloat(b.net) || 0) - (parseFloat(a.net) || 0);
    };

    return {
      west: teams.filter(t => t.conf === 'west').sort(sort).map((t, i) => ({ ...t, seed: i + 1 })),
      east: teams.filter(t => t.conf === 'east').sort(sort).map((t, i) => ({ ...t, seed: i + 1 })),
    };
  } catch (e) {
    console.warn('[Standings] NBA CDN failed:', e.message);
    return null;
  }
}

async function fetchStandingsESPN() {
  try {
    const json = await upstreamFetch(ESPN_STANDINGS);
    const result = { west: [], east: [] };

    const normPct = val => {
      let p = parseFloat(val) || 0;
      if (p > 1) p /= 100;
      return Math.max(0, Math.min(1, p));
    };

    for (const conf of (json.children ?? [])) {
      const isWest = conf.name?.toLowerCase().includes('west');
      const target = isWest ? result.west : result.east;

      for (const entry of (conf.standings?.entries ?? [])) {
        const stats = entry.stats ?? [];
        const find = (...names) => {
          const s = stats.find(s => names.some(n => (s.name ?? '').toLowerCase() === n.toLowerCase()));
          return s?.displayValue ?? s?.value?.toString() ?? '0';
        };

        const w = parseInt(find('wins', 'w')) || 0;
        const l = parseInt(find('losses', 'l')) || 0;
        const pct = normPct(find('winPercent', 'wp', 'percentage', 'winPct', 'winpercentage'));
        const abbr = entry.team?.abbreviation ?? '???';

        target.push({
          seed: 0,
          team: entry.team?.displayName ?? '—',
          abbr,
          color: '#' + (entry.team?.color ?? '888888'),
          record: find('summary', 'record'),
          w, l, pct,
          pctStr: '.' + String(Math.round(pct * 1000)).padStart(3, '0'),
          gb: find('gamesBehind', 'gb'),
          home: find('home'),
          away: find('away'),
          l10: find('lastTen', 'l10'),
          strk: find('streak'),
          net: find('pointDifferential', 'pd', 'avgpointdifferential'),
        });
      }
    }

    const sort = (a, b) => {
      const pd = (b.pct || 0) - (a.pct || 0);
      if (Math.abs(pd) > 0.0001) return pd;
      if (b.w !== a.w) return b.w - a.w;
      return (parseFloat(b.net) || 0) - (parseFloat(a.net) || 0);
    };

    result.west = result.west.sort(sort).map((t, i) => ({ ...t, seed: i + 1 }));
    result.east = result.east.sort(sort).map((t, i) => ({ ...t, seed: i + 1 }));

    return (result.west.length || result.east.length) ? result : null;
  } catch (e) {
    console.warn('[Standings] ESPN failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/scoreboard  — today's games, 60 s KV cache
// Strategy: NBA CDN first → ESPN fallback → stale KV
// ─────────────────────────────────────────────────────────────────────────────
async function handleScoreboard(env) {
  // Date-keyed so yesterday's stale data can't bleed into today
  const date = todayKey();
  const KV_KEY = `scoreboard_${date}`;

  // 1. KV cache — only serve if < 60 s old
  const { value: cached, metadata } = await kvGet(env, KV_KEY);
  if (cached) {
    const ageMs = Date.now() - (metadata?.ts ?? 0);
    if (ageMs < TTL_SCOREBOARD * 1000) {
      return jsonOk({
        source: 'cache',
        cachedAt: metadata?.ts,
        ageSeconds: Math.floor(ageMs / 1000),
        date,
        games: cached,
      });
    }
  }

  // 2. Live fetch
  const games = (await fetchScoreboardNBACDN()) ?? (await fetchScoreboardESPN(date));

  if (!games) {
    // Serve stale rather than error
    if (cached) return jsonOk({ source: 'stale', cachedAt: metadata?.ts, date, games: cached });
    return jsonOk({ source: 'error', error: 'All scoreboard sources failed', date, games: [] });
  }

  await kvPut(env, KV_KEY, games, TTL_SCOREBOARD);
  return jsonOk({ source: 'live', cachedAt: Date.now(), date, games });
}

async function fetchScoreboardNBACDN() {
  try {
    const json = await upstreamFetch(NBA_SCOREBOARD, AbortSignal.timeout(5000));
    return (json.scoreboard?.games ?? []).map(g => ({
      id: g.gameId,
      status: g.gameStatus,        // 1=pre, 2=live, 3=final
      statusText: g.gameStatusText,
      period: g.period,
      clock: g.gameClock ?? '',
      home: {
        tricode: g.homeTeam?.teamTricode,
        name: g.homeTeam?.teamName,
        score: g.homeTeam?.score ?? 0,
        wins: g.homeTeam?.wins ?? 0,
        losses: g.homeTeam?.losses ?? 0,
      },
      away: {
        tricode: g.awayTeam?.teamTricode,
        name: g.awayTeam?.teamName,
        score: g.awayTeam?.score ?? 0,
        wins: g.awayTeam?.wins ?? 0,
        losses: g.awayTeam?.losses ?? 0,
      },
      arena: g.arenaName ?? '',
      startTime: g.gameEt ?? '',
    }));
  } catch (e) {
    console.warn('[Scoreboard] NBA CDN failed:', e.message);
    return null;
  }
}

async function fetchScoreboardESPN(date = todayKey()) {
  try {
    const json = await upstreamFetch(`${ESPN_SCOREBOARD}?dates=${dateToCompact(date)}`, AbortSignal.timeout(6000));
    return (json.events ?? []).map(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      const state = ev.status?.type?.state;
      const status = state === 'in' ? 2 : state === 'post' ? 3 : 1;
      return {
        id: ev.id,
        status,
        statusText: ev.status?.type?.shortDetail ?? '',
        period: ev.status?.period ?? 0,
        clock: ev.status?.displayClock ?? '',
        home: {
          tricode: home?.team?.abbreviation ?? '???',
          name: home?.team?.name ?? '—',
          score: parseInt(home?.score ?? 0),
          wins: parseInt(home?.records?.[0]?.summary?.split('-')[0] ?? 0),
          losses: parseInt(home?.records?.[0]?.summary?.split('-')[1] ?? 0),
        },
        away: {
          tricode: away?.team?.abbreviation ?? '???',
          name: away?.team?.name ?? '—',
          score: parseInt(away?.score ?? 0),
          wins: parseInt(away?.records?.[0]?.summary?.split('-')[0] ?? 0),
          losses: parseInt(away?.records?.[0]?.summary?.split('-')[1] ?? 0),
        },
        arena: comp?.venue?.fullName ?? '',
        startTime: ev.date ?? '',
      };
    });
  } catch (e) {
    console.warn('[Scoreboard] ESPN failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/schedule  — multi-day game schedule, 30 min KV cache
//
// Returns a map: { "YYYY-MM-DD": [ { home, away, time, status } ] }
// Fetches today ±7 days so the dashboard calendar has context.
// Query param: ?days=N (default 7, max 14)
// ─────────────────────────────────────────────────────────────────────────────
async function handleSchedule(env, url) {
  const dateParam = url?.searchParams?.get('date'); // YYYY-MM-DD
  const baseDate = dateParam || todayKey();
  const KV_KEY = `schedule_${baseDate}_v1`;

  // 1. KV cache
  const { value: cached, metadata } = await kvGet(env, KV_KEY);
  if (cached && Object.keys(cached).length > 0) {
    const ageMs = Date.now() - (metadata?.ts ?? 0);
    return jsonOk({ source: 'cache', cachedAt: metadata?.ts, ageSeconds: Math.floor(ageMs / 1000), schedule: cached });
  }

  // 2. Fetch a window of dates (default to 7 days for calendar, but at least 4 for UI rolling view)
  const days = Math.min(31, Math.max(4, parseInt(url?.searchParams?.get('days') ?? '7') || 7));
  const today = dateParam ? new Date(dateParam + 'T00:00:00Z') : new Date(`${todayKey()}T00:00:00Z`);
  const schedule = {};

  // Fetch from day today - 3 through today + next (days - 1) days
  const dateKeys = [];
  const startDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3));
  const endDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days - 1));

  for (let d = new Date(startDay); d <= endDay; d.setUTCDate(d.getUTCDate() + 1)) {
    dateKeys.push(new Date(d));
  }

  const BATCH = 6;
  for (let i = 0; i < dateKeys.length; i += BATCH) {
    const batch = dateKeys.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(d => fetchDaySchedule(d))
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value) {
        const d = batch[idx];
        const dk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        schedule[dk] = r.value;
      }
    });
    // Short pause between batches to be respectful to ESPN
    if (i + BATCH < dateKeys.length) await sleep(100);
  }

  if (Object.keys(schedule).length > 0) {
    await kvPut(env, KV_KEY, schedule, TTL_SCHEDULE);
  }

  return jsonOk({ source: 'live', cachedAt: Date.now(), schedule });
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/team_top_players  — top 3 player recent-form bullets, 15 min KV cache
// Strategy: Worker KV cache first → Python backend proxy
// ─────────────────────────────────────────────────────────────────────────────
async function handleTeamTopPlayers(env, url) {
  const team = String(url?.searchParams?.get('team') ?? '').trim().toUpperCase();
  const n = Math.max(1, Math.min(5, parseInt(url?.searchParams?.get('n') ?? '3', 10) || 3));
  const forceFresh = ['1', 'true', 'yes'].includes(String(url?.searchParams?.get('fresh') ?? '').toLowerCase());
  if (!team) return new Response('Missing team', { status: 400, headers: CORS });

  const KV_KEY = `team_top_players_${team}_${n}`;

  if (!forceFresh) {
    const { value: cached, metadata } = await kvGet(env, KV_KEY);
    if (cached && Array.isArray(cached.players) && cached.players.length > 0) {
      const ageMs = Date.now() - (metadata?.ts ?? 0);
      return jsonOk({ source: 'cache', cachedAt: metadata?.ts, ageSeconds: Math.floor(ageMs / 1000), team, players: cached.players });
    }
  }

  const target = `${backendBaseUrl(env)}/api/team_top_players?team=${encodeURIComponent(team)}&n=${encodeURIComponent(n)}`;
  const upstream = await proxyBackendJson(target, 20000);
  let data = null;
  try {
    data = await upstream.clone().json();
  } catch {
    data = null;
  }

  if (upstream.ok && data && Array.isArray(data.players)) {
    await kvPut(env, KV_KEY, { players: data.players }, TTL_TEAM_TOP_PLAYERS);
    return jsonOk({ source: 'live', cachedAt: Date.now(), team, players: data.players });
  }

  return upstream;
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/predict and /api/slate  — proxy to Python backend
// ─────────────────────────────────────────────────────────────────────────────
async function handleBackendDataProxy(env, url, endpoint, timeoutMs = 12000) {
  const qs = url.searchParams.toString();
  const target = `${backendBaseUrl(env)}${endpoint}${qs ? `?${qs}` : ''}`;
  return proxyBackendJson(target, timeoutMs);
}

async function handlePredictProxy(env, url) {
  const home = (url.searchParams.get('home') ?? '').trim().toUpperCase();
  const away = (url.searchParams.get('away') ?? '').trim().toUpperCase();
  if (!home || !away) {
    return new Response('Missing home/away query params', { status: 400, headers: CORS });
  }

  const qs = url.searchParams.toString();
  const target = `${backendBaseUrl(env)}/api/predict${qs ? `?${qs}` : ''}`;
  return proxyBackendJson(target, 35000);
}

async function handleSlateProxy(env, url) {
  const qs = url.searchParams.toString();
  const target = `${backendBaseUrl(env)}/api/slate${qs ? `?${qs}` : ''}`;
  return proxyBackendJson(target, 45000);
}

async function handleBackendHealth(env) {
  const target = `${backendBaseUrl(env)}/api/health`;
  return proxyBackendJson(target, 8000);
}

async function fetchDaySchedule(dateObj) {
  const compact = dateToCompact(
    `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')}`
  );
  try {
    const json = await upstreamFetch(ESPN_SCHEDULE(compact), AbortSignal.timeout(5000));
    return (json.events ?? []).map(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      const state = ev.status?.type?.state;
      return {
        home: home?.team?.abbreviation ?? '???',
        away: away?.team?.abbreviation ?? '???',
        time: state === 'post' ? 'FINAL' : (ev.status?.type?.shortDetail ?? ev.date ?? 'TBD'),
        status: state === 'in' ? 2 : state === 'post' ? 3 : 1,
        startTime: ev.date ?? '',
        tv: comp?.broadcasts?.[0]?.names?.[0] ?? '',
      };
    });
  } catch (e) {
    console.warn(`[Schedule] ESPN ${compact} failed:`, e.message);
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const _proxyRateMap = new Map(); // Resets per isolate restart (~30s), fine for soft limiting

// ─────────────────────────────────────────────────────────────────────────────
// /api/proxy?url=  — CORS pass-through (no cache, limited hosts)
// ─────────────────────────────────────────────────────────────────────────────
async function handleProxy(url, env, request) {
  // Simple rate limit: max 60 proxy requests per IP per minute
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const windowKey = `${ip}_${Math.floor(Date.now() / 60000)}`;
  const count = (_proxyRateMap.get(windowKey) || 0) + 1;
  _proxyRateMap.set(windowKey, count);

  if (count > 60) {
    return new Response('Rate limit exceeded', { status: 429, headers: { ...CORS, 'Retry-After': '60' } });
  }

  // Evict old windows to prevent unbounded growth
  if (_proxyRateMap.size > 500) {
    const now = Math.floor(Date.now() / 60000);
    for (const [k] of _proxyRateMap) {
      if (!k.endsWith(`_${now}`)) _proxyRateMap.delete(k);
    }
  }

  const target = url.searchParams.get('url');
  if (!target) return new Response('Missing ?url=', { status: 400, headers: CORS });

  let targetHost;
  try { targetHost = new URL(target).hostname; }
  catch { return new Response('Invalid URL', { status: 400, headers: CORS }); }

  if (!PROXY_ALLOWED.has(targetHost)) {
    return new Response(`Host not allowed: ${targetHost}`, { status: 403, headers: CORS });
  }

  try {
    const upstream = await fetch(target, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const resHeaders = new Headers(upstream.headers);
    Object.entries(CORS).forEach(([k, v]) => resHeaders.set(k, v));
    resHeaders.delete('access-control-allow-credentials');
    resHeaders.delete('set-cookie');
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502, headers: CORS });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/status  — health check and cache diagnostics
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatus(env) {
  const check = async (key, label, ttlSec) => {
    const { value, metadata } = await kvGet(env, key);
    const ts = metadata?.ts ?? null;
    const ageMs = ts ? Date.now() - ts : null;
    const warm = !!value && (ageMs == null || ageMs < ttlSec * 1000);
    return {
      label,
      status: warm ? 'warm' : (value ? 'stale' : 'cold'),
      cachedAt: ts ? new Date(ts).toISOString() : null,
      ageSeconds: ageMs != null ? Math.floor(ageMs / 1000) : null,
      ttlSeconds: ttlSec,
    };
  };

  const today = todayKey();
  const [leaders, standings, scoreboard, schedule] = await Promise.all([
    check('leaders_nba_v4', 'Leaders', TTL_LEADERS),
    check('standings_espn_v5', 'Standings', TTL_STANDINGS),
    check(`scoreboard_${today}`, 'Scoreboard', TTL_SCOREBOARD),
    check(`schedule_${today}_v1`, 'Schedule', TTL_SCHEDULE),
  ]);

  return jsonOk({
    ok: true,
    timestamp: new Date().toISOString(),
    today,
    timezone: NBA_TIME_ZONE,
    caches: [leaders, standings, scoreboard, schedule],
    sources: 'ESPN API (free, no key required) + NBA CDN',
    endpoints: ['/api/leaders', '/api/standings', '/api/scoreboard', '/api/schedule', '/api/team_top_players', '/api/shot_zones', '/api/lineups', '/api/play_types', '/api/injuries', '/api/playerlog', '/api/predict', '/api/slate', '/api/backend-health', '/api/proxy?url=', '/api/status'],
  });
}
