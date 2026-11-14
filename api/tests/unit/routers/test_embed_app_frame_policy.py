"""App document policy is public, uncached and independent of database state."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.routers import embed


@pytest.mark.parametrize("slug, policy", [
    ("heimdall", "https://support.hurst.technology"),
    ("custom", "'self' https://other.example:8443"),
    ("ordinary", None),
])
def test_frame_policy_headers_without_database(monkeypatch, slug, policy):
    monkeypatch.setattr(embed, "get_settings", lambda: SimpleNamespace(
        embed_app_frame_ancestors={
            "heimdall": "https://support.hurst.technology",
            "custom": "'self' https://other.example:8443",
        }
    ), raising=False)
    database = Mock(side_effect=AssertionError("Frame policy must not use the database"))
    monkeypatch.setattr(embed, "get_db_context", database)
    app = FastAPI()
    app.include_router(embed.router)
    response = TestClient(app).get(f"/embed/apps/{slug}/frame-policy")
    assert response.status_code == 204
    assert response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert "x-frame-options" not in response.headers
    if policy is None:
        assert "content-security-policy" not in response.headers
        assert "x-bifrost-frame-ancestors" not in response.headers
    else:
        assert response.headers["content-security-policy"] == f"frame-ancestors {policy}"
        assert response.headers["x-bifrost-frame-ancestors"] == policy
    database.assert_not_called()
    assert f"/embed/apps/{slug}/frame-policy" not in app.openapi()["paths"]
    assert "/embed/apps/{slug}/frame-policy" not in app.openapi()["paths"]
