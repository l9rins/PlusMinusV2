# Data Quality

The app treats sports data as time-sensitive operational data, not static content.

## Freshness Rules

- Scoreboard cache is keyed by NBA Eastern date.
- Scoreboard cache is considered stale after 30 seconds in the browser.
- Worker scoreboard cache is 60 seconds.
- Worker schedule cache is 30 minutes.
- Stale scoreboard data is only used when fresh upstream data fails.

## Source Order

Scoreboard:

```text
NBA CDN -> ESPN scoreboard -> stale Worker KV -> empty/error state
```

Schedule:

```text
ESPN date scoreboard -> Worker KV -> visible empty/error state
```

Predictions:

```text
Browser -> local FastAPI in dev
Browser -> Cloudflare Worker -> FastAPI in production
```

## Timezone Rule

NBA game days are keyed to `America/New_York`. This avoids the common bug where users outside the United States see tomorrow/yesterday's games because the browser or server uses local time or UTC.

## UI Contract

The UI should show real data states:

- `live`: data just fetched from upstream.
- `cache`: warm cache inside the freshness window.
- `stale`: older cache used because upstream failed.
- `error` or empty state: no trustworthy data available.

The app should not silently substitute unrelated historical or scoreboard data just to fill a card.

