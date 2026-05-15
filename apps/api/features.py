# features.py — Rolling stats, ELO, fatigue, H2H, Four Factors diff

from functools import lru_cache
import time

import numpy as np
import pandas as pd

from nba_api.stats.endpoints import LeagueDashPlayerStats
from nba_api.stats.static import teams


ROLLING_WINDOW = 10  # last N games for rolling averages
PLAYER_TOP_N = 3
PLAYER_RECENT_GAMES = 5
PLAYER_STAT_COLS = ["PTS", "REB", "AST"]


def _team_id_map() -> dict:
    return {t["abbreviation"]: t["id"] for t in teams.get_teams()}


@lru_cache(maxsize=256)
def _fetch_player_leaderboard(season: str, date_to: str) -> pd.DataFrame:
    """Fetch player leaderboard with retry logic and exponential backoff."""
    max_retries = 3
    base_delay = 1  # seconds
    
    for attempt in range(max_retries):
        try:
            endpoint = LeagueDashPlayerStats(
                last_n_games=str(PLAYER_RECENT_GAMES),
                measure_type_detailed_defense="Base",
                month="0",
                opponent_team_id=0,
                pace_adjust="N",
                per_mode_detailed="PerGame",
                period="0",
                plus_minus="N",
                rank="N",
                season=season,
                season_type_all_star="Regular Season",
                date_to_nullable=date_to,
                team_id_nullable="",
            )
            df = endpoint.get_data_frames()[0]
            return df if not df.empty else pd.DataFrame()
        except Exception as e:
            if attempt < max_retries - 1:
                delay = base_delay * (2 ** attempt)  # exponential backoff: 1s, 2s, 4s
                print(f"  ⚠ Retry {attempt + 1}/{max_retries} for {season} @ {date_to} (waiting {delay}s)…")
                time.sleep(delay)
            else:
                print(f"  ⚠ Player leaderboard load failed for {season} @ {date_to} (all retries exhausted): {e}")
                return pd.DataFrame()


def _format_cutoff_date(game_date: pd.Timestamp) -> str:
    return (pd.Timestamp(game_date) - pd.Timedelta(days=1)).strftime("%m/%d/%Y")


def _team_player_top_features(players_df: pd.DataFrame, team_abbr: str, top_n: int = PLAYER_TOP_N) -> dict:
    out = {}
    team_map = _team_id_map()
    team_id = team_map.get(team_abbr)
    if team_id is None or players_df.empty or "TEAM_ID" not in players_df.columns:
        return out

    team_players = players_df[players_df["TEAM_ID"].astype(str) == str(team_id)].copy()
    if team_players.empty:
        return out

    sort_col = "PTS" if "PTS" in team_players.columns else team_players.columns[0]
    team_players = team_players.sort_values(sort_col, ascending=False).head(top_n)

    for slot, (_, player) in enumerate(team_players.iterrows(), start=1):
        for stat in PLAYER_STAT_COLS:
            value = player.get(stat, np.nan)
            out[f"top{slot}_{stat}_5"] = value

    return out


def add_player_form_features(df: pd.DataFrame, top_n: int = PLAYER_TOP_N) -> pd.DataFrame:
    """Add top-player last-5-game averages for each team on each game date.

    This uses league-wide player stats filtered by date and team so we can
    build the feature set without per-player scraping.
    """
    if df.empty:
        return df

    df = df.sort_values("GAME_DATE").copy()
    rows = []

    for (season, game_date), day_df in df.groupby(["Season", "GAME_DATE"], sort=True):
        date_to = _format_cutoff_date(game_date)
        players_df = _fetch_player_leaderboard(str(season), date_to)
        if players_df.empty:
            continue

        for idx, match in day_df.iterrows():
            row = {"match_idx": idx}
            home = match["HOME_TEAM"]
            away = match["AWAY_TEAM"]

            home_feats = _team_player_top_features(players_df, home, top_n=top_n)
            away_feats = _team_player_top_features(players_df, away, top_n=top_n)

            for slot in range(1, top_n + 1):
                for stat in PLAYER_STAT_COLS:
                    key = f"top{slot}_{stat}_5"
                    hval = home_feats.get(key, np.nan)
                    aval = away_feats.get(key, np.nan)
                    row[f"home_{key}"] = hval
                    row[f"away_{key}"] = aval
                    row[f"diff_{key}"] = hval - aval if pd.notna(hval) and pd.notna(aval) else np.nan

            rows.append(row)

    if not rows:
        return df

    feat_df = pd.DataFrame(rows).set_index("match_idx")
    return df.join(feat_df, how="left")


# ─────────────────────────────────────────────────────────────────────────────
# ROLLING TEAM STATISTICS
# ─────────────────────────────────────────────────────────────────────────────

STAT_COLS = [
    "PTS", "FG_PCT", "FG3_PCT", "FT_PCT",
    "OREB", "DREB", "REB", "AST", "STL",
    "BLK", "TOV", "PF", "POSS", "ORTG", "DRTG", "NET_RTG",
    "eFG_PCT", "TOV_PCT", "ORB_PCT", "FT_RATE", "TS_PCT",
]


