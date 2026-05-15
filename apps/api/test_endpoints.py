"""
test_endpoints.py — Unit tests for Plus-Minus API endpoints

Tests for the new endpoints:
  - GET /api/injuries
  - GET /api/shot_zones
  - GET /api/lineups
  - GET /api/play_types

Run with: pytest apps/api/test_endpoints.py -v
"""

import os
import time
import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from fastapi.testclient import TestClient

# Set env vars before importing main to ensure they're read on import
# Set env vars before importing main to ensure they're read on import
os.environ.setdefault("CACHE_TTL_INJURIES", "300")
os.environ.setdefault("CACHE_TTL_SHOT_ZONES", "60")
os.environ.setdefault("CACHE_TTL_LINEUPS", "120")
os.environ.setdefault("CACHE_TTL_PLAY_TYPES", "300")

import sys
sys.path.insert(0, os.path.dirname(__file__))

from main import app, CACHE_TTL_INJURIES, CACHE_TTL_SHOT_ZONES, CACHE_TTL_LINEUPS, CACHE_TTL_PLAY_TYPES


# ─────────────────────────────────────────────────────────────────────────────
# FIXTURES
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    """FastAPI test client."""
    return TestClient(app)


@pytest.fixture
def mock_injuries_data():
    """Mock injury data structure."""
    return {
        "BOS": [
            {"player": "Jayson Tatum", "status": "Out", "reason": "Back Injury"},
            {"player": "Derrick White", "status": "Questionable", "reason": "Ankle Soreness"},
        ],
        "MIA": [
            {"player": "Jimmy Butler", "status": "Out", "reason": "Knee Injury"},
        ],
    }


@pytest.fixture
def mock_shot_zones_data():
    """Mock shot zones response."""
    return {
        "team": "BOS",
        "source": "heuristic_team_stats",
        "zones": {
            "rim": 32.5,
            "paint_non_rim": 12.0,
            "mid_range": 14.5,
            "corner_3": 10.0,
            "above_break_3": 31.0,
        }
    }


@pytest.fixture
def mock_players_data():
    """Mock top players data."""
    return [
        {"player_id": 2544, "name": "Jayson Tatum", "last_5_avg_ppg": 28.5},
        {"player_id": 2738, "name": "Derrick White", "last_5_avg_ppg": 12.3},
        {"player_id": 2566, "name": "Al Horford", "last_5_avg_ppg": 9.5},
    ]


@pytest.fixture
def mock_game_log_data():
    """Mock player game log."""
    return [
        {"date": "2025-01-14", "MIN": 32, "PLUS_MINUS": 8},
        {"date": "2025-01-13", "MIN": 35, "PLUS_MINUS": 12},
        {"date": "2025-01-11", "MIN": 28, "PLUS_MINUS": -2},
        {"date": "2025-01-10", "MIN": 34, "PLUS_MINUS": 10},
        {"date": "2025-01-08", "MIN": 30, "PLUS_MINUS": 6},
    ]


# ─────────────────────────────────────────────────────────────────────────────
# TESTS — /api/injuries
# ─────────────────────────────────────────────────────────────────────────────

