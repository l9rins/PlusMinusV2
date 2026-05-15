import time

import requests

_cache = {"data": {}, "ts": 0}
CACHE_TTL = 300  # 5 minutes


def fetch_injuries() -> dict:
    """Return active injuries keyed by team abbreviation."""
    global _cache
    if time.time() - _cache["ts"] < CACHE_TTL and _cache["data"]:
        return _cache["data"]

    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
    try:
        resp = requests.get(url, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        raw = resp.json()
    except Exception as e:
        print(f"[Injuries] fetch failed: {e}")
        return _cache["data"]

    result = {}
    for item in raw.get("injuries", []):
        abbr = item.get("team", {}).get("abbreviation", "")
        team_injuries = []
        for inj in item.get("injuries", []):
            status = str(inj.get("status", "")).upper()
            if status in ("OUT", "DOUBTFUL", "QUESTIONABLE"):
                team_injuries.append({
                    "player": inj.get("athlete", {}).get("displayName", ""),
                    "status": status,
                    "reason": inj.get("type", ""),
                    "is_out": status in ("OUT", "DOUBTFUL"),
                })
        if abbr and team_injuries:
            result[abbr] = team_injuries

    _cache = {"data": result, "ts": time.time()}
    return result


def get_injury_impact(team: str, injuries: dict) -> dict:
    team_injuries = injuries.get(team, [])
    outs = [i for i in team_injuries if i["is_out"]]
    questionable = [i for i in team_injuries if not i["is_out"]]
    return {
        "out_count": len(outs),
        "questionable_count": len(questionable),
        "out_players": [i["player"] for i in outs],
        "questionable_players": [i["player"] for i in questionable],
        "severity": "high" if len(outs) >= 2 else "medium" if outs else "low",
    }