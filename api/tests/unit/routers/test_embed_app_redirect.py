"""Unit tests for the HMAC app-embed redirect (``GET /embed/apps/{slug}``).

The route is driven through a minimal FastAPI app with the database and
secret decryption replaced, so the real signature checks, token minting and
redirect construction run unchanged.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from contextlib import asynccontextmanager
from types import SimpleNamespace
from urllib.parse import quote
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.core.security import decode_token
from src.routers import embed
from src.services.embed_auth import compute_embed_hmac

SECRET = "test-secret"
SLUG = "support-tab"


def _halo_hmac(agent_id: str) -> str:
    digest = hmac.new(SECRET.encode(), agent_id.encode(), hashlib.sha256).digest()
    return quote(base64.b64encode(digest).decode(), safe="")


def _app_row(slug: str, scheme: str = "halopsa") -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid4(),
        slug=slug,
        organization_id=uuid4(),
        embed_secrets=[
            SimpleNamespace(
                is_active=True, secret_encrypted="encrypted", hmac_scheme=scheme
            )
        ],
    )


def _client(monkeypatch: pytest.MonkeyPatch, app_row: SimpleNamespace) -> TestClient:
    class _Result:
        def scalars(self):
            return SimpleNamespace(all=lambda: [app_row])

    class _Session:
        async def execute(self, _statement):
            return _Result()

    @asynccontextmanager
    async def _fake_db_context():
        yield _Session()

    monkeypatch.setattr(embed, "get_db_context", _fake_db_context)
    monkeypatch.setattr(embed, "decrypt_secret", lambda _value: SECRET)
    api = FastAPI()
    api.include_router(embed.router)
    return TestClient(api)


@pytest.fixture
def halo_app() -> SimpleNamespace:
    return _app_row(SLUG)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, halo_app: SimpleNamespace) -> TestClient:
    return _client(monkeypatch, halo_app)


def _launch(client: TestClient, extra: str = "", agent_id: str = "7", slug: str = SLUG):
    query = f"agent_id={agent_id}&hmac={_halo_hmac(agent_id)}{extra}"
    return client.get(f"/embed/apps/{slug}?{query}", follow_redirects=False)


def _fragment(response) -> str:
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert location.startswith(f"/apps/{SLUG}#"), location
    return location.split("#", 1)[1]


def _split_fragment(fragment: str) -> tuple[str, list[str]]:
    token_part, *rest = fragment.split("&")
    assert token_part.startswith("embed_token=")
    return token_part[len("embed_token=") :], rest


def _claims(token: str) -> dict:
    payload = decode_token(token, expected_type="access")
    assert payload is not None
    return payload


class TestUnsignedHintsInFragment:
    def test_valid_hints_arrive_in_the_fragment_in_fixed_order(self, client):
        # Query order is client_id first: the fragment order is still fixed.
        response = _launch(client, "&client_id=678&ticket_id=12345")

        token, hints = _split_fragment(_fragment(response))
        assert hints == ["unsigned.ticket_id=12345", "unsigned.client_id=678"]
        assert _claims(token)["verified_context"] == {"agent_id": "7"}

    @pytest.mark.parametrize(
        ("extra", "expected"),
        [
            ("&ticket_id=1", ["unsigned.ticket_id=1"]),
            ("&client_id=999999999999", ["unsigned.client_id=999999999999"]),
        ],
    )
    def test_each_hint_alone(self, client, extra, expected):
        _token, hints = _split_fragment(_fragment(_launch(client, extra)))
        assert hints == expected

    def test_old_style_link_gives_exactly_the_token_fragment(self, client):
        fragment = _fragment(_launch(client))

        token, hints = _split_fragment(fragment)
        assert hints == []
        assert fragment == f"embed_token={token}"

    @pytest.mark.parametrize(
        "value",
        [
            "",  # empty
            "1234567890123",  # 13 digits: over-long
            "12a",  # non-numeric
            "abc",
            "-5",  # sign
            "%2B5",  # "+5"
            "+5",  # decodes to " 5"
            "1%205",  # embedded space
            "%201",  # leading space
            "1.5",
            quote("١٢٣"),  # Arabic-Indic digits
            quote("１２３"),  # full-width digits
            "1%0A",  # newline
            "1%26unsigned.agent_id%3D9",  # encoded fragment injection
        ],
    )
    def test_bad_hint_values_are_dropped(self, client, value):
        response = _launch(client, f"&ticket_id={value}&client_id={value}")

        token, hints = _split_fragment(_fragment(response))
        assert hints == []
        assert _claims(token)["verified_context"] == {"agent_id": "7"}

    def test_duplicated_hint_is_dropped_but_the_other_hint_passes(self, client):
        response = _launch(client, "&ticket_id=1&ticket_id=2&client_id=3")

        _token, hints = _split_fragment(_fragment(response))
        assert hints == ["unsigned.client_id=3"]

    def test_duplicated_identical_hint_is_still_dropped(self, client):
        response = _launch(client, "&ticket_id=1&ticket_id=1")

        _token, hints = _split_fragment(_fragment(response))
        assert hints == []

    def test_hints_never_enter_the_token(self, client):
        response = _launch(client, "&ticket_id=12345&client_id=678")

        token, _hints = _split_fragment(_fragment(response))
        claims = _claims(token)
        assert claims["verified_context"] == {"agent_id": "7"}
        assert claims["verified_params"] == {"agent_id": "7"}
        for value in claims.values():
            assert "12345" not in str(value)
            assert "678" not in str(value)
        assert "ticket_id" not in claims
        assert "client_id" not in claims

    @pytest.mark.parametrize(
        "forged",
        [
            "&unsigned.agent_id=9",
            "&unsigned.ticket_id=9",
            "&embed_token=forged",
            "&verified_context=%7B%22agent_id%22%3A%229%22%7D",
            "&verified_params=9",
            "&foo=1",
        ],
    )
    def test_forged_parameters_add_no_fragment_fields(self, client, forged):
        response = _launch(client, f"&ticket_id=5{forged}")

        token, hints = _split_fragment(_fragment(response))
        assert hints == ["unsigned.ticket_id=5"]
        claims = _claims(token)
        assert claims["verified_context"] == {"agent_id": "7"}

    def test_a_second_agent_id_before_the_signed_one_cannot_change_the_token(
        self, client
    ):
        query = f"agent_id=9&agent_id=7&hmac={_halo_hmac('7')}&ticket_id=5"
        response = client.get(f"/embed/apps/{SLUG}?{query}", follow_redirects=False)

        token, hints = _split_fragment(_fragment(response))
        assert hints == ["unsigned.ticket_id=5"]
        assert _claims(token)["verified_context"] == {"agent_id": "7"}

    def test_a_second_agent_id_after_the_signed_one_is_refused(self, client):
        query = f"agent_id=7&hmac={_halo_hmac('7')}&agent_id=9&ticket_id=5"
        response = client.get(f"/embed/apps/{SLUG}?{query}", follow_redirects=False)

        assert response.status_code == 403
        assert "location" not in response.headers

    def test_hints_are_not_passed_when_the_signature_fails(self, client):
        query = f"agent_id=8&hmac={_halo_hmac('7')}&ticket_id=5"
        response = client.get(f"/embed/apps/{SLUG}?{query}", follow_redirects=False)

        assert response.status_code == 403
        assert "location" not in response.headers


class TestShopifySchemeHints:
    def test_signed_hint_stays_verified_and_also_arrives_unsigned(self, monkeypatch):
        app_row = _app_row(SLUG, scheme="shopify")
        client = _client(monkeypatch, app_row)
        params = {"agent_id": "7", "ticket_id": "12345"}
        signature = compute_embed_hmac(params, SECRET)

        response = client.get(
            f"/embed/apps/{SLUG}?agent_id=7&ticket_id=12345&hmac={signature}",
            follow_redirects=False,
        )

        token, hints = _split_fragment(_fragment(response))
        assert hints == ["unsigned.ticket_id=12345"]
        assert _claims(token)["verified_context"] == params


class TestRedirectHeadersForOrdinaryApps:
    def test_ordinary_app_keeps_permissive_framing_headers(self, client):
        response = _launch(client, "&ticket_id=5")

        assert response.status_code == 302
        assert response.headers["content-security-policy"] == "frame-ancestors *"
        assert response.headers["x-frame-options"] == "ALLOWALL"