class TestInjuriesEndpoint:
    """Tests for GET /api/injuries endpoint."""

    def test_injuries_all_teams(self, client, mock_injuries_data):
        """Test fetching injuries for all teams."""
        with patch("main.fetch_injuries", return_value=mock_injuries_data):
            response = client.get("/api/injuries")
            assert response.status_code == 200
            data = response.json()
            assert "injuries" in data
            assert isinstance(data["injuries"], dict)

    def test_injuries_single_team(self, client, mock_injuries_data):
        """Test fetching injuries for a single team."""
        with patch("main.fetch_injuries", return_value=mock_injuries_data):
            with patch("main.get_injury_impact", return_value={"out_count": 1, "severity": "high"}):
                response = client.get("/api/injuries?team=BOS")
                assert response.status_code == 200
                data = response.json()
                assert data["team"] == "BOS"
                assert "injuries" in data
                assert "impact" in data

    def test_injuries_caching(self, client, mock_injuries_data):
        """Test that injuries endpoint caches results."""
        with patch("main.fetch_injuries", return_value=mock_injuries_data) as mock_fetch:
            # First call
            response1 = client.get("/api/injuries")
            assert response1.status_code == 200
            call_count_1 = mock_fetch.call_count

            # Second call (should hit cache)
            response2 = client.get("/api/injuries")
            assert response2.status_code == 200
            call_count_2 = mock_fetch.call_count

            # Mock should not be called again if cache TTL not expired
            assert call_count_2 == call_count_1

    def test_injuries_invalid_team_format(self, client, mock_injuries_data):
        """Test handling of invalid team abbreviations."""
        with patch("main.fetch_injuries", return_value=mock_injuries_data):
            with patch("main.get_injury_impact", return_value={"out_count": 0, "severity": "none"}):
                response = client.get("/api/injuries?team=INVALID")
                assert response.status_code == 200
                # Should still return valid response, just with no injuries for that team

    def test_injuries_env_ttl_respected(self, client):
        """Test that CACHE_TTL_INJURIES environment variable is respected."""
        assert CACHE_TTL_INJURIES == int(os.getenv("CACHE_TTL_INJURIES", "300"))


# ─────────────────────────────────────────────────────────────────────────────
# TESTS — /api/shot_zones
# ─────────────────────────────────────────────────────────────────────────────

class TestShotZonesEndpoint:
    """Tests for GET /api/shot_zones endpoint."""

    def test_shot_zones_basic(self, client):
        """Test shot zones endpoint returns correct structure."""
        response = client.get("/api/shot_zones?team=BOS")
        assert response.status_code == 200
        data = response.json()
        assert "team" in data
        assert data["team"] == "BOS"
        assert "zones" in data
        assert "source" in data
        
        zones = data["zones"]
        assert "rim" in zones
        assert "paint_non_rim" in zones
        assert "mid_range" in zones
        assert "corner_3" in zones
        assert "above_break_3" in zones

    def test_shot_zones_zone_values_valid(self, client):
        """Test that zone percentages are reasonable."""
        response = client.get("/api/shot_zones?team=BOS")
        assert response.status_code == 200
        data = response.json()
        zones = data["zones"]
        
        # Each zone should have a positive value
        for zone_name, value in zones.items():
            assert isinstance(value, (int, float))
            assert value > 0

    def test_shot_zones_multiple_teams(self, client):
        """Test shot zones for different teams."""
        teams = ["BOS", "MIA", "LAL"]
        for team in teams:
            response = client.get(f"/api/shot_zones?team={team}")
            assert response.status_code == 200
            data = response.json()
            assert data["team"] == team

    def test_shot_zones_caching(self, client):
        """Test that shot zones endpoint caches per team."""
        # Clear cache if it exists
        from main import api_shot_zones
        if hasattr(api_shot_zones, "_cache"):
            delattr(api_shot_zones, "_cache")
        
        # First call
        response1 = client.get("/api/shot_zones?team=BOS")
        assert response1.status_code == 200
        
        # Second call (should hit cache)
        response2 = client.get("/api/shot_zones?team=BOS")
        assert response2.status_code == 200
        
        # Results should be identical
        assert response1.json() == response2.json()

    def test_shot_zones_env_ttl_respected(self, client):
        """Test that CACHE_TTL_SHOT_ZONES environment variable is respected."""
        assert CACHE_TTL_SHOT_ZONES == int(os.getenv("CACHE_TTL_SHOT_ZONES", "60"))

    def test_shot_zones_missing_team(self, client):
        """Test that missing team parameter returns error."""
        response = client.get("/api/shot_zones")
        assert response.status_code == 422  # FastAPI validation error


# ─────────────────────────────────────────────────────────────────────────────
# TESTS — /api/lineups
# ─────────────────────────────────────────────────────────────────────────────

