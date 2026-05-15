"""
play_types.py — lightweight server-side play type approximations

Provides a helper `fetch_play_types_for_team(team, ttl)` that returns a small
array of play-type frequency/ppp objects for front-end consumption. This
is a heuristic implementation to be replaced by a proper play-type dataset.
"""
import os
import time

_cache = {"ts": 0, "data": {}}


def fetch_play_types_for_team(team: str, ttl: int = None):
    """Fetch play-type breakdown for a team with optional TTL override.
    
    Args:
        team: Team abbreviation (e.g. "BOS")
        ttl: Cache TTL in seconds. If None, reads from CACHE_TTL_PLAY_TYPES env var (default 300)
    
    Returns:
        List of play-type dicts with name, freq, ppp, ppp_diff keys
    """
    if ttl is None:
        ttl = int(os.getenv("CACHE_TTL_PLAY_TYPES", "300"))
    
    team = team.upper().strip()
    now = time.time()
    if team in _cache["data"] and now - _cache["ts"] < ttl:
        return _cache["data"][team]

    # Heuristic sample set — frequencies sum may not equal 100 but approximate
    sample = [
        {"name": "Pick & Roll Ball Handler", "freq": 24, "ppp": 1.14, "ppp_diff": 0.02},
        {"name": "Isolation", "freq": 12, "ppp": 1.06, "ppp_diff": -0.01},
        {"name": "Transition", "freq": 15, "ppp": 1.28, "ppp_diff": 0.05},
        {"name": "Post-Up", "freq": 9, "ppp": 1.02, "ppp_diff": -0.02},
        {"name": "Cut", "freq": 7, "ppp": 1.42, "ppp_diff": 0.08},
        {"name": "Spot-Up", "freq": 18, "ppp": 1.09, "ppp_diff": 0.02},
    ]

    _cache["data"][team] = sample
    _cache["ts"] = now
    return sample
