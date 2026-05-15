# polymarket.py — Fetch NBA market probabilities from Polymarket Gamma API

import re
import time
import requests

GAMMA_API = "https://gamma-api.polymarket.com"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

NBA_KEYWORDS = [
    "nba", "lakers", "celtics", "warriors", "bucks", "nuggets",
    "76ers", "knicks", "heat", "cavaliers", "thunder", "timberwolves",
    "mavericks", "suns", "nets", "clippers", "hawks", "bulls",
    "pacers", "magic", "spurs", "pistons", "kings", "rockets",
    "grizzlies", "jazz", "blazers", "hornets", "pelicans", "raptors",
    "win the game", "beats", "cover the spread",
]


def fetch_nba_markets(limit: int = 100) -> list[dict]:
    """
    Fetch active NBA markets from Polymarket Gamma API.
    Returns raw market dicts.
    """
    markets = []
    offset = 0

    while offset < limit:
        try:
            resp = requests.get(
                f"{GAMMA_API}/markets",
                params={"active": "true", "closed": "false", "limit": 50, "offset": offset},
                headers=HEADERS,
                timeout=10,
            )
            resp.raise_for_status()
            batch = resp.json()
            if not batch:
                break

            for m in batch:
                text = (m.get("question", "") + " " + m.get("description", "")).lower()
                if any(kw in text for kw in NBA_KEYWORDS):
                    markets.append(m)

            offset += 50
            time.sleep(0.3)

        except requests.RequestException as e:
            print(f"  [Polymarket] Fetch error: {e}")
            break

    return markets


def extract_game_probs(market: dict) -> dict | None:
    """
    Extract win probabilities from a binary market.
    Returns {"home_win": float, "away_win": float, "liquidity": float, "volume_24h": float}
    or None if the market can't be parsed.
    """
    import json as _json

    prices_raw = market.get("outcomePrices", "[]")
    if isinstance(prices_raw, str):
        try:
            prices = _json.loads(prices_raw)
        except Exception:
            return None
    else:
        prices = prices_raw

    if len(prices) < 2:
        return None

    try:
        p0, p1 = float(prices[0]), float(prices[1])
        if p0 <= 0 or p1 <= 0:
            return None
        # Normalize to sum to 1
        total = p0 + p1
        return {
            "home_win": round(p0 / total, 4),
            "away_win": round(p1 / total, 4),
            "liquidity": float(market.get("liquidity") or 0),
            "volume_24h": float(market.get("volume24hr") or 0),
            "slug": market.get("slug", ""),
            "question": market.get("question", ""),
        }
    except (ValueError, TypeError):
        return None


def match_game_to_market(
    home_team: str,
    away_team: str,
    markets: list[dict],
) -> dict | None:
    """
    Try to find a Polymarket market matching a specific NBA game.
    Uses fuzzy team name matching.
    """
    # Map abbreviations → possible full names / nicknames
    TEAM_NAMES = {
        "ATL": ["hawks", "atlanta"], "BOS": ["celtics", "boston"],
        "BKN": ["nets", "brooklyn"], "CHA": ["hornets", "charlotte"],
        "CHI": ["bulls", "chicago"], "CLE": ["cavaliers", "cleveland", "cavs"],
        "DAL": ["mavericks", "dallas", "mavs"], "DEN": ["nuggets", "denver"],
        "DET": ["pistons", "detroit"], "GSW": ["warriors", "golden state", "gsw"],
        "HOU": ["rockets", "houston"], "IND": ["pacers", "indiana"],
        "LAC": ["clippers", "la clippers"], "LAL": ["lakers", "los angeles lakers", "lal"],
        "MEM": ["grizzlies", "memphis"], "MIA": ["heat", "miami"],
        "MIL": ["bucks", "milwaukee"], "MIN": ["timberwolves", "minnesota", "wolves"],
        "NOP": ["pelicans", "new orleans"], "NYK": ["knicks", "new york"],
        "OKC": ["thunder", "oklahoma city"], "ORL": ["magic", "orlando"],
        "PHI": ["76ers", "philadelphia", "sixers", "philly"],
        "PHX": ["suns", "phoenix"], "POR": ["trail blazers", "portland", "blazers"],
        "SAC": ["kings", "sacramento"], "SAS": ["spurs", "san antonio"],
        "TOR": ["raptors", "toronto"], "UTA": ["jazz", "utah"],
        "WAS": ["wizards", "washington"],
    }

    home_kws = TEAM_NAMES.get(home_team, [home_team.lower()])
    away_kws = TEAM_NAMES.get(away_team, [away_team.lower()])

    best_market = None
    best_score = 0

    for m in markets:
        q = (m.get("question", "") + " " + m.get("description", "")).lower()
        score = 0
        for kw in home_kws:
            if kw in q:
                score += 1
        for kw in away_kws:
            if kw in q:
                score += 1
        if score > best_score:
            best_score = score
            best_market = m

    if best_score >= 2:  # Both teams matched
        return extract_game_probs(best_market)
    return None


def get_market_for_game(home_team: str, away_team: str) -> dict | None:
    """
    Convenience: fetch all NBA markets and find the one for this game.
    """
    try:
        markets = fetch_nba_markets(limit=100)
        return match_game_to_market(home_team, away_team, markets)
    except Exception as e:
        print(f"  [Polymarket] get_market_for_game failed: {e}")
        return None
