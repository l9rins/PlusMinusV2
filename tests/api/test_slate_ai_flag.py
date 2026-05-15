from fastapi.testclient import TestClient

import json


class MockResp:
    def __init__(self, j):
        self._j = j
        self.status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return self._j


def make_mock_scoreboard_event(home='BOS', away='MIA'):
    return {
        'events': [
            {
                'competitions': [
                    {
                        'competitors': [
                            {'homeAway': 'home', 'team': {'abbreviation': home}},
                            {'homeAway': 'away', 'team': {'abbreviation': away}},
                        ]
                    }
                ]
            }
        ]
    }


def test_slate_include_ai_gate(monkeypatch):
    # Prevent model readiness failure
    import apps.api.main as mainmod
    monkeypatch.setattr(mainmod, '_require_model', lambda: None)

    # Mock upstream ESPN scoreboard with one game
    monkeypatch.setattr('requests.get', lambda *a, **k: MockResp(make_mock_scoreboard_event()))

    # Stub predict_proba to return deterministic ML probs
    import apps.api.model as modelmod

    def fake_predict(*args, **kwargs):
        return {"home_win": 0.6, "away_win": 0.4, "source": "ml_ensemble"}

    monkeypatch.setattr(modelmod, 'predict_proba', fake_predict)

    # Track whether Groq functions are invoked
    import apps.api.groq_analysis as groqmod

    called = {'slate': False, 'matchup': 0}

    def fake_analyze_slate(predictions):
        called['slate'] = True
        return {'summary': 'ok'}

    def fake_analyze_matchup(home, away, ml_probs, home_form, away_form):
        called['matchup'] += 1
        return {'note': f'{home} vs {away}'}

    monkeypatch.setattr(groqmod, 'analyze_slate', fake_analyze_slate)
    monkeypatch.setattr(groqmod, 'analyze_matchup', fake_analyze_matchup)

    from apps.api.main import app
    client = TestClient(app)

    # 1) Default (no AI) — should NOT call Groq
    r = client.get('/api/slate')
    assert r.status_code == 200
    j = r.json()
    assert j.get('game_count', 0) >= 0
    assert j.get('slate_analysis') is None
    assert called['slate'] is False
    assert called['matchup'] == 0

    # 2) With include_ai=true — should call Groq functions
    r2 = client.get('/api/slate?include_ai=true')
    assert r2.status_code == 200
    j2 = r2.json()
    assert j2.get('slate_analysis') is not None
    assert called['slate'] is True
    assert called['matchup'] >= 1
