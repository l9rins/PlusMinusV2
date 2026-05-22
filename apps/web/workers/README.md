# Cloudflare Worker (apps/web/workers/worker.js)

This folder contains the Cloudflare Worker source used as a CDN+proxy layer.

Recommended deployment steps (requires `wrangler` configured with your account):

1. Install Wrangler (if not already):

```bash
npm install -g wrangler
```

2. Ensure `wrangler.toml` is configured with your account id, KV namespace, and `PM_BACKEND_URL` if you want the worker to proxy to a remote backend in production.

3. Build (if you use a bundler) and publish:

```bash
wrangler publish --env production
```

4. For local development use `wrangler dev` and point your client to the worker host.

Notes:
- The worker now performs lightweight validation on query parameters for endpoints that require them (e.g. `?team=...`, `?player_id=...`). This mirrors FastAPI validation and helps parity tests.
- If you cannot deploy the worker immediately, the client will prefer the backend directly (see `backendFirstFetch()` in `apps/web/scripts/shared.js`).
