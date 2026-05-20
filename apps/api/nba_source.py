"""
nba_source.py — lightweight server-side NBA stats adapter

Provides small helpers to fetch stats.nba.com endpoints or fall back to
`nba_api` when available. Responses are normalized and cached in memory
with a short TTL to avoid hammering upstream during local dev.

This file intentionally keeps its surface small: callers should fetch
only the slice they need (player logs, lineup summaries, etc.).
"""

import time
from datetime import datetime
from typing import Any, Dict, List, Optional

try:
    # prefer nba_api when available (already a dependency of the project)
    from nba_api.stats.endpoints import PlayerGameLog
    _HAS_NBA_API = True
except Exception:
    _HAS_NBA_API = False

import requests

# Browser-like headers that stats.nba.com expects
_BROWSER_HEADERS = {
    'Host': 'stats.nba.com',
    'Referer': 'https://www.nba.com/',
    'Origin': 'https://www.nba.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-nba-stats-origin': 'stats',
    'x-nba-stats-token': 'true',
    'Connection': 'keep-alive',
}

# Simple in-memory cache: key -> (ts, value)
_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 300  # seconds


def _cached(key: str) -> Optional[Any]:
    entry = _CACHE.get(key)
    if not entry:
        return None
    ts, val = entry
    if time.time() - ts > _CACHE_TTL:
        del _CACHE[key]
        return None
    return val


def _set_cache(key: str, val: Any) -> None:
    _CACHE[key] = (time.time(), val)


def fetch_player_game_log(player_id: int, season: Optional[str] = None) -> List[Dict[str, Any]]:
    """Fetch recent game logs for a player.

    Args:
        player_id: numeric NBA player id (e.g. 2544 = LeBron James)
        season: season label the API expects (e.g. '2024-25'). If None, the API
                default is used.

    Returns: list of game-row dicts (may be empty on error).
    """
    key = f"playerlog:{player_id}:{season or 'auto'}"
    cached = _cached(key)
    if cached is not None:
        return cached

    # Prefer the installed nba_api for stable parsing
    if _HAS_NBA_API:
        try:
            params = {}
            if season:
                params['season'] = season
            pg = PlayerGameLog(player_id=player_id, **params)
            # small delay safety is handled by caller if calling many players
            df = pg.get_data_frames()[0]
            rows = df.to_dict(orient='records') if not df.empty else []
            _set_cache(key, rows)
            return rows
        except Exception:
            # fall back to raw HTTP
            pass

    # Raw HTTP fallback to stats.nba.com endpoint
    season_q = f"&Season={season}" if season else ""
    url = f"https://stats.nba.com/stats/playergamelog?PlayerID={player_id}{season_q}&SeasonType=Regular+Season"
    try:
        resp = requests.get(url, headers=_BROWSER_HEADERS, timeout=8)
        resp.raise_for_status()
        js = resp.json()
        # stats.nba.com responses typically store headers + rowSet
        results = js.get('resultSets') or js.get('resultSet') or []
        # try common shapes
        rows = []
        if isinstance(results, list) and results:
            r = results[0]
            headers = r.get('headers') or r.get('columns') or []
            rowset = r.get('rowSet') or r.get('rows') or []
            for rr in rowset:
                row = {h: v for h, v in zip(headers, rr)}
                rows.append(row)
        elif isinstance(js, dict) and 'resultSet' in js:
            r = js['resultSet']
            headers = r.get('headers', [])
            rowset = r.get('rowSet', [])
            for rr in rowset:
                row = {h: v for h, v in zip(headers, rr)}
                rows.append(row)

        _set_cache(key, rows)
        return rows
    except Exception as e:
        # On failure, return empty list but do not raise to keep UI resilient
        return []


def clear_cache() -> None:
    """Clear the module cache (useful for tests)."""
    _CACHE.clear()


def _fetch_players_list(season_year: Optional[int] = None) -> List[Dict[str, Any]]:
    """Fetch and cache the NBA players master list from data.nba.net.

    season_year: an integer season start year, e.g. 2024 for 2024-25.
    Returns list of player dicts (may be empty on error).
    """
    def _nba_season_start_year() -> int:
        now = datetime.utcnow()
        return now.year if now.month >= 10 else now.year - 1

    years: List[int] = []
    if season_year is not None:
      years.append(int(season_year))
    years.extend([
        _nba_season_start_year(),
        _nba_season_start_year() - 1,
        time.gmtime().tm_year,
        time.gmtime().tm_year - 1,
    ])

    seen = set()
    for year in years:
        if year in seen:
            continue
        seen.add(year)

        key = f"players_list:{year}"
        cached = _cached(key)
        if cached is not None:
            return cached

        url = f"https://data.nba.net/prod/v1/{year}/players.json"
        try:
            resp = requests.get(url, headers=_BROWSER_HEADERS, timeout=6)
            resp.raise_for_status()
            js = resp.json()
            players = js.get('league', {}).get('standard', []) if isinstance(js, dict) else []
            if players:
                _set_cache(key, players)
                return players
        except Exception:
            continue

    return []


