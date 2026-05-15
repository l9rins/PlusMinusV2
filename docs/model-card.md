# Model Card

## Purpose

Plus-Minus predicts NBA game win probability for a home/away matchup and pairs the probability with readable matchup analysis.

## Model

The production model is a soft-voting ensemble:

- Logistic Regression
- Random Forest
- XGBoost

The model consumes engineered rolling team form, ELO, rest/fatigue, and head-to-head features.

## Inputs

- Rolling 10-game team averages.
- Offensive and defensive efficiency metrics.
- ELO rating and ELO-implied probability.
- Rest days, back-to-back flags, and fatigue indicators.
- Head-to-head recent performance defaults.
- Injury adjustment is applied after the base probability.

## Output

```json
{
  "home_win": 0.6123,
  "away_win": 0.3877,
  "source": "ml_ensemble_injury_adjusted"
}
```

## Evaluation Plan

Training writes `apps/api/model_metrics.json` with the current time-series validation summary:

- Accuracy
- Log loss
- Brier score
- Class balance
- Per-fold test game counts

The split uses a time-series backtest, never random shuffle.

## Known Limits

- Predictions are not betting advice.
- Injuries and market odds can change faster than the training data.
- NBA schedule timing must be interpreted in `America/New_York`.
- If rolling stats are unavailable for a team, the backend falls back to ELO.

## Next Metric Target

Before calling the model production-grade, add a calibration table and sample prediction audit under `docs/evaluation/`.
