if (parseInt(process.versions.node) < 18) {
  console.error('[Proxy] Node 18+ required (built-in fetch). Found:', process.versions.node);
  process.exit(1);
}

// Load .env from project root (optional — proxy still works without it, OTD just skips)
const fs = require('fs');
const path = require('path');
(function loadEnv() {
  // Check a few likely locations for .env
  const candidates = [
    path.resolve(__dirname, '..', '..', 'api', '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '.env'),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
    console.log(`[Proxy] .env loaded from ${envPath}`);
    return;
  }
  console.warn('[Proxy] No .env file found — OTD will use empty fallback');
})();

/**
 * proxy.js — Plus-Minus NBA  ·  Local development CORS proxy
 *
 * Bridges browser requests to ESPN / NBA CDN APIs which don't
 * serve CORS headers to browsers.  Only needed for local dev;
 * in production all API calls are routed through the Cloudflare Worker.
 *
 * Also handles /api/otd locally using GROQ_API_KEY from .env,
 * matching the production Cloudflare Worker behaviour.
 *
 * Usage:
 *   node proxy.js
 *   → http://localhost:2999/?url=<encoded-target-url>
 *   → http://localhost:2999/api/otd?date=MM-DD
 *
 * Keep running alongside your static server:
 *   Terminal 1: node proxy.js
 *   Terminal 2: python3 -m http.server 8080  (or npx serve .)
 *   Browser:    http://localhost:8080/home.html
 */

const http = require('http');
const { URL } = require('url');

const PORT = 2999;

// Allowed upstream hosts — prevents open-proxy abuse in dev environments
const ALLOWED_HOSTS = new Set([
  'site.api.espn.com',
  'cdn.nba.com',
  'stats.nba.com',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// Browser-like headers to avoid 403s from CDNs
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, */*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
};

// In-memory cache: { [url]: { body, contentType, ts } }
const CACHE = new Map();
const CACHE_TTL_MS = 90_000; // 90 s — mirrors shared.js visibilityInterval(refreshLiveUI, 90_000)

function isCacheValid(entry) {
  return entry && (Date.now() - entry.ts) < CACHE_TTL_MS;
}

// ── OTD: compound-beta search + llama formatter ───────────────────────────────
const OTD_LOCAL_CACHE = new Map(); // mmdd → { data, ts }
const OTD_TTL_MS = 24 * 60 * 60 * 1000; // 24h — same as production KV TTL

async function handleOTDLocal(mmdd) {
  // In-memory cache — only call Groq once per date per day
  const cached = OTD_LOCAL_CACHE.get(mmdd);
  if (cached && (Date.now() - cached.ts) < OTD_TTL_MS) {
    console.log(`[OTD] cache hit for ${mmdd}`);
    return { source: 'cache', data: cached.data };
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.warn('[OTD] GROQ_API_KEY not set — add it to .env file');
    return { source: 'empty', data: [] };
  }

  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const [m, d] = mmdd.split('-').map(Number);
  const dateLabel = `${months[m - 1]} ${d}`;

  console.log(`[OTD] compound-beta searching for ${dateLabel}...`);

  try {
    // Phase 1: compound-beta web searches for real verified events
    const searchRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'compound-beta',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Search for the biggest NBA historical moments that happened on ${dateLabel} across all years. I need real events with verified stats — actual games played, records broken, legendary performances. Find at least 5-10 candidates so I can pick the best 3. List each with: year, what happened, key stats, players involved.`
        }]
      })
    });
    if (!searchRes.ok) throw new Error(`compound-beta error: ${searchRes.status}`);
    const searchBody = await searchRes.json();
    const searchedFacts = searchBody.choices[0]?.message?.content ?? '';
    if (!searchedFacts.trim()) throw new Error('compound-beta returned empty');
    console.log(`[OTD] compound-beta done, formatting into JSON...`);

    // Phase 2: llama-3.3 formats the web-searched facts into strict JSON
    const formatRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: `You convert verified NBA historical facts into a strict JSON array. Return ONLY the JSON array — no markdown, no backticks, no preamble.\n\nPick the 3 BEST and most iconic events from the research provided. Each must have actually occurred on ${dateLabel}.\n\nReturn exactly:\n[\n  {\n    "date_mmdd": "${mmdd}",\n    "year": 2006,\n    "color": "var(--lime)",\n    "tag": "RECORD",\n    "tagIcon": "trending-up",\n    "headline": "Punchy headline under 12 words",\n    "detail": "2-3 sentences using only facts from the research below.",\n    "statChip": { "cls": "up", "text": "81 PTS" },\n    "players": ["Player Name"]\n  }\n]\ncolor: one of "var(--lime)", "var(--coral)", "var(--amber)", "var(--blue)" — vary across 3 items\ntagIcon: one of "zap", "trending-up", "star", "crown", "flame", "trophy"\ntag: one of RECORD, MILESTONE, DEBUT, DYNASTY, COMEBACK, PLAYOFFS, FAREWELL\nstatChip.cls: "up" or "down"\nplayers: 1-3 names max\nReturn EXACTLY 3 items — no more, no less.`
          },
          {
            role: 'user',
            content: `Here are verified NBA events that happened on ${dateLabel}, researched from the web:\n\n${searchedFacts}\n\nPick the 3 most iconic. Return ONLY the JSON array.`
          }
        ]
      })
    });
    if (!formatRes.ok) throw new Error(`llama format error: ${formatRes.status}`);
    const formatBody = await formatRes.json();
    const raw = formatBody.choices[0]?.message?.content ?? '';
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in format response');
    const data = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(data) || data.length === 0) throw new Error('Empty result from formatter');

    // Stamp correct date on all items
    const verified = data.slice(0, 3).map(item => ({ ...item, date_mmdd: mmdd }));
    OTD_LOCAL_CACHE.set(mmdd, { data: verified, ts: Date.now() });
    console.log(`[OTD] ✓ ${verified.length} events cached for ${dateLabel}`);
    return { source: 'live', data: verified };

  } catch (err) {
    console.error(`[OTD] Failed for ${dateLabel}:`, err.message);
    return { source: 'fallback', data: [] };
  }
}

const server = http.createServer(async (req, res) => {
  const startMs = Date.now();

  // ── CORS preflight ──────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Only allow GET
  if (req.method !== 'GET') {
    res.writeHead(405, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // ── Parse request URL ───────────────────────────────────────────────────
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Bad request URL');
    return;
  }

  // ── /api/otd — local OTD handler ────────────────────────────────────────
  if (requestUrl.pathname === '/api/otd') {
    const mmdd = requestUrl.searchParams.get('date');
    if (!mmdd || !/^\d{2}-\d{2}$/.test(mmdd)) {
      res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
      res.end('Missing or invalid ?date=MM-DD');
      return;
    }
    try {
      const result = await handleOTDLocal(mmdd);
      const body = JSON.stringify(result);
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      console.error('[OTD] Unexpected error:', err.message);
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ source: 'empty', data: [] }));
    }
    return;
  }

  // ── /api/* — catch other API routes gracefully ──────────────────────────
  if (requestUrl.pathname.startsWith('/api/')) {
    res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No local handler for ${requestUrl.pathname}` }));
    return;
  }

  // ── CORS proxy for ESPN/NBA CDN ─────────────────────────────────────────
  const target = requestUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Missing ?url= query parameter');
    return;
  }

  // ── Validate target host ────────────────────────────────────────────────
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Invalid target URL');
    return;
  }

  if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
    res.writeHead(403, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end(`Host not allowed: ${targetUrl.hostname}\nAllowed: ${[...ALLOWED_HOSTS].join(', ')}`);
    return;
  }

  // ── In-memory cache check ───────────────────────────────────────────────
  const cacheKey = target;
  const cachedItem = CACHE.get(cacheKey);
  if (isCacheValid(cachedItem)) {
    const ageMs = Date.now() - cachedItem.ts;
    console.log(`[Proxy] CACHE HIT (${ageMs}ms old) → ${target.slice(0, 80)}`);
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': cachedItem.contentType,
      'X-Cache': 'HIT',
      'X-Cache-Age': String(Math.floor(ageMs / 1000)) + 's',
    });
    res.end(cachedItem.body);
    return;
  }

  // ── Upstream fetch ──────────────────────────────────────────────────────
  console.log(`[Proxy] FETCH → ${target.slice(0, 100)}`);

  try {
    const upstream = await fetch(target, {
      headers: UPSTREAM_HEADERS,
      signal: AbortSignal.timeout(8000),
    });

    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const elapsed = Date.now() - startMs;

    console.log(`[Proxy] ${upstream.status} (${elapsed}ms) ← ${target.slice(0, 80)}`);

    // Cache successful responses
    if (upstream.ok) {
      for (const [k, v] of CACHE) {
        if (!isCacheValid(v)) CACHE.delete(k);
      }
      CACHE.set(cacheKey, { body, contentType, ts: Date.now() });
      if (CACHE.size > 50) {
        CACHE.delete(CACHE.keys().next().value);
      }
    }

    res.writeHead(upstream.status, {
      ...CORS_HEADERS,
      'Content-Type': contentType,
      'X-Cache': 'MISS',
      'X-Upstream-Ms': String(elapsed),
    });
    res.end(body);

  } catch (err) {
    const elapsed = Date.now() - startMs;
    console.error(`[Proxy] ERROR (${elapsed}ms): ${err.message}`);
    res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end(`Proxy error: ${err.message}`);
  }
});


// ── Start server ──────────────────────────────────────────────────────────────
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[Proxy] ✗ Port ${PORT} is already in use.`);
    console.error(`  Kill the existing process:  lsof -ti:${PORT} | xargs kill`);
  } else {
    console.error('[Proxy] Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\n┌────────────────────────────────────────────┐');
  console.log('│  Plus-Minus  ·  Local CORS Proxy           │');
  console.log(`│  Listening on  http://localhost:${PORT}       │`);
  console.log('├────────────────────────────────────────────┤');
  console.log('│  Endpoints:                                │');
  console.log('│  ?url=https://site.api.espn.com/...       │');
  console.log('│  /api/otd?date=MM-DD  (Groq compound-beta)│');
  console.log('├────────────────────────────────────────────┤');
  console.log('│  Set GROQ_API_KEY in .env for OTD support  │');
  console.log(`│  In-memory cache: ${CACHE_TTL_MS / 1000}s TTL                 │`);
  console.log('└────────────────────────────────────────────┘\n');
  if (!process.env.GROQ_API_KEY) {
    console.warn('[Proxy] ⚠  GROQ_API_KEY not set — OTD will return empty\n');
  } else {
    console.log('[Proxy] ✓  GROQ_API_KEY found — OTD ready\n');
  }
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('\n[Proxy] Shutting down.'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[Proxy] Shutting down.'); server.close(); process.exit(0); });
