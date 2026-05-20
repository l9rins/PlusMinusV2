import json
from fastapi.testclient import TestClient

from apps.api import main as api_main


client = TestClient(api_main.app)


def test_shot_zones_endpoint():
    resp = client.get('/api/shot_zones?team=DET')
    assert resp.status_code == 200
    body = resp.json()
    assert 'team' in body and body['team'] == 'DET'
    assert 'zones' in body and isinstance(body['zones'], dict)


def test_lineups_endpoint():
    resp = client.get('/api/lineups?team=DET&top_n=4')
    assert resp.status_code == 200
    body = resp.json()
    assert 'team' in body and body['team'] == 'DET'
    assert 'combos' in body and isinstance(body['combos'], list)


def test_play_types_endpoint():
    resp = client.get('/api/play_types?team=DET')
    assert resp.status_code == 200
    body = resp.json()
    assert 'team' in body and body['team'] == 'DET'
    assert 'play_types' in body and isinstance(body['play_types'], list)


def test_missing_team_parameter():
    resp = client.get('/api/shot_zones')
    assert resp.status_code == 422


def test_lineups_invalid_top_n():
    resp = client.get('/api/lineups?team=DET&top_n=1')
    assert resp.status_code == 422


def test_team_stats_endpoint():
    resp = client.get('/api/team_stats?team=DET')
    assert resp.status_code == 200
    body = resp.json()
    assert body['team'] == 'DET'
    assert 'ortg' in body
    assert 'drtg' in body
    assert 'net_rating' in body
    assert 'pace' in body
    assert isinstance(body['percentiles'], dict)
    assert isinstance(body['four_factors'], dict)


def test_team_stats_nonexistent_team():
    resp = client.get('/api/team_stats?team=XYZ')
    assert resp.status_code == 404


def test_team_stats_normalization():
    resp = client.get('/api/team_stats?team=SA')
    assert resp.status_code == 200
    body = resp.json()
    assert body['team'] == 'SAS'

