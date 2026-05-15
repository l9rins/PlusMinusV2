# model.py — XGBoost ensemble + prediction helpers

import joblib
import json
import numpy as np
import pandas as pd
from pathlib import Path
import os
from sklearn.ensemble import RandomForestClassifier, VotingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

try:
    from apps.api.nba_source import fetch_team_top_players
    from apps.api.features import PLAYER_STAT_COLS, PLAYER_TOP_N
except ImportError:
    from nba_source import fetch_team_top_players
    from features import PLAYER_STAT_COLS, PLAYER_TOP_N

MODEL_PATH = Path(__file__).parent / "model.joblib"
SCALER_PATH = Path(__file__).parent / "scaler.joblib"
FEATURE_NAMES_PATH = Path(__file__).parent / "feature_names.joblib"
METRICS_PATH = Path(__file__).parent / "model_metrics.json"
METRICS_BASELINE_PATH = Path(__file__).parent / "model_metrics_baseline.json"

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE SELECTION
# ─────────────────────────────────────────────────────────────────────────────

def get_feature_cols(df: pd.DataFrame) -> list:
    return [
        c for c in df.columns
        if c.startswith(("home_", "away_", "diff_", "elo_", "h2h_", "rest_", "b2b_"))
        and "TEAM" not in c
        and c not in ["HOME_WIN"]
    ]


# ─────────────────────────────────────────────────────────────────────────────
# TRAINING
# ─────────────────────────────────────────────────────────────────────────────

def train(df: pd.DataFrame, save_artifacts: bool = True, metrics_path: Path | None = METRICS_PATH) -> tuple:
    feature_cols = get_feature_cols(df)
    X = df[feature_cols].fillna(df[feature_cols].median())
    y = df["HOME_WIN"]

    print(f"  Training on {len(X)} games, {len(feature_cols)} features")
    print(f"  Class balance: home win={y.mean():.1%}, away win={1-y.mean():.1%}")

    scaler = StandardScaler()

    # Support a quick training mode controlled by TRAIN_QUICK env var for fast iterations
    quick = bool(int(os.getenv("TRAIN_QUICK", "0")))
    if quick:
        ensemble = VotingClassifier(
            estimators=[
                ("lr", LogisticRegression(max_iter=500, C=1.0, random_state=42)),
                ("rf", RandomForestClassifier(
                    n_estimators=50, max_depth=6,
                    min_samples_leaf=8, random_state=42
                )),
                ("xgb", XGBClassifier(
                    n_estimators=50, max_depth=4, learning_rate=0.1,
                    subsample=0.9, colsample_bytree=0.9,
                    random_state=42, eval_metric="logloss",
                    verbosity=0,
                )),
            ],
            voting="soft",
            weights=[1, 1, 2],
        )
    else:
        ensemble = VotingClassifier(
            estimators=[
                ("lr", LogisticRegression(max_iter=1000, C=0.5, random_state=42)),
                ("rf", RandomForestClassifier(
                    n_estimators=200, max_depth=8,
                    min_samples_leaf=10, random_state=42
                )),
                ("xgb", XGBClassifier(
                    n_estimators=300, max_depth=5, learning_rate=0.05,
                    subsample=0.8, colsample_bytree=0.8,
                    random_state=42, eval_metric="logloss",
                    verbosity=0,
                )),
            ],
            voting="soft",
            weights=[1, 1, 2],
        )

    # Cross-validate first (report only, don't use for production model)
    tscv = TimeSeriesSplit(n_splits=5)
    cv_metrics = []
    for train_idx, test_idx in tscv.split(X):
        Xtr = scaler.fit_transform(X.iloc[train_idx])
        Xte = scaler.transform(X.iloc[test_idx])
        ensemble.fit(Xtr, y.iloc[train_idx])
        pred = ensemble.predict(Xte)
        proba = ensemble.predict_proba(Xte)[:, 1]
        cv_metrics.append({
            "accuracy": float(accuracy_score(y.iloc[test_idx], pred)),
            "log_loss": float(log_loss(y.iloc[test_idx], proba, labels=[0, 1])),
            "brier": float(brier_score_loss(y.iloc[test_idx], proba)),
            "test_games": int(len(test_idx)),
        })

    cv_accs = [m["accuracy"] for m in cv_metrics]
    print(f"  CV Accuracy: {np.mean(cv_accs):.4f} +/- {np.std(cv_accs):.4f}")

    # Final fit on all data
    X_scaled = scaler.fit_transform(X)
    ensemble.fit(X_scaled, y)

    metrics = {
        "training_games": int(len(X)),
        "feature_count": int(len(feature_cols)),
        "class_balance": {
            "home_win": float(y.mean()),
            "away_win": float(1 - y.mean()),
        },
        "cross_validation": {
            "folds": cv_metrics,
            "accuracy_mean": float(np.mean(cv_accs)),
            "accuracy_std": float(np.std(cv_accs)),
            "log_loss_mean": float(np.mean([m["log_loss"] for m in cv_metrics])),
            "brier_mean": float(np.mean([m["brier"] for m in cv_metrics])),
        },
    }

    # Persist
    if save_artifacts:
        joblib.dump(ensemble, MODEL_PATH)
        joblib.dump(scaler, SCALER_PATH)
        joblib.dump(feature_cols, FEATURE_NAMES_PATH)
    if metrics_path is not None:
        metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    if save_artifacts:
        print(f"  Model saved -> {MODEL_PATH}")
    if metrics_path is not None:
        print(f"  Metrics saved -> {metrics_path}")
    return ensemble, scaler, feature_cols, metrics


