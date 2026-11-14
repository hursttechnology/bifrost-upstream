"""Public frame-policy HTTP contract; requires the full API test stack."""

import pytest


@pytest.mark.e2e
def test_app_frame_policy_defaults(e2e_client):
    """The stock stack restricts Heimdall without changing ordinary apps."""
    configured = e2e_client.get("/embed/apps/heimdall/frame-policy")
    assert configured.status_code == 204
    assert configured.headers["content-security-policy"] == (
        "frame-ancestors https://support.hurst.technology"
    )
    assert configured.headers["x-bifrost-frame-ancestors"] == "https://support.hurst.technology"
    assert configured.headers["cache-control"] == "no-store"

    ordinary = e2e_client.get("/embed/apps/unconfigured-frame-policy-test/frame-policy")
    assert ordinary.status_code == 204
    assert ordinary.headers["cache-control"] == "no-store"
    assert "content-security-policy" not in ordinary.headers
    assert "x-bifrost-frame-ancestors" not in ordinary.headers
