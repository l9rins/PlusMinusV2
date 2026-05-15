"""
main.py — Plus-Minus NBA Prediction API (FastAPI)

Endpoints:
  GET  /api/predict?home=BOS&away=MIA           → single game prediction
  GET  /api/slate                               → all of today's games with predictions
  GET  /api/standings                           → current team ELO rankings
  GET  /api/health                              → health check
  POST /api/chat                                → Groq NBA chat (mirrors worker /api/chat)
"""

import os
import time
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

import warnings
warnings.filterwarnings("ignore")

NBA_TIME_ZONE = ZoneInfo("America/New_York")


def _nba_date_compact() -> str:
    """Return the NBA operational date in Eastern Time, formatted YYYYMMDD."""
    return datetime.now(NBA_TIME_ZONE).strftime("%Y%m%d")

# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL STATE — loaded once at startup
# ─────────────────────────────────────────────────────────────────────────────

_model = None
_scaler = None
_feature_cols = None
_team_stats = None
_elo_system = None
_featured_df = None
_startup_error = None


def _build_fallback_elo():
    """Create an initialized ELO system so predictions can run in fallback mode."""
    from features import NBAELO
    from nba_api.stats.static import teams as nba_teams

    elo = NBAELO()
    for team in nba_teams.get_teams():
        abbr = team.get("abbreviation")
        if abbr:
            elo.ratings[abbr] = 1500.0
    return elo


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model and data at startup."""
    global _model, _scaler, _feature_cols, _team_stats, _elo_system, _startup_error

    print("[PM] Starting Plus-Minus NBA API...")

    try:
        from apps.api.model import load_model
    except ImportError:
        from model import load_model

    try:
        _model, _scaler, _feature_cols = load_model()
        print("[PM] OK Model loaded")
    except FileNotFoundError:
        _startup_error = "Model not trained. Run: python train.py"
        print(f"[PM] WARNING {_startup_error}")

    # Load team stats for live prediction (runs in thread to avoid blocking)
    if _startup_error is None:
        try:
            loop = asyncio.get_event_loop()
            timeout_s = int(os.getenv("BOOTSTRAP_TEAM_STATS_TIMEOUT_S", "20"))
            await asyncio.wait_for(loop.run_in_executor(None, _load_team_stats), timeout=timeout_s)
            print("[PM] OK Team stats loaded")
        except asyncio.TimeoutError:
            print("[PM] WARNING Team stats load timed out; using ELO-only fallback")
            if _elo_system is None:
                _elo_system = _build_fallback_elo()
            if _team_stats is None:
                _team_stats = {}
        except Exception as e:
            print(f"[PM] WARNING Team stats load failed: {e}")
            if _elo_system is None:
                _elo_system = _build_fallback_elo()
            if _team_stats is None:
                _team_stats = {}

    print("[PM] OK API ready")
    yield
    print("[PM] Shutting down...")


def _load_team_stats():
    """Load recent seasons for rolling stats + ELO. Called once at startup."""
    global _team_stats, _elo_system, _featured_df

    from data_loader import load_seasons, clean
    from features import build_full_features, build_rolling_stats

    seasons = ["2024-25", "2023-24"]
    raw = load_seasons(seasons)
    if raw.empty:
        _team_stats = {}
        _elo_system = _build_fallback_elo()
        _featured_df = None
        return

    clean_data = clean(raw)
    featured, elo = build_full_features(clean_data)

    _featured_df = featured
    _elo_system = elo
    _team_stats = build_rolling_stats(clean_data)


# ─────────────────────────────────────────────────────────────────────────────
# APP SETUP
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Plus-Minus NBA Prediction API",
    version="1.0.0",
    lifespan=lifespan,
)

# TTL configuration via environment variables (seconds)
CACHE_TTL_INJURIES = int(os.getenv("CACHE_TTL_INJURIES", "300"))     # 5 minutes default
CACHE_TTL_SHOT_ZONES = int(os.getenv("CACHE_TTL_SHOT_ZONES", "60"))   # 1 minute default
CACHE_TTL_LINEUPS = int(os.getenv("CACHE_TTL_LINEUPS", "120"))        # 2 minutes default
CACHE_TTL_PLAY_TYPES = int(os.getenv("CACHE_TTL_PLAY_TYPES", "300"))  # 5 minutes default

# CORS — allow the Cloudflare Worker and local dev
_allowed_origins = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:8080,http://127.0.0.1:5500").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _require_model():
    if _startup_error:
        raise HTTPException(status_code=503, detail=_startup_error)
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not ready")


def _get_team_form(team: str, is_home: bool) -> dict:
    """Get the latest rolling stats for a team."""
    if _team_stats is None:
        return {}
    td = _team_stats.get(team)
    if td is None:
        return {}
    role = 1 if is_home else 0
    subset = td[td["IsHome"] == role]
    if subset.empty:
        subset = td
    latest = subset.sort_values("Date").iloc[-1]
    return {k: (round(float(v), 3) if isinstance(v, (float, np.floating)) else v)
            for k, v in latest.to_dict().items()
            if not isinstance(v, pd.Timestamp)}


# New utility: expose player game logs for frontend or debugging
try:
    from apps.api.nba_source import fetch_player_game_log, fetch_team_top_players
except ImportError:
    from nba_source import fetch_player_game_log, fetch_team_top_players
try:
    from apps.api.injuries import fetch_injuries, get_injury_impact
except ImportError:
    from injuries import fetch_injuries, get_injury_impact

try:
    from apps.api.play_types import fetch_play_types_for_team
except ImportError:
    fetch_play_types_for_team = None


@app.get("/api/playerlog")
async def player_log(player_id: int = Query(..., description="Numeric NBA player id"), season: str | None = Query(None, description="Season label e.g. 2024-25")):
    """Return recent player game logs (normalized list of rows).

    This is a lightweight debugging/data endpoint used by the dashboard and
    by ad-hoc analysis. It uses a server-side adapter that respects NBA
    CDN access patterns and caches results briefly.
    """
    try:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(None, fetch_player_game_log, int(player_id), season)
        return {"source": "stats.nba.com", "player_id": int(player_id), "season": season, "games": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/team_top_players")
async def team_top_players(team: str = Query(..., description="Team abbreviation e.g. BOS"), n: int = Query(3, description="Number of players")):
    """Return top-n recent-form players for a given team.

    Calls the server-side adapter which computes last-5-game averages.
    """
    try:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(None, fetch_team_top_players, team.upper(), n)
        return {"team": team.upper(), "players": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/injuries")
async def api_injuries(team: str | None = Query(None, description="Optional team abbreviation to filter")):
    """Return current injury feed (cached) or a single team's injury impact."""
    try:
        loop = asyncio.get_event_loop()

        # simple module-level cache for injuries
        if not hasattr(api_injuries, "_cache"):
            api_injuries._cache = {"ts": 0, "data": None}
        now = time.time()
        cached = api_injuries._cache

        # Fetch or use cached injuries
        if now - cached["ts"] < CACHE_TTL_INJURIES and cached["data"] is not None:
            injuries = cached["data"]
        else:
            injuries = await loop.run_in_executor(None, fetch_injuries)
            cached["data"] = injuries
            cached["ts"] = now

        if team:
            team_up = team.upper().strip()
            impact = await loop.run_in_executor(None, get_injury_impact, team_up, injuries)
            return {"team": team_up, "injuries": injuries.get(team_up, []), "impact": impact}
        return {"injuries": injuries}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/shot_zones")
