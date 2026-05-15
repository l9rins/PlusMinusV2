import pandas as pd

from apps.api.model import get_feature_cols


def test_get_feature_cols_keeps_engineered_features_only():
    df = pd.DataFrame(
        columns=[
            "home_avg_PTS",
            "away_avg_PTS",
            "diff_avg_PTS",
            "elo_home",
            "h2h_home_wins",
            "rest_advantage",
            "b2b_advantage_home",
            "HOME_WIN",
            "HOME_TEAM",
            "AWAY_TEAM",
            "random_noise",
        ]
    )

    cols = get_feature_cols(df)

    assert "home_avg_PTS" in cols
    assert "away_avg_PTS" in cols
    assert "diff_avg_PTS" in cols
    assert "elo_home" in cols
    assert "HOME_WIN" not in cols
    assert "HOME_TEAM" not in cols
    assert "random_noise" not in cols

