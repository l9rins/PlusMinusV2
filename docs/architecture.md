# Architecture

Plus-Minus is organized as a small production-style monorepo.

```text
apps/
  api/
    main.py              FastAPI app and prediction endpoints
    model.py             Model loading and inference
    features.py          Feature engineering
    data_loader.py       NBA data ingestion
    groq_analysis.py     Groq-generated matchup/slate analysis
    *.joblib             Trained model artifacts
  web/
    pages/               Static app screens
    scripts/             Browser data layer and dashboard logic
    styles/              Shared and dashboard styles
    workers/worker.js    Cloudflare Worker API/cache layer
    workers/proxy.js     Local development CORS/Groq proxy
docs/                    Setup, architecture, data-quality notes
scripts/                 Developer checks and automation
```

## Runtime Flow

```text
Browser dashboard
  -> apps/web/scripts/shared.js
  -> Cloudflare Worker for live NBA/ESPN data
  -> FastAPI backend for model predictions
  -> Groq for natural-language analysis
```

## Data Boundaries

- The browser never calls ESPN/NBA APIs directly in production.
- The Cloudflare Worker owns caching, upstream fallbacks, CORS, and lightweight status diagnostics.
- The FastAPI app owns model loading, feature generation, predictions, and Groq prediction context.
- Secrets stay out of frontend code. Local secrets live in `apps/api/.env`; production secrets live in Cloudflare.

## Recruiter-Facing Highlights

- Clear monorepo separation: `apps/api`, `apps/web`, `docs`, `scripts`.
- One-command verification via `check.ps1`.
- Explicit data-quality strategy with source, freshness, fallback, and timezone handling.
- Backend health endpoint and Worker status endpoint for operational visibility.

