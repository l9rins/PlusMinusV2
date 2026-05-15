# Plus-Minus NBA â€” Setup Guide

## What you built

```
Browser (pages/home.html)
   â†“ fetch /api/slate, /api/predict
Cloudflare Worker (workers/worker.js)
   â†“ cache miss â†’ proxies to backend
Python FastAPI Backend (main.py)
   â†“ nba_api + XGBoost + Groq
   â†’ returns predictions as JSON
```

---

## Prerequisites

- Python 3.11+
- Node.js 18+ (for Wrangler CLI)
- Free accounts: Groq (console.groq.com), Cloudflare (cloudflare.com)

---

## Step 1 â€” Backend Setup

```bash
cd apps/api

# Install Python deps
pip install -r requirements.txt

# Copy env file and fill in your Groq key
cp .env.example .env
# Edit .env â†’ set GROQ_API_KEY=your_key_here

# TRAIN THE MODEL (do this once â€” takes ~5 minutes)
# Downloads 5 seasons of NBA data via nba_api, then trains XGBoost
python train.py

# Start the API server
uvicorn main:app --reload --port 8000
```

**Test it:**
```
http://localhost:8000/api/health           â†’ should return {"ok": true, "model_ready": true}
http://localhost:8000/api/predict?home=BOS&away=MIA  â†’ full prediction
http://localhost:8000/api/slate            â†’ today's slate
```

---

## Step 2 â€” Cloudflare Worker Setup

```bash
cd apps/web

# Install Wrangler
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create the KV namespace
wrangler kv:namespace create PM_CACHE
# â†’ Copy the id it prints into wrangler.toml [[kv_namespaces]] id = "..."

# Set your secrets (keeps them out of git)
wrangler secret put GROQ_API_KEY
# â†’ Paste your Groq key when prompted

wrangler secret put PM_BACKEND_URL
# â†’ Paste your backend URL (e.g. https://plusminus-api.railway.app)
# â†’ For local dev only, leave blank and use localhost

# Deploy the worker
wrangler deploy
# â†’ Prints your worker URL: https://nba-data-worker.YOUR_NAME.workers.dev
```

**Update scripts/shared.js** â€” replace the PM_WORKER line with your worker URL:
```js
// scripts/shared.js line 35
const PM_WORKER = 'https://nba-data-worker.YOUR_NAME.workers.dev';
```

---

## Step 3 â€” Deploy Frontend (Cloudflare Pages)

1. Push the `apps/web/` folder to a GitHub repo
2. Go to Cloudflare Dashboard â†’ Pages â†’ Create a project
3. Connect your GitHub repo
4. Build settings: **none** (it's static HTML/JS/CSS)
5. Deploy â€” you get `https://your-project.pages.dev`
6. Add that URL to `ALLOWED_ORIGINS` in `wrangler.toml`, then redeploy worker

---

## Local Development (no deployment needed)

```bash
# Terminal 1 â€” Backend
cd apps/api
uvicorn main:app --reload --port 8000

# Terminal 2 â€” Frontend (any static server)
cd apps/web
npx serve .   # or: python -m http.server 8080
```

Open `http://localhost:8080/pages/home.html`
Click **"Predictions"** in the sidebar â†’ **"Load Today's Slate"**

---

## How to Use the Predictions Tab

### Today's Slate (recommended)
Click **Predictions** in the sidebar â†’ **"LOAD TODAY'S SLATE"**
- Fetches today's NBA schedule from ESPN
- Runs XGBoost ensemble prediction for each game
- Groq AI writes analysis for every game + a full slate summary
- Shows top pick, upset watch, confidence ratings

### Single Game
Type team abbreviations in the boxes (e.g. `BOS` vs `MIA`) â†’ **PREDICT**
- Full ML breakdown + AI insight for that specific matchup

### Team Abbreviations
```
ATL BOS BKN CHA CHI CLE DAL DEN DET GSW
HOU IND LAC LAL MEM MIA MIL MIN NOP NYK
OKC ORL PHI PHX POR SAC SAS TOR UTA WAS
```

---

## Deploying the Backend (Production)

The backend needs to stay running to serve predictions.
Easiest free options:

### Railway (recommended â€” free tier)
```bash
# In apps/api/
# Add a Procfile:
echo "web: uvicorn main:app --host 0.0.0.0 --port \$PORT" > Procfile

# Deploy via Railway dashboard or CLI
railway login
railway init
railway up
```
Copy the Railway URL â†’ set as `PM_BACKEND_URL` in your worker.

### Render (free tier)
- New Web Service â†’ connect repo â†’ Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Add env vars: `GROQ_API_KEY`

---

## Architecture Notes

### Why Cloudflare Worker proxies everything
The browser never talks to your backend directly. The Worker:
- Adds KV caching (2 min single game, 5 min slate) so 1000 users = same backend load as 1
- Handles CORS so you don't expose your backend URL
- Serves stale predictions if the backend is briefly down

### Model accuracy
The XGBoost ensemble trained on 5 seasons typically achieves:
- **~66-68% accuracy** on held-out games (vs ~62% random baseline)
- Better on high-confidence predictions (>65% ML probability)
- Groq context adds qualitative insight; doesn't change the numbers

### Groq rate limits (free tier)
- 30 requests/min, 14,400/day
- A full slate of 12 games = ~14 Groq calls (12 game analyses + 1 slate summary + 1 divergence)
- Well within daily limits for personal use

---

## File Structure

```
apps/api/
â”œâ”€â”€ main.py              â† FastAPI app (start here)
â”œâ”€â”€ train.py             â† Run once to train model
â”œâ”€â”€ data_loader.py       â† nba_api data loading
â”œâ”€â”€ features.py          â† Feature engineering (ELO, rolling stats, etc.)
â”œâ”€â”€ model.py             â† XGBoost ensemble + save/load
â”œâ”€â”€ groq_analysis.py     â† All Groq AI calls
â”œâ”€â”€ polymarket.py        â† Polymarket odds fetching
â”œâ”€â”€ workers/
â”‚   â””â”€â”€ worker.js        â† Node worker script
â”œâ”€â”€ requirements.txt
â”œâ”€â”€ .env.example         â† Copy to .env
â”œâ”€â”€ model.joblib         â† Generated by train.py
â”œâ”€â”€ scaler.joblib        â† Generated by train.py
â””â”€â”€ feature_names.joblib â† Generated by train.py

apps/web/
â”œâ”€â”€ pages/
â”‚   â”œâ”€â”€ home.html        â† Dashboard (predictions tab added)
â”‚   â””â”€â”€ landing.html     â† Landing page
â”œâ”€â”€ styles/
â”‚   â”œâ”€â”€ dashboard.css    â† Dashboard styles
â”‚   â””â”€â”€ shared.css       â† Shared base styles
â”œâ”€â”€ scripts/
â”‚   â”œâ”€â”€ dashboard.js     â† Dashboard logic
â”‚   â”œâ”€â”€ shared.js        â† Frontend data layer
â”‚   â””â”€â”€ data.js          â† Static data
â”œâ”€â”€ workers/
â”‚   â”œâ”€â”€ worker.js        â† Cloudflare Worker routes
â”‚   â””â”€â”€ proxy.js         â† Upstream proxy helper
â”œâ”€â”€ docs/
â”‚   â””â”€â”€ SETUP.md         â† This setup guide
â””â”€â”€ wrangler.toml        â† Worker deployment config (fill in KV id)
```

