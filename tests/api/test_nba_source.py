import importlib

import pytest


def make_mock_resp(json_obj):
    class MockResp:
        def __init__(self, j):
            self._j = j
            self.status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return self._j

    return MockResp(json_obj)


def test_fetch_player_game_log_http_fallback(monkeypatch):
    # Import module and force HTTP fallback path
    import apps.api.nba_source as nba_source
    nba_source._HAS_NBA_API = False

    sample = {
        'resultSets': [
            {
                'headers': ['GAME_ID', 'PTS'],
                'rowSet': [[1111, 30], [2222, 25]],
            }
        ]
    }

    calls = {'n': 0}

    def fake_get(url, headers=None, timeout=None):
        calls['n'] += 1
        return make_mock_resp(sample)

    monkeypatch.setattr('requests.get', fake_get)

    rows = nba_source.fetch_player_game_log(2544, '2024-25')
    assert isinstance(rows, list)
    assert len(rows) == 2
    assert rows[0]['GAME_ID'] == 1111

    # Cached: second call should not call requests.get again
    rows2 = nba_source.fetch_player_game_log(2544, '2024-25')
    assert calls['n'] == 1


def test_clear_cache(monkeypatch):
    import apps.api.nba_source as nba_source
    nba_source._CACHE.clear()
    sample = {'resultSets': [{'headers': ['GAME_ID'], 'rowSet': [[1]]}]}

    def fake_get(url, headers=None, timeout=None):
        return make_mock_resp(sample)

    monkeypatch.setattr('requests.get', fake_get)
    rows = nba_source.fetch_player_game_log(1)
    assert rows
    nba_source.clear_cache()
    assert nba_source._cached('playerlog:1:auto') is None