# ─────────────────────────────────────────────────────────────────────────────
# LOADING
# ─────────────────────────────────────────────────────────────────────────────

def load_model():
    if not MODEL_PATH.exists():
        raise FileNotFoundError("Model not trained yet. Run: python train.py")
    model = joblib.load(MODEL_PATH)
    scaler = joblib.load(SCALER_PATH)
    feature_cols = joblib.load(FEATURE_NAMES_PATH)
    return model, scaler, feature_cols


# ─────────────────────────────────────────────────────────────────────────────
# PREDICTION HELPER
# ─────────────────────────────────────────────────────────────────────────────

def predict_proba(
    model,
    scaler,
    feature_cols: list,
    team_stats: dict,
    elo_system,
    home_team: str,
    away_team: str,
) -> dict:
    """
    Build a feature row for a future matchup and return win probabilities.
    Uses the most recent rolling stats for each team.
    """
    home_stats = _get_latest_team_stats(team_stats, home_team, is_home=True)
    away_stats = _get_latest_team_stats(team_stats, away_team, is_home=False)

    if home_stats is None or away_stats is None:
        # Fallback to ELO only
        rh = elo_system.get(home_team) + elo_system.home_advantage
        ra = elo_system.get(away_team)
        p_home = elo_system.expected(rh, ra)
        return {"home_win": round(p_home, 4), "away_win": round(1 - p_home, 4), "source": "elo_fallback"}

    row = {}
    all_feat_cols = [f"avg_{c}" for c in __import__("features").STAT_COLS]
    all_feat_cols += [f"avg_OPP_{c}" for c in __import__("features").STAT_COLS]
    all_feat_cols += ["avg_Win", "avg_PointDiff", "Form", "Streak"]

    for feat in all_feat_cols:
        if feat not in home_stats or feat not in away_stats:
            continue
        hv = home_stats[feat]
        av = away_stats[feat]
        row[f"home_{feat}"] = hv
        row[f"away_{feat}"] = av
        row[f"diff_{feat}"] = hv - av

    # ELO features
    rh = elo_system.get(home_team)
    ra = elo_system.get(away_team)
    e_home = elo_system.expected(rh + elo_system.home_advantage, ra)
    row["elo_home"] = rh
    row["elo_away"] = ra
    row["elo_diff"] = rh - ra
    row["elo_prob_home"] = e_home
    row["elo_prob_away"] = 1 - e_home

    # Fatigue defaults (unknown for future game)
    row["home_rest_days"] = 2
    row["away_rest_days"] = 2
    row["rest_advantage"] = 0
    row["home_b2b"] = 0
    row["away_b2b"] = 0
    row["home_fatigued"] = 0
    row["away_fatigued"] = 0
    row["b2b_advantage_home"] = 0

    # H2H defaults
    row["h2h_home_wins"] = 0.5
    row["h2h_avg_diff"] = 0.0
    row["h2h_avg_total"] = 215.0

    def _apply_top_players(team: str, prefix: str):
        top_players = fetch_team_top_players(team, n=PLAYER_TOP_N)
        for slot in range(1, PLAYER_TOP_N + 1):
            if slot <= len(top_players):
                player = top_players[slot - 1]
                values = {
                    "PTS": float(player.get("pts", np.nan)),
                    "REB": float(player.get("reb", np.nan)),
                    "AST": float(player.get("ast", np.nan)),
                }
            else:
                values = {stat: np.nan for stat in PLAYER_STAT_COLS}
            for stat in PLAYER_STAT_COLS:
                key = f"{prefix}_top{slot}_{stat}_5"
                row[key] = values[stat]

    _apply_top_players(home_team, "home")
    _apply_top_players(away_team, "away")

    for slot in range(1, PLAYER_TOP_N + 1):
        for stat in PLAYER_STAT_COLS:
            hkey = f"home_top{slot}_{stat}_5"
            akey = f"away_top{slot}_{stat}_5"
            dkey = f"diff_top{slot}_{stat}_5"
            hv = row.get(hkey, np.nan)
            av = row.get(akey, np.nan)
            row[dkey] = hv - av if pd.notna(hv) and pd.notna(av) else np.nan

    feat_row = pd.DataFrame([row])
    # Align columns to training feature set
    for col in feature_cols:
        if col not in feat_row.columns:
            feat_row[col] = 0.0
    feat_row = feat_row[feature_cols].fillna(0.0)

    X_scaled = scaler.transform(feat_row)
    proba = model.predict_proba(X_scaled)[0]

    return {
        "home_win": round(float(proba[1]), 4),
        "away_win": round(float(proba[0]), 4),
        "source": "ml_ensemble",
    }


def _get_latest_team_stats(team_stats: dict, team: str, is_home: bool) -> dict | None:
    if not team_stats:
        return None
    td = team_stats.get(team)
    if td is None:
        return None
    is_home_val = 1 if is_home else 0
    subset = td[td["IsHome"] == is_home_val]
    if subset.empty:
        subset = td  # fallback: any role
    latest = subset.sort_values("Date").iloc[-1]
    return latest.to_dict()
