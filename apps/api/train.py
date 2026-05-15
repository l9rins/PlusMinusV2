#!/usr/bin/env python3
# train.py — Run this ONCE to download data and train the model
# Usage: python train.py

import sys
import os
import warnings
warnings.filterwarnings("ignore")
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from data_loader import load_seasons, clean
from features import build_full_features
from model import train

SEASONS = [
    s.strip()
    for s in os.getenv("TRAIN_SEASONS", "2024-25,2023-24,2022-23,2021-22,2020-21").split(",")
    if s.strip()
]

def main():
    print("=" * 60)
    print("  Plus-Minus NBA — Model Training")
    print("=" * 60)
    print(f"  Seasons: {', '.join(SEASONS)}")

    print("\n[1/4] Loading NBA game data…")
    print("  (This hits nba_api with delays — takes ~2-3 min)")
    raw = load_seasons(SEASONS)
    if raw.empty:
        print("  ERROR: No data loaded. Check your internet connection.")
        sys.exit(1)
    print(f"  Loaded {len(raw)} total games across {len(SEASONS)} seasons")

    print("\n[2/4] Cleaning data…")
    clean_data = clean(raw)
    print(f"  Clean: {len(clean_data)} games")
    home_win_pct = clean_data["HOME_WIN"].mean()
    print(f"  Home win rate: {home_win_pct:.1%}")

    print("\n[3/4] Engineering features…")
    baseline_featured, elo_system = build_full_features(clean_data, include_player_features=False)
    enhanced_featured, _ = build_full_features(clean_data, include_player_features=True)

    print("\n[4/4] Training baseline model…")
    _, _, _, baseline_metrics = train(
        baseline_featured,
        save_artifacts=False,
        metrics_path=Path(__file__).parent / "model_metrics_baseline.json",
    )

    print("\n[4/4] Training enhanced model with player features…")
    model, scaler, feature_cols, enhanced_metrics = train(
        enhanced_featured,
        save_artifacts=True,
        metrics_path=Path(__file__).parent / "model_metrics.json",
    )

    print("\n" + "=" * 60)
    print("  ✓ Training complete!")
    print("  Files saved: model.joblib, scaler.joblib, feature_names.joblib")
    print("\n  Baseline vs Enhanced cross-validation accuracy:")
    print(f"    baseline: {baseline_metrics['cross_validation']['accuracy_mean']:.4f} +/- {baseline_metrics['cross_validation']['accuracy_std']:.4f}")
    print(f"    enhanced: {enhanced_metrics['cross_validation']['accuracy_mean']:.4f} +/- {enhanced_metrics['cross_validation']['accuracy_std']:.4f}")
    print(f"    delta:     {enhanced_metrics['cross_validation']['accuracy_mean'] - baseline_metrics['cross_validation']['accuracy_mean']:+.4f}")
    print("\n  Top 5 teams by ELO:")
    top5 = sorted(elo_system.ratings.items(), key=lambda x: -x[1])[:5]
    for team, rating in top5:
        print(f"    {team:5s}  {rating:.0f}")
    print("\n  Now run: uvicorn main:app --reload --port 8000")
    print("=" * 60)


if __name__ == "__main__":
    main()
