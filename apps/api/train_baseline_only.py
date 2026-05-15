#!/usr/bin/env python
"""Retrain baseline model only and save artifacts."""

from data_loader import load_seasons, clean
from features import build_full_features
from model import train

seasons = load_seasons(['2024-25'])
df_clean = clean(seasons)
df_features, _ = build_full_features(df_clean, include_player_features=False)

print("[*] Training baseline model...")
model, scaler, feature_cols, metrics = train(df_features, save_artifacts=True, metrics_path=None)
print(f"✓ Baseline model trained and saved")
print(f"  CV Accuracy: {metrics['cross_validation']['accuracy_mean']:.4f} +/- {metrics['cross_validation']['accuracy_std']:.4f}")
