# data_loader.py — NBA game data loading and cleaning
# Pulls from nba_api (free, no auth required)

import time
import numpy as np
import pandas as pd
from nba_api.stats.endpoints import LeagueGameFinder
from nba_api.stats.static import teams

REQUEST_DELAY = 0.7  # seconds between nba_api calls (avoid 429s)


def get_team_map() -> dict:
    return {t["id"]: t["abbreviation"] for t in teams.get_teams()}


def load_season(season: str) -> pd.DataFrame:
    """
    Load all regular season games for one season.
    nba_api returns one row per team per game — we merge into one row per game.
    """
    try:
        finder = LeagueGameFinder(
            season_nullable=season,
            league_id_nullable="00",
            season_type_nullable="Regular Season",
        )
        time.sleep(REQUEST_DELAY)
        df = finder.get_data_frames()[0]
        if df.empty:
            return pd.DataFrame()

        df["IS_HOME"] = df["MATCHUP"].str.contains("vs.").astype(int)
        home = df[df["IS_HOME"] == 1].copy()
        away = df[df["IS_HOME"] == 0].copy()

        stat_cols = [
            "TEAM_ID", "TEAM_ABBREVIATION", "PTS",
            "FGM", "FGA", "FG_PCT",
            "FG3M", "FG3A", "FG3_PCT",
            "FTM", "FTA", "FT_PCT",
            "OREB", "DREB", "REB",
            "AST", "STL", "BLK", "TOV", "PF",
            "PLUS_MINUS",
        ]

        home_rename = {c: f"HOME_{c}" for c in stat_cols}
        home_rename["TEAM_ABBREVIATION"] = "HOME_TEAM"
        away_rename = {c: f"AWAY_{c}" for c in stat_cols}
        away_rename["TEAM_ABBREVIATION"] = "AWAY_TEAM"

        home = home.rename(columns=home_rename)
        away = away.rename(columns=away_rename)

        away_cols = {c: f"AWAY_{c}" for c in stat_cols}
        away_cols["TEAM_ABBREVIATION"] = "AWAY_TEAM"
        away_df = df[df["IS_HOME"] == 0].rename(columns=away_cols)
        away_select = [v for v in away_cols.values()] + ["GAME_ID"]

        merged = home.merge(
            away_df[[c for c in away_select if c in away_df.columns]],
            on="GAME_ID",
            how="inner",
        )

        merged["HOME_WIN"] = (merged["HOME_PTS"] > merged["AWAY_PTS"]).astype(int)
        merged["GAME_DATE"] = pd.to_datetime(merged["GAME_DATE"])
        merged["Season"] = season
        return merged

    except Exception as e:
        print(f"  ⚠ Season {season} load failed: {e}")
        return pd.DataFrame()


def load_seasons(seasons: list) -> pd.DataFrame:
    frames = []
    for s in seasons:
        df = load_season(s)
        if not df.empty:
            frames.append(df)
            print(f"  ✓ {s}: {len(df)} games loaded")
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"], errors="coerce")
    df = df.dropna(subset=["GAME_DATE"])
    df = df.sort_values("GAME_DATE").reset_index(drop=True)

    numeric_cols = [
        c for c in df.columns
        if c.startswith(("HOME_", "AWAY_"))
        and c not in ["HOME_TEAM", "AWAY_TEAM", "HOME_TEAM_ID", "AWAY_TEAM_ID"]
    ]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["HOME_PTS", "AWAY_PTS"])

    # Possession estimate (Oliver formula)
    for prefix in ["HOME", "AWAY"]:
        df[f"{prefix}_POSS"] = (
            df[f"{prefix}_FGA"]
            + 0.44 * df[f"{prefix}_FTA"]
            - df[f"{prefix}_OREB"]
            + df[f"{prefix}_TOV"]
        )

    df["PACE"] = (df["HOME_POSS"] + df["AWAY_POSS"]) / 2

    # Offensive / Defensive / Net Rating (per 100 possessions)
    for prefix, opp in [("HOME", "AWAY"), ("AWAY", "HOME")]:
        poss = df[f"{prefix}_POSS"].replace(0, np.nan)
        df[f"{prefix}_ORTG"] = df[f"{prefix}_PTS"] / poss * 100
        df[f"{prefix}_DRTG"] = df[f"{opp}_PTS"] / poss * 100
        df[f"{prefix}_NET_RTG"] = df[f"{prefix}_ORTG"] - df[f"{prefix}_DRTG"]

    # Four Factors (Dean Oliver)
    for prefix, opp in [("HOME", "AWAY"), ("AWAY", "HOME")]:
        fga = df[f"{prefix}_FGA"].replace(0, np.nan)
        df[f"{prefix}_eFG_PCT"] = (df[f"{prefix}_FGM"] + 0.5 * df[f"{prefix}_FG3M"]) / fga
        df[f"{prefix}_TOV_PCT"] = df[f"{prefix}_TOV"] / (
            df[f"{prefix}_FGA"] + 0.44 * df[f"{prefix}_FTA"] + df[f"{prefix}_TOV"]
        ).replace(0, np.nan)
        df[f"{prefix}_ORB_PCT"] = df[f"{prefix}_OREB"] / (
            df[f"{prefix}_OREB"] + df[f"{opp}_DREB"]
        ).replace(0, np.nan)
        df[f"{prefix}_FT_RATE"] = df[f"{prefix}_FTM"] / fga
        df[f"{prefix}_TS_PCT"] = df[f"{prefix}_PTS"] / (
            2 * (df[f"{prefix}_FGA"] + 0.44 * df[f"{prefix}_FTA"])
        ).replace(0, np.nan)

    return df