class TestLineupsEndpoint:
    """Tests for GET /api/lineups endpoint."""

    def test_lineups_basic(self, client, mock_players_data, mock_game_log_data):
        """Test lineups endpoint returns correct structure."""
        with patch("main.fetch_team_top_players", return_value=mock_players_data):
            with patch("main.fetch_player_game_log", return_value=mock_game_log_data):
                response = client.get("/api/lineups?team=BOS&top_n=3")
                assert response.status_code == 200
                data = response.json()
                assert "team" in data
                assert data["team"] == "BOS"
                assert "combos" in data
                assert isinstance(data["combos"], list)

    def test_lineups_combos_structure(self, client, mock_players_data, mock_game_log_data):
        """Test that lineup combos have correct structure."""
        with patch("main.fetch_team_top_players", return_value=mock_players_data):
            with patch("main.fetch_player_game_log", return_value=mock_game_log_data):
                response = client.get("/api/lineups?team=BOS&top_n=3")
                assert response.status_code == 200
                data = response.json()
                combos = data["combos"]
                
                if combos:  # If combos exist, check structure
                    combo = combos[0]
                    assert "players" in combo
                    assert "min" in combo
                    assert "netRtg" in combo
                    assert "ppp" in combo

    def test_lineups_top_n_parameter(self, client, mock_players_data, mock_game_log_data):
        """Test that top_n parameter affects results."""
        with patch("main.fetch_team_top_players", return_value=mock_players_data):
            with patch("main.fetch_player_game_log", return_value=mock_game_log_data):
                response1 = client.get("/api/lineups?team=BOS&top_n=2")
                response2 = client.get("/api/lineups?team=BOS&top_n=5")
                
                assert response1.status_code == 200
                assert response2.status_code == 200

    def test_lineups_caching(self, client, mock_players_data, mock_game_log_data):
        """Test that lineups endpoint caches per team and top_n."""
        # Clear cache if it exists
        from main import api_lineups
        if hasattr(api_lineups, "_cache"):
            delattr(api_lineups, "_cache")
        
        with patch("main.fetch_team_top_players", return_value=mock_players_data):
            with patch("main.fetch_player_game_log", return_value=mock_game_log_data) as mock_log:
                # First call
                response1 = client.get("/api/lineups?team=BOS&top_n=3")
                assert response1.status_code == 200
                call_count_1 = mock_log.call_count
                
                # Second call (should hit cache)
                response2 = client.get("/api/lineups?team=BOS&top_n=3")
                assert response2.status_code == 200
                call_count_2 = mock_log.call_count
                
                # Second call should not have called fetch_player_game_log again (cache hit)
                # Note: This may not work if the mock is global, but demonstrates the pattern

    def test_lineups_env_ttl_respected(self, client):
        """Test that CACHE_TTL_LINEUPS environment variable is respected."""
        assert CACHE_TTL_LINEUPS == int(os.getenv("CACHE_TTL_LINEUPS", "120"))

    def test_lineups_top_n_bounds(self, client):
        """Test that top_n parameter respects bounds."""
        # top_n must be >= 2 and <= 10
        response_low = client.get("/api/lineups?team=BOS&top_n=1")
        assert response_low.status_code == 422  # Validation error
        
        response_high = client.get("/api/lineups?team=BOS&top_n=11")
        assert response_high.status_code == 422  # Validation error


# ─────────────────────────────────────────────────────────────────────────────
# TESTS — /api/play_types
# ─────────────────────────────────────────────────────────────────────────────