def get_player_id_by_name(name: str, season_year: Optional[int] = None) -> Optional[int]:
    """Best-effort lookup: return numeric player id for a given player name.

    Matches full name case-insensitively first, then last name contains.
    Returns None if not found.
    """
    if not name:
        return None
    players = _fetch_players_list(season_year)
    lname = name.strip().lower()
    # exact full name match
    for p in players:
        full = f"{p.get('firstName','').strip()} {p.get('lastName','').strip()}".strip().lower()
        if full == lname:
            try:
                return int(p.get('personId'))
            except Exception:
                return None
    # last-name partial match
    parts = lname.split()
    last = parts[-1]
    for p in players:
        if last in (p.get('lastName','').strip().lower()):
            try:
                return int(p.get('personId'))
            except Exception:
                continue
    return None


def fetch_team_roster(team_abbr: str, season_year: Optional[int] = None) -> List[Dict[str, Any]]:
    """Return roster entries for a team abbreviation (best-effort).

    Uses nba_api's current-team roster endpoint first, then falls back to the
    players.json master list if needed. Returns normalized player dicts.
    """
    try:
        from nba_api.stats.static import teams as _teams_static
        from nba_api.stats.endpoints import CommonTeamRoster
        team_map = {t['abbreviation']: t['id'] for t in _teams_static.get_teams()}
    except Exception:
        team_map = {}
        CommonTeamRoster = None  # type: ignore[assignment]

    tid = team_map.get(team_abbr.upper())

    if tid is not None and CommonTeamRoster is not None:
        try:
            roster_df = CommonTeamRoster(team_id=tid).get_data_frames()[0]
            roster = []
            for _, row in roster_df.iterrows():
                full_name = str(row.get('PLAYER', '')).strip()
                first_name, last_name = _split_player_name(full_name)
                roster.append({
                    'personId': row.get('PLAYER_ID'),
                    'firstName': first_name,
                    'lastName': last_name,
                    'name': full_name,
                    'teamId': tid,
                    'teamSitesOnly': {'teamTricode': team_abbr.upper()},
                    'position': row.get('POSITION'),
                    'number': row.get('NUM'),
                })
            if roster:
                return roster
        except Exception:
            pass

    players = _fetch_players_list(season_year)
    if not players:
        return []

    if tid is not None:
        # teamId in players.json is usually numeric string
        tid_s = str(tid)
        roster = [p for p in players if str(p.get('teamId', '')).strip() == tid_s]
        if roster:
            return roster

    # fallback: match by tricode inside nested object if available
    roster = []
    for p in players:
        ts = p.get('teamSitesOnly', {}) or p.get('team', {})
        tricode = (ts.get('teamTricode') or ts.get('teamAbbr') or ts.get('teamAbbreviation') or '').upper()
        if tricode == team_abbr.upper():
            roster.append(p)
    return roster


def _split_player_name(full_name: str) -> tuple[str, str]:
    parts = str(full_name or '').strip().split()
    if not parts:
        return '', ''
    if len(parts) == 1:
        return parts[0], ''
    return ' '.join(parts[:-1]), parts[-1]


def fetch_team_top_players(team_abbr: str, n: int = 3, season_year: Optional[int] = None) -> List[Dict[str, Any]]:
    """Return top-n players for a team with last-5-game averages.

    For each player on the roster, fetch up to 5 recent games and compute
    simple averages for PTS, REB, AST. Returns list ordered by games played
    or empty if none found.
    """
    roster = fetch_team_roster(team_abbr, season_year)
    results = []
    for p in roster:
        pid = p.get('personId') or p.get('personId') or p.get('personId')
        try:
            pid = int(pid)
        except Exception:
            continue
        rows = fetch_player_game_log(pid)
        if not rows:
            continue
        last = rows[:5]
        # normalize keys may be strings; use get safely
        def _sum(k):
            s = 0
            c = 0
            for r in last:
                v = r.get(k) if isinstance(r, dict) else None
                if v is None:
                    # some frames store numbers as strings at different keys
                    try:
                        v = int(r.get(k, 0))
                    except Exception:
                        v = 0
                s += float(v or 0)
                c += 1
            return (s / c) if c else 0.0

        pts = _sum('PTS')
        ast = _sum('AST')
        reb = _sum('REB')
        name = f"{p.get('firstName','').strip()} {p.get('lastName','').strip()}".strip()
        results.append({'player_id': pid, 'name': name, 'pts': pts, 'ast': ast, 'reb': reb, 'games': len(last)})

    # sort by pts desc as crude importance, return top n
    results = sorted(results, key=lambda x: -x['pts'])
    return results[:n]

