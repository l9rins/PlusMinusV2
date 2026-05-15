# API

FastAPI service for model-backed NBA predictions.

## Responsibilities

- Load trained model artifacts: `model.joblib`, `scaler.joblib`, `feature_names.joblib`.
- Build team form, ELO, injury, and market context.
- Serve prediction, slate, standings, chat, and health endpoints.
- Keep backend secrets in `.env`.

## Local Run

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

