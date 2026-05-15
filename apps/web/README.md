# Web

Static NBA dashboard plus Cloudflare Worker data layer.

## Responsibilities

- `pages/`: dashboard and prediction screens.
- `scripts/`: browser data layer, UI rendering, and prediction interactions.
- `styles/`: shared visual system.
- `workers/worker.js`: production API/cache boundary.
- `workers/proxy.js`: local-only CORS/Groq helper.

## Local Run

```powershell
npx serve . -l 8080
```

Open `http://localhost:8080/pages/home.html`.

## Deploy Worker

```powershell
wrangler secret put GROQ_API_KEY
wrangler secret put PM_BACKEND_URL
wrangler deploy
```