def _compute_streak(wins: pd.Series) -> pd.Series:
    streak, current = [], 0
    for w in wins:
        if pd.isna(w):
            streak.append(0)
            continue
        current = max(1, current + 1) if w == 1 else min(-1, current - 1)
        streak.append(current)
    return pd.Series(streak, index=wins.index)


def build_rolling_stats(df: pd.DataFrame) -> dict:
    """
    Build per-team rolling stats. Returns dict keyed by team abbreviation.
    Each value is a DataFrame indexed by GAME_DATE with avg_ columns.
    """
    df = df.sort_values("GAME_DATE").copy()
    records = []

    for _, row in df.iterrows():
        for side, opp in [("HOME", "AWAY"), ("AWAY", "HOME")]:
            r = {
                "Date": row["GAME_DATE"],
                "Team": row[f"{side}_TEAM"],
                "IsHome": 1 if side == "HOME" else 0,
                "Win": row["HOME_WIN"] if side == "HOME" else 1 - row["HOME_WIN"],
                "PointDiff": (
                    row["HOME_PTS"] - row["AWAY_PTS"]
                    if side == "HOME"
                    else row["AWAY_PTS"] - row["HOME_PTS"]
                ),
            }
            for col in STAT_COLS:
                r[col] = row.get(f"{side}_{col}", np.nan)
                r[f"OPP_{col}"] = row.get(f"{opp}_{col}", np.nan)
            records.append(r)

    all_rec = pd.DataFrame(records).sort_values("Date")
    rolling_cols = STAT_COLS + [f"OPP_{c}" for c in STAT_COLS] + ["Win", "PointDiff"]

    team_stats = {}
    for team, td in all_rec.groupby("Team"):
        td = td.copy()
        for col in rolling_cols:
            td[f"avg_{col}"] = (
                td[col].shift(1)
                .rolling(window=ROLLING_WINDOW, min_periods=5)
                .mean()
            )
        td["Form"] = td["Win"].shift(1).rolling(ROLLING_WINDOW, min_periods=5).mean()
        td["Streak"] = _compute_streak(td["Win"].shift(1))
        team_stats[team] = td

    return team_stats


def build_match_features(df: pd.DataFrame, team_stats: dict) -> pd.DataFrame:
    """
    Join home and away rolling stats for each game.
    Only uses data available BEFORE the game.
    """
    stat_features = [f"avg_{c}" for c in STAT_COLS] + [f"avg_OPP_{c}" for c in STAT_COLS]
    stat_features += ["avg_Win", "avg_PointDiff", "Form", "Streak"]

    rows = []
    for idx, match in df.iterrows():
        home, away, date = match["HOME_TEAM"], match["AWAY_TEAM"], match["GAME_DATE"]

        home_rec = team_stats.get(home)
        away_rec = team_stats.get(away)
        if home_rec is None or away_rec is None:
            continue

        h = home_rec[(home_rec["Date"] == date) & (home_rec["IsHome"] == 1)]
        a = away_rec[(away_rec["Date"] == date) & (away_rec["IsHome"] == 0)]
        if h.empty or a.empty:
            continue

        row = {"match_idx": idx}
        for feat in stat_features:
            if feat not in h.columns or feat not in a.columns:
                continue
            hv = h[feat].values[0]
            av = a[feat].values[0]
            row[f"home_{feat}"] = hv
            row[f"away_{feat}"] = av
            row[f"diff_{feat}"] = hv - av

        rows.append(row)

    feat_df = pd.DataFrame(rows).set_index("match_idx")
    result = df.join(feat_df, how="inner")
    feat_cols = [c for c in feat_df.columns]
    return result.dropna(subset=feat_cols)


# ─────────────────────────────────────────────────────────────────────────────
# ELO RATINGS
# ─────────────────────────────────────────────────────────────────────────────