async def api_shot_zones(team: str = Query(..., description="Team abbreviation e.g. BOS")):
    """Return a lightweight shot-zone distribution approximation for a team.

    This endpoint uses rolling team stats to heuristically estimate zone shares
    (rim, paint non-rim, mid-range, corner-3, above-break-3) for quick front-end display.
    """
    try:
        t = team.upper().strip()
        # simple module-level cache for hot endpoints
        if not hasattr(api_shot_zones, "_cache"):
            api_shot_zones._cache = {"ts": 0, "data": {}}
        now = time.time()
        cached = api_shot_zones._cache
        if now - cached["ts"] < CACHE_TTL_SHOT_ZONES and t in cached["data"]:
            return cached["data"][t]

        # prefer rolling stats if available
        team_df = _team_stats.get(t) if _team_stats else None
        if team_df is not None and not team_df.empty:
            # take the last available avg row
            last = team_df.sort_values("Date").iloc[-1]
            efg = float(last.get("avg_eFG_PCT", 0.0) or 0.0)
            fg3 = float(last.get("avg_FG3_PCT", 0.0) or 0.0)
            oreb = float(last.get("avg_OREB", 0.0) or 0.0)
            pace = float(last.get("avg_POSS", 100.0) or 100.0)
            # heuristic distribution
            rim = max(8, min(38, 32 + (efg - 0.52) * 40))
            corner3 = max(4, min(18, 10 + (fg3 - 0.35) * 40))
            above3 = max(18, min(40, 28 + (efg - 0.52) * 20))
            mid = max(6, min(20, 100 - rim - corner3 - above3 - 6))
            paint_nr = max(6, min(20, 100 - rim - corner3 - above3 - mid))
            zones = {
                "rim": round(rim, 1),
                "paint_non_rim": round(paint_nr, 1),
                "mid_range": round(mid, 1),
                "corner_3": round(corner3, 1),
                "above_break_3": round(above3, 1),
            }
            resp = {"team": t, "source": "heuristic_team_stats", "zones": zones}
            cached["data"][t] = resp
            cached["ts"] = now
            return resp

        # fallback defaults
        zones = {"rim": 32.0, "paint_non_rim": 12.0, "mid_range": 14.0, "corner_3": 10.0, "above_break_3": 32.0}
        resp = {"team": t, "source": "fallback", "zones": zones}
        cached["data"][t] = resp
        cached["ts"] = now
        return resp
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/lineups")
async def api_lineups(team: str = Query(..., description="Team abbreviation e.g. BOS"), top_n: int = Query(5, ge=2, le=10, description="Top players to consider")):
    """Return approximate two- and three-man lineup combos for a team.

    This endpoint is best-effort: it fetches the team's top players and recent
    game logs and produces approximate minute and netRtg estimates for pairs
    and triples. It is intended for frontend display and quick filtering.
    """
    try:
        loop = asyncio.get_event_loop()
        # simple cache per-team for lineups (short TTL)
        if not hasattr(api_lineups, "_cache"):
            api_lineups._cache = {"ts": 0, "data": {}}
        now = time.time()
        cached = api_lineups._cache
        key = f"{team.upper()}:{top_n}"
        if now - cached["ts"] < CACHE_TTL_LINEUPS and key in cached["data"]:
            return cached["data"][key]

        players = await loop.run_in_executor(None, fetch_team_top_players, team.upper(), top_n)
        if not players:
            return {"team": team.upper(), "combos": []}

        # For each player, fetch recent game log and compute avg minutes and pm per 48
        details = []
        for p in players:
            pid = int(p.get("player_id") or p.get("player_id") or 0)
            rows = await loop.run_in_executor(None, fetch_player_game_log, pid)
            mins = []
            pm = []
            for r in rows[:8]:
                # flexible keys for minutes and plus-minus
                m = r.get('MIN') or r.get('MINUTES') or r.get('MINUTES_REPORTED') or r.get('min') or None
                pmv = r.get('PLUS_MINUS') or r.get('PLUSMINUS') or r.get('pm') or r.get('PlusMinus') or None
                try:
                    mnum = float(str(m).replace(':', '.')) if m is not None else 0
                except Exception:
                    try:
                        mnum = float(m)
                    except Exception:
                        mnum = 0
                try:
                    pmnum = float(pmv) if pmv is not None else 0
                except Exception:
                    pmnum = 0
                if mnum > 0:
                    mins.append(mnum)
                    pm.append(pmnum)
            avg_min = (sum(mins) / len(mins)) if mins else 12.0
            avg_pm = (sum(pm) / len(pm)) if pm else 0.0
            pm48 = (avg_pm / max(1, avg_min)) * 48.0
            details.append({"player_id": pid, "name": p.get("name"), "avg_min": round(avg_min, 1), "pm48": round(pm48, 2)})

        def _latest_team_net_rating() -> float:
            team_df = _team_stats.get(team.upper()) if _team_stats else None
            if team_df is None or team_df.empty:
                return 0.0
            latest = team_df.sort_values("Date").iloc[-1]
            for col in ("avg_NET_RTG", "NET_RTG"):
                try:
                    val = latest.get(col, 0.0)
                    if pd.notna(val):
                        return float(val)
                except Exception:
                    continue
            return 0.0

        team_net = _latest_team_net_rating()

        # generate combos
        combos = []
        # pairs
        for i in range(len(details)):
            for j in range(i + 1, len(details)):
                a = details[i]; b = details[j]
                minutes = round((a['avg_min'] + b['avg_min']) * 0.7, 0)  # overlap adjustment
                net_rtg = round((a['pm48'] + b['pm48']) * 0.5 + team_net, 1)
                combos.append({"players": f"{a['name']} + {b['name']}", "min": minutes, "netRtg": net_rtg, "ppp": round(1.0 + net_rtg / 40.0, 2)})
        # triples
        for i in range(len(details)):
            for j in range(i + 1, len(details)):
                for k in range(j + 1, len(details)):
                    a = details[i]; b = details[j]; c = details[k]
                    minutes = round((a['avg_min'] + b['avg_min'] + c['avg_min']) * 0.55, 0)
                    net_rtg = round((a['pm48'] + b['pm48'] + c['pm48']) * 0.4 + team_net, 1)
                    combos.append({"players": f"{a['name']} + {b['name']} + {c['name']}", "min": minutes, "netRtg": net_rtg, "ppp": round(1.0 + net_rtg / 48.0, 2)})

        # sort by netRtg desc and return
        combos = sorted(combos, key=lambda x: x['netRtg'], reverse=True)
        resp = {"team": team.upper(), "combos": combos}
        cached["data"][key] = resp
        cached["ts"] = now
        return resp
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/play_types")
async def api_play_types(team: str = Query(..., description="Team abbreviation e.g. BOS")):
    """Return play-type breakdown for a team (heuristic or precomputed).

    Uses `apps.api.play_types.fetch_play_types_for_team` with configurable TTL.
    """
    try:
        t = team.upper().strip()
        # simple module-level cache for play types
        if not hasattr(api_play_types, "_cache"):
            api_play_types._cache = {"ts": 0, "data": {}}
        now = time.time()
        cached = api_play_types._cache

        if now - cached["ts"] < CACHE_TTL_PLAY_TYPES and t in cached["data"]:
            return cached["data"][t]

        loop = asyncio.get_event_loop()
        if fetch_play_types_for_team:
            data = await loop.run_in_executor(None, fetch_play_types_for_team, t, CACHE_TTL_PLAY_TYPES)
        else:
            # fallback: mirror the frontend sample
            data = [
                {"name": "Pick & Roll Ball Handler", "freq": 24, "ppp": 1.14, "ppp_diff": 0.02},
                {"name": "Isolation", "freq": 12, "ppp": 1.06, "ppp_diff": -0.01},
                {"name": "Transition", "freq": 15, "ppp": 1.28, "ppp_diff": 0.05},
                {"name": "Post-Up", "freq": 9, "ppp": 1.02, "ppp_diff": -0.02},
                {"name": "Cut", "freq": 7, "ppp": 1.42, "ppp_diff": 0.08},
                {"name": "Spot-Up", "freq": 18, "ppp": 1.09, "ppp_diff": 0.02},
            ]

        resp = {"team": t, "play_types": data, "source": "heuristic_rolling_stats"}
        cached["data"][t] = resp
        cached["ts"] = now
        return resp
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "model_ready": _model is not None,
        "team_stats_ready": _team_stats is not None,
        "startup_error": _startup_error,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/predict?home=BOS&away=MIA
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/predict")
async def predict(
    home: str = Query(..., description="Home team abbreviation e.g. BOS"),
    away: str = Query(..., description="Away team abbreviation e.g. MIA"),
    include_polymarket: bool = Query(False, description="Fetch Polymarket odds (slower)"),
):
    _require_model()

    home = home.upper().strip()
    away = away.upper().strip()

    # 1. ML probabilities
    try:
        from apps.api import model as modelmod
    except ImportError:
        import model as modelmod

    ml_probs = modelmod.predict_proba(_model, _scaler, _feature_cols, _team_stats, _elo_system, home, away)

    # 2. Team form (for display + Groq context)
    home_form = _get_team_form(home, is_home=True)
    away_form = _get_team_form(away, is_home=False)

    loop = asyncio.get_event_loop()

    from injuries import fetch_injuries, get_injury_impact
    injuries = await loop.run_in_executor(None, fetch_injuries)
    home_injuries = get_injury_impact(home, injuries)
    away_injuries = get_injury_impact(away, injuries)

    home_penalty = home_injuries["out_count"] * 0.025
    away_penalty = away_injuries["out_count"] * 0.025
    adjusted_home = ml_probs["home_win"] - home_penalty + away_penalty
    adjusted_home = max(0.05, min(0.95, adjusted_home))
    ml_probs = {
        "home_win": round(adjusted_home, 4),
        "away_win": round(1 - adjusted_home, 4),
        "source": "ml_ensemble_injury_adjusted",
    }

    # 3. Groq analysis
    from groq_analysis import analyze_matchup
    groq_result = await loop.run_in_executor(
        None, analyze_matchup, home, away, ml_probs, home_form, away_form, home_injuries, away_injuries
    )

    # 4. Polymarket (optional, slower)
    poly_probs = None
    poly_divergence = None
    if include_polymarket:
        from polymarket import get_market_for_game
        from groq_analysis import analyze_divergence

        poly_probs = await loop.run_in_executor(None, get_market_for_game, home, away)
        if poly_probs and abs(ml_probs["home_win"] - poly_probs["home_win"]) > 0.05:
            poly_divergence = await loop.run_in_executor(
                None, analyze_divergence,
                home, away, ml_probs, poly_probs, poly_probs.get("liquidity", 0)
            )

    # 5. Triple-blend final probability (if Polymarket available)
    if poly_probs:
        w_ml, w_poly = 0.60, 0.40
        final_home = w_ml * ml_probs["home_win"] + w_poly * poly_probs["home_win"]
        final_away = 1 - final_home
        final_probs = {"home_win": round(final_home, 4), "away_win": round(round(final_away, 4), 4)}
    else:
        final_probs = ml_probs

    # 6. ELO
    elo_home = _elo_system.get(home) if _elo_system else 1500
    elo_away = _elo_system.get(away) if _elo_system else 1500

    return {
        "game": f"{home} vs {away}",
        "home_team": home,
        "away_team": away,
        "final_probs": final_probs,
        "layers": {
            "ml_model": ml_probs,
            "polymarket": poly_probs,
        },
        "elo": {"home": round(elo_home), "away": round(elo_away), "diff": round(elo_home - elo_away)},
        "ai_analysis": groq_result,
        "poly_divergence": poly_divergence,
        "injuries": {
            "home": home_injuries,
            "away": away_injuries,
        },
        "home_form": {k: v for k, v in home_form.items() if k.startswith(("avg_", "Form", "Streak"))},
        "away_form": {k: v for k, v in away_form.items() if k.startswith(("avg_", "Form", "Streak"))},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/slate — all of today's games with predictions
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/slate")
async def slate(include_ai: bool = Query(False, description="Include Groq AI analysis for slate; may increase latency and cost")):
    _require_model()

    # Fetch today's games from ESPN (same source as worker)
    import requests
    today = _nba_date_compact()
    games_raw = []

    try:
        resp = requests.get(
            f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={today}",
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=8,
        )
        resp.raise_for_status()
        events = resp.json().get("events", [])

        for ev in events:
            comp = ev.get("competitions", [{}])[0]
            home_c = next((c for c in comp.get("competitors", []) if c["homeAway"] == "home"), None)
            away_c = next((c for c in comp.get("competitors", []) if c["homeAway"] == "away"), None)
            if home_c and away_c:
                games_raw.append({
                    "home_team": home_c["team"]["abbreviation"],
                    "away_team": away_c["team"]["abbreviation"],
                    "status": ev.get("status", {}).get("type", {}).get("state", "pre"),
                    "start_time": ev.get("date", ""),
                })
    except Exception as e:
        print(f"  [Slate] ESPN fetch failed: {e}")

    if not games_raw:
        return {
            "date": today,
            "timezone": "America/New_York",
            "games": [],
            "slate_analysis": None,
            "error": "No games today",
        }

    # Run predictions for each game

    loop = asyncio.get_event_loop()

    try:
        from apps.api import model as modelmod
    except ImportError:
        import model as modelmod

    async def _predict_one(g):
        home, away = g["home_team"], g["away_team"]
        ml_probs = await loop.run_in_executor(
            None, modelmod.predict_proba,
            _model, _scaler, _feature_cols, _team_stats, _elo_system, home, away
        )
        elo_home = _elo_system.get(home) if _elo_system else 1500
        elo_away = _elo_system.get(away) if _elo_system else 1500
        home_form = _get_team_form(home, is_home=True)
        away_form = _get_team_form(away, is_home=False)
        return {
            **g,
            "ml_probs": ml_probs,
            "elo": {"home": round(elo_home), "away": round(elo_away), "diff": round(elo_home - elo_away)},
            "elo_home": round(elo_home),
            "elo_away": round(elo_away),
            "home_b2b": int(home_form.get("home_b2b", 0) or 0),
            "away_b2b": int(away_form.get("away_b2b", 0) or 0),
            "home_form": {k: v for k, v in home_form.items() if k.startswith(("avg_", "Form", "Streak"))},
            "away_form": {k: v for k, v in away_form.items() if k.startswith(("avg_", "Form", "Streak"))},
        }

    predictions = await asyncio.gather(*[_predict_one(g) for g in games_raw])

    slate_analysis = None
    if include_ai:
        from apps.api.groq_analysis import analyze_slate, analyze_matchup

        # Single Groq call for the whole slate
        slate_analysis = await loop.run_in_executor(None, analyze_slate, predictions)

        # Attach per-game Groq analysis (costly) only when requested
        async def _analyze_one(p):
            home_form = _get_team_form(p["home_team"], is_home=True)
            away_form = _get_team_form(p["away_team"], is_home=False)
            p["ai_analysis"] = await loop.run_in_executor(
                None, analyze_matchup,
                p["home_team"], p["away_team"], p["ml_probs"], home_form, away_form
            )
            return p

        predictions = await asyncio.gather(*[_analyze_one(p) for p in predictions])

    return {
        "date": today,
        "timezone": "America/New_York",
        "game_count": len(predictions),
        "games": predictions,
        "slate_analysis": slate_analysis,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/standings — team ELO rankings
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/standings")
def elo_standings():
    if _elo_system is None:
        raise HTTPException(status_code=503, detail="ELO system not ready")

    sorted_teams = sorted(_elo_system.ratings.items(), key=lambda x: -x[1])
    return {
        "rankings": [
            {"rank": i + 1, "team": team, "elo": round(rating)}
            for i, (team, rating) in enumerate(sorted_teams)
        ],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/chat — NBA assistant (mirrors worker /api/chat for local dev)
# ─────────────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str

@app.post("/api/chat")
async def chat(req: ChatRequest):
    from groq import Groq
    import json as _json

    msg = req.message.strip()[:500]
    if not msg:
        raise HTTPException(status_code=400, detail="Missing message")

    # Build context from live ELO standings
    context = {}
    if _elo_system:
        top10 = sorted(_elo_system.ratings.items(), key=lambda x: -x[1])[:10]
        context["elo_top10"] = [{"team": t, "elo": round(r)} for t, r in top10]

    try:
        groq_key = os.getenv("GROQ_API_KEY")
        if not groq_key:
            raise HTTPException(status_code=503, detail="GROQ_API_KEY not configured")

        client = Groq(api_key=groq_key)
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=400,
            temperature=0.4,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are PM, the Plus-Minus NBA assistant. "
                        "Answer questions about NBA stats, teams, and predictions concisely (1-3 sentences). "
                        f"Live ELO context: {_json.dumps(context)}"
                    ),
                },
                {"role": "user", "content": msg},
            ],
        )
        return {"reply": resp.choices[0].message.content.strip()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI service error: {e}")
