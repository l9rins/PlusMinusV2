from datetime import datetime

import pandas as pd

from apps.api.features import NBAELO, add_fatigue, add_player_form_features


def test_elo_expected_is_symmetric():
    elo = NBAELO()
    p_home = elo.expected(1600, 1500)
    p_away = elo.expected(1500, 1600)

    assert round(p_home + p_away, 10) == 1
    assert p_home > 0.5


def test_elo_update_rewards_winner():
    elo = NBAELO(k=20, home_advantage=100)

    before_home = elo.get("BOS")
    before_away = elo.get("MIA")
    elo.update("BOS", "MIA", 112, 100)

    assert elo.get("BOS") > before_home
    assert elo.get("MIA") < before_away


def test_add_fatigue_marks_back_to_back():
    df = pd.DataFrame(
        [
            {
                "GAME_DATE": datetime(2026, 1, 1),
                "HOME_TEAM": "BOS",
                "AWAY_TEAM": "MIA",
            },
            {
                "GAME_DATE": datetime(2026, 1, 2),
                "HOME_TEAM": "BOS",
                "AWAY_TEAM": "NYK",
            },
        ]
    )

    out = add_fatigue(df)

    assert out.loc[0, "home_rest_days"] == 3
    assert out.loc[1, "home_rest_days"] == 1
    assert out.loc[1, "home_b2b"] == 1


def test_add_player_form_features_adds_top_player_columns(monkeypatch):
    df = pd.DataFrame(
        [
            {
                "GAME_DATE": datetime(2026, 1, 5),
                "HOME_TEAM": "BOS",
                "AWAY_TEAM": "MIA",
                "Season": "2025-26",
            }
        ]
    )

    fake_leaderboard = pd.DataFrame(
        [
            {"TEAM_ID": 1610612738, "PLAYER_NAME": "Player A", "PTS": 30.0, "REB": 8.0, "AST": 5.0},
            {"TEAM_ID": 1610612738, "PLAYER_NAME": "Player B", "PTS": 24.0, "REB": 7.0, "AST": 4.0},
            {"TEAM_ID": 1610612738, "PLAYER_NAME": "Player C", "PTS": 18.0, "REB": 6.0, "AST": 3.0},
            {"TEAM_ID": 1610612748, "PLAYER_NAME": "Player D", "PTS": 29.0, "REB": 9.0, "AST": 6.0},
            {"TEAM_ID": 1610612748, "PLAYER_NAME": "Player E", "PTS": 22.0, "REB": 5.0, "AST": 5.0},
            {"TEAM_ID": 1610612748, "PLAYER_NAME": "Player F", "PTS": 17.0, "REB": 4.0, "AST": 4.0},
        ]
    )

    monkeypatch.setattr("apps.api.features._fetch_player_leaderboard", lambda season, date_to: fake_leaderboard)

    out = add_player_form_features(df)

    assert out.loc[0, "home_top1_PTS_5"] == 30.0
    assert out.loc[0, "home_top2_REB_5"] == 7.0
    assert out.loc[0, "away_top1_AST_5"] == 6.0
    assert out.loc[0, "diff_top1_PTS_5"] == 1.0