class NBAELO:
    def __init__(self, k: int = 20, home_advantage: int = 100):
        self.k = k
        self.home_advantage = home_advantage
        self.ratings: dict = {}

    def get(self, team: str) -> float:
        return self.ratings.setdefault(team, 1500.0)

    def expected(self, ra: float, rb: float) -> float:
        return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))

    def margin_multiplier(self, point_diff: int, elo_diff: float) -> float:
        mov = abs(point_diff)
        return ((mov + 3) ** 0.8) / (7.5 + 0.006 * abs(elo_diff))

    def update(self, home: str, away: str, home_pts: int, away_pts: int):
        rh = self.get(home) + self.home_advantage
        ra = self.get(away)
        e_home = self.expected(rh, ra)
        s_home = 1.0 if home_pts > away_pts else 0.0
        m = self.margin_multiplier(home_pts - away_pts, rh - ra)
        self.ratings[home] += self.k * m * (s_home - e_home)
        self.ratings[away] += self.k * m * ((1 - s_home) - (1 - e_home))

    def season_reset(self, factor: float = 0.75):
        mean = np.mean(list(self.ratings.values()))
        for t in self.ratings:
            self.ratings[t] = factor * self.ratings[t] + (1 - factor) * mean

    def compute_features(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.sort_values("GAME_DATE").copy()
        elo_rows = []
        current_season = None

        for _, row in df.iterrows():
            season = row.get("Season", "")
            if current_season and season != current_season:
                self.season_reset()
            current_season = season

            home, away = row["HOME_TEAM"], row["AWAY_TEAM"]
            rh, ra = self.get(home), self.get(away)
            e_home = self.expected(rh + self.home_advantage, ra)

            elo_rows.append({
                "elo_home": rh, "elo_away": ra,
                "elo_diff": rh - ra,
                "elo_prob_home": e_home,
                "elo_prob_away": 1 - e_home,
            })

            if pd.notna(row.get("HOME_PTS")) and pd.notna(row.get("AWAY_PTS")):
                self.update(home, away, int(row["HOME_PTS"]), int(row["AWAY_PTS"]))

        return pd.concat(
            [df.reset_index(drop=True), pd.DataFrame(elo_rows)], axis=1
        )


# ─────────────────────────────────────────────────────────────────────────────
# FATIGUE / BACK-TO-BACK
# ─────────────────────────────────────────────────────────────────────────────

def add_fatigue(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("GAME_DATE").copy()
    rest_home, rest_away = [], []
    last: dict = {}

    for _, row in df.iterrows():
        home, away, date = row["HOME_TEAM"], row["AWAY_TEAM"], row["GAME_DATE"]
        for team, lst in [(home, rest_home), (away, rest_away)]:
            delta = int((date - last[team]).days) if team in last else 3
            lst.append(min(delta, 14))
        last[home] = date
        last[away] = date

    df["home_rest_days"] = rest_home
    df["away_rest_days"] = rest_away
    df["rest_advantage"] = df["home_rest_days"] - df["away_rest_days"]
    df["home_b2b"] = (df["home_rest_days"] == 1).astype(int)
    df["away_b2b"] = (df["away_rest_days"] == 1).astype(int)
    df["home_fatigued"] = (df["home_rest_days"] <= 1).astype(int)
    df["away_fatigued"] = (df["away_rest_days"] <= 1).astype(int)
    df["b2b_advantage_home"] = df["away_b2b"] - df["home_b2b"]
    return df


# ─────────────────────────────────────────────────────────────────────────────
# HEAD-TO-HEAD
# ─────────────────────────────────────────────────────────────────────────────

def add_h2h(df: pd.DataFrame, n_last: int = 5) -> pd.DataFrame:
    df = df.sort_values("GAME_DATE").copy()
    h2h_rows = []

    for idx, row in df.iterrows():
        home, away, date = row["HOME_TEAM"], row["AWAY_TEAM"], row["GAME_DATE"]
        prev = df[
            (df["GAME_DATE"] < date)
            & (
                ((df["HOME_TEAM"] == home) & (df["AWAY_TEAM"] == away))
                | ((df["HOME_TEAM"] == away) & (df["AWAY_TEAM"] == home))
            )
        ].tail(n_last)

        if len(prev) < 2:
            h2h_rows.append({"h2h_home_wins": np.nan, "h2h_avg_diff": np.nan, "h2h_avg_total": np.nan})
            continue

        wins, diff, total = 0, 0, 0
        for _, p in prev.iterrows():
            total += p["HOME_PTS"] + p["AWAY_PTS"]
            if p["HOME_TEAM"] == home:
                wins += int(p["HOME_WIN"] == 1)
                diff += p["HOME_PTS"] - p["AWAY_PTS"]
            else:
                wins += int(p["HOME_WIN"] == 0)
                diff += p["AWAY_PTS"] - p["HOME_PTS"]
        n = len(prev)
        h2h_rows.append({"h2h_home_wins": wins / n, "h2h_avg_diff": diff / n, "h2h_avg_total": total / n})

    return pd.concat([df, pd.DataFrame(h2h_rows, index=df.index)], axis=1)


# ─────────────────────────────────────────────────────────────────────────────
# FULL PIPELINE
# ─────────────────────────────────────────────────────────────────────────────

def build_full_features(df: pd.DataFrame, include_player_features: bool = False) -> pd.DataFrame:
    print("  Building rolling stats…")
    team_stats = build_rolling_stats(df)

    print("  Building match features…")
    df = build_match_features(df, team_stats)

    print("  Adding ELO…")
    elo = NBAELO(k=20, home_advantage=100)
    df = elo.compute_features(df)

    print("  Adding fatigue…")
    df = add_fatigue(df)

    print("  Adding H2H…")
    df = add_h2h(df)

    if include_player_features:
        print("  Adding player form features…")
        df = add_player_form_features(df)

    print(f"  Features ready: {len(df)} games, {len(df.columns)} columns")
    return df, elo
