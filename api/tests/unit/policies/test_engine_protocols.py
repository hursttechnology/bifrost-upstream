"""Engine-only tests proving the engine is domain-agnostic.

These tests use a stub Resolver/Binding rather than table-specific ones,
proving the walker code does not reach into any domain.
"""
from __future__ import annotations

from typing import Any, ClassVar

from sqlalchemy import column
from sqlalchemy.sql import ColumnElement

from shared.policies.ast import (
    Expr,
    Policy as SharedPolicy,
    PolicyDocument,
)
from shared.policies.binding import Binding
from shared.policies.resolver import Resolver


class StubResolver:
    namespace: ClassVar[str] = "row"

    def resolve(self, path: str, ctx: Any) -> Any:
        return (ctx or {}).get(path)


def test_resolver_protocol_runtime_check():
    """StubResolver structurally satisfies the Resolver protocol."""
    r: Resolver = StubResolver()
    assert r.namespace == "row"
    assert r.resolve("name", {"name": "alice"}) == "alice"
    assert r.resolve("missing", {}) is None
    assert r.resolve("name", None) is None


class StubBinding:
    namespace: ClassVar[str] = "row"

    def resolve_reference(self, path: str) -> ColumnElement[Any]:
        return column(path)


def test_binding_protocol_runtime_check():
    """StubBinding structurally satisfies the Binding protocol."""
    b: Binding = StubBinding()
    assert isinstance(b, Binding)
    assert b.namespace == "row"
    col = b.resolve_reference("name")
    assert str(col) == "name"


def test_policy_document_round_trip():
    """PolicyDocument validates with any action vocab as plain strings (domain-agnostic)."""
    doc = PolicyDocument.model_validate({
        "policies": [
            {
                "name": "admin",
                "actions": ["read", "write", "list", "delete"],  # file action vocab — accepted at shared layer
                "when": {"user": "is_platform_admin"},
            },
        ],
    })
    assert len(doc.policies) == 1
    assert doc.policies[0].name == "admin"
    assert doc.policies[0].actions == ["read", "write", "list", "delete"]


def test_policy_document_empty():
    """Empty PolicyDocument is valid (default-deny semantics)."""
    doc = PolicyDocument()
    assert doc.policies == []


def test_shared_policy_accepts_arbitrary_actions():
    """Shared Policy is domain-agnostic — accepts any action string list."""
    p = SharedPolicy(name="x", actions=["custom_action"])
    assert p.actions == ["custom_action"]


def test_expr_validator_still_works():
    """AST validator still rejects unknown user fields."""
    import pytest
    from pydantic import ValidationError as PydanticValidationError

    with pytest.raises(PydanticValidationError):
        Expr.model_validate({"user": "not_a_real_field"})
