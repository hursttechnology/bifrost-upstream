"""The app framing configuration must fail closed before serving requests."""

import json

import pytest
from pydantic import ValidationError

from src.config import Settings


def settings(**kwargs):
    return Settings(_env_file=None, secret_key="test-secret" * 4, **kwargs)


def test_default_only_allows_halo_origin(monkeypatch):
    monkeypatch.delenv("BIFROST_EMBED_APP_FRAME_ANCESTORS", raising=False)
    assert settings().embed_app_frame_ancestors == {
        "heimdall": "https://support.hurst.technology"
    }


def test_json_environment_override(monkeypatch):
    policy = {"my-app-2": "'self' https://support.example:8443 https://[::1]"}
    monkeypatch.setenv("BIFROST_EMBED_APP_FRAME_ANCESTORS", json.dumps(policy))
    assert settings().embed_app_frame_ancestors == policy


def test_empty_mapping_disables_app_policies():
    assert settings(embed_app_frame_ancestors={}).embed_app_frame_ancestors == {}


@pytest.mark.parametrize("slug", ["", "Heimdall", "1app", "a_b", "a/b", "a.b", "a\n", "a" * 256])
def test_invalid_slug_refused(slug):
    with pytest.raises(ValidationError):
        settings(embed_app_frame_ancestors={slug: "https://support.example"})


@pytest.mark.parametrize("source", [
    "", " ", "*", "'none'", "self", "http://support.example", "https:",
    "https://support.example/", "https://support.example/path",
    "https://support.example?x=1", "https://support.example#x",
    "https://*.example", "https://user@support.example", "https://support.example;",
    "https://support.example\n", "https://support.example\r", "https://support.example\t",
    "https://support.example 'self'; script-src *", 'https://support.example"',
    "https://support.example\\path", "https://support.example:0",
    "https://support.example:65536", "https://support.example:bad",
    "https://support.example:", "https://-bad.example", "https://bad_.example",
])
def test_invalid_source_refused(source):
    with pytest.raises(ValidationError):
        settings(embed_app_frame_ancestors={"heimdall": source})