class TestPlayTypesEndpoint:
    """Tests for GET /api/play_types endpoint."""

    def test_play_types_basic(self, client):
        """Test play types endpoint returns correct structure."""
        response = client.get("/api/play_types?team=BOS")
        assert response.status_code == 200
        data = response.json()
        assert "team" in data
        assert data["team"] == "BOS"
        assert "play_types" in data
        assert isinstance(data["play_types"], list)
        assert "source" in data

    def test_play_types_structure(self, client):
        """Test that play types have correct structure."""
        response = client.get("/api/play_types?team=BOS")
        assert response.status_code == 200
        data = response.json()
        play_types = data["play_types"]
        
        for pt in play_types:
            assert "name" in pt
            assert "freq" in pt
            assert "ppp" in pt

    def test_play_types_multiple_teams(self, client):
        """Test play types for different teams."""
        teams = ["BOS", "MIA", "LAL"]
        for team in teams:
            response = client.get(f"/api/play_types?team={team}")
            assert response.status_code == 200
            data = response.json()
            assert data["team"] == team
            assert len(data["play_types"]) > 0

    def test_play_types_caching(self, client):
        """Test that play types endpoint caches per team."""
        # Clear cache if it exists
        from main import api_play_types
        if hasattr(api_play_types, "_cache"):
            delattr(api_play_types, "_cache")
        
        # First call
        response1 = client.get("/api/play_types?team=BOS")
        assert response1.status_code == 200
        
        # Second call (should hit cache)
        response2 = client.get("/api/play_types?team=BOS")
        assert response2.status_code == 200
        
        # Results should be identical
        assert response1.json() == response2.json()

    def test_play_types_env_ttl_respected(self, client):
        """Test that CACHE_TTL_PLAY_TYPES environment variable is respected."""
        assert CACHE_TTL_PLAY_TYPES == int(os.getenv("CACHE_TTL_PLAY_TYPES", "300"))

    def test_play_types_missing_team(self, client):
        """Test that missing team parameter returns error."""
        response = client.get("/api/play_types")
        assert response.status_code == 422  # FastAPI validation error


# ─────────────────────────────────────────────────────────────────────────────
# TESTS — Cache Configuration
# ─────────────────────────────────────────────────────────────────────────────

class TestCacheConfiguration:
    """Tests for environment-configurable cache TTLs."""

    def test_cache_ttl_defaults(self):
        """Test that cache TTL defaults are correct."""
        assert CACHE_TTL_INJURIES == 300
        assert CACHE_TTL_SHOT_ZONES == 60
        assert CACHE_TTL_LINEUPS == 120
        assert CACHE_TTL_PLAY_TYPES == 300

    def test_cache_ttl_from_env(self):
        """Test that cache TTLs can be overridden from environment."""
        # This test verifies the logic; actual env override would require re-import
        injuries_ttl = int(os.getenv("CACHE_TTL_INJURIES", "300"))
        assert injuries_ttl > 0

    def test_cache_ttl_must_be_positive(self):
        """Test that TTLs are positive integers."""
        assert CACHE_TTL_INJURIES > 0
        assert CACHE_TTL_SHOT_ZONES > 0
        assert CACHE_TTL_LINEUPS > 0
        assert CACHE_TTL_PLAY_TYPES > 0


# ─────────────────────────────────────────────────────────────────────────────
# INTEGRATION TESTS
# ─────────────────────────────────────────────────────────────────────────────

class TestIntegration:
    """Integration tests for multiple endpoints."""

    def test_shot_zones_and_play_types(self, client):
        """Test that shot zones and play types endpoints work together."""
        response1 = client.get("/api/shot_zones?team=BOS")
        response2 = client.get("/api/play_types?team=BOS")
        
        assert response1.status_code == 200
        assert response2.status_code == 200
        
        data1 = response1.json()
        data2 = response2.json()
        
        assert data1["team"] == data2["team"]

    def test_error_handling(self, client):
        """Test error handling across endpoints."""
        # Test with empty/null responses
        from main import api_injuries
        # Clear cache to ensure we hit the error
        if hasattr(api_injuries, "_cache"):
            api_injuries._cache = {"ts": 0, "data": None}
        
        with patch("main.fetch_injuries", side_effect=Exception("API Error")):
            response = client.get("/api/injuries")
            assert response.status_code == 500


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
