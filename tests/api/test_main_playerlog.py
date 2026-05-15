from fastapi.testclient import TestClient


def test_playerlog_endpoint(monkeypatch):
    # Mock the adapter to avoid network calls
    sample_rows = [{"GAME_ID": 1, "PTS": 20}, {"GAME_ID": 2, "PTS": 25}]

    def fake_fetch(pid, season=None):
        assert int(pid) == 2544
        return sample_rows

    monkeypatch.setattr('apps.api.main.fetch_player_game_log', fake_fetch)

    from apps.api.main import app
    client = TestClient(app)
    r = client.get('/api/playerlog?player_id=2544&season=2024-25')
    assert r.status_code == 200
    j = r.json()
    assert j['player_id'] == 2544
    assert isinstance(j['games'], list)
    assert j['games'][0]['GAME_ID'] == 1
