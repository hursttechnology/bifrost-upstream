"""Unit tests for the chat ArtifactService (Chat V2 sub-project 4 — Part C).

Covers contract extraction/stripping, S3 key scheme, file persistence (base64
decode, size guards, sha256), preview resolution (markdown inline vs.
image/pdf/csv file ref), and reconstruction of ArtifactInfo from persisted rows.
Storage and DB are mocked; pure-logic tests that do not require the test stack.
"""

import base64
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from src.models.contracts.agents import ArtifactToolContract
from src.models.orm import MessageArtifact
from src.services.artifacts import (
    MAX_ARTIFACT_FILE_BYTES,
    MAX_FILES_PER_ARTIFACT,
    ArtifactError,
    ArtifactService,
    build_artifact_infos,
    extract_artifact_contract,
    strip_artifact_from_result,
)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _svc(db=None) -> ArtifactService:
    return ArtifactService(db or AsyncMock())


def _contract(**kw) -> dict:
    base = {
        "title": "Report",
        "files": [
            {"name": "report.md", "content_type": "text/markdown", "content_base64": _b64(b"# Hi")}
        ],
    }
    base.update(kw)
    return base


# --------------------------------------------------------------------------- #
# Contract extraction / stripping
# --------------------------------------------------------------------------- #


def test_extract_returns_none_for_non_dict():
    assert extract_artifact_contract("just text") is None
    assert extract_artifact_contract(None) is None
    assert extract_artifact_contract([1, 2]) is None


def test_extract_returns_none_when_no_artifact_key():
    assert extract_artifact_contract({"result": "ok"}) is None


def test_extract_parses_valid_contract():
    contract = extract_artifact_contract({"artifact": _contract()})
    assert isinstance(contract, ArtifactToolContract)
    assert contract.title == "Report"
    assert contract.files[0].name == "report.md"


def test_extract_ignores_malformed_artifact():
    # Missing required file fields → ignored, not raised.
    bad = {"artifact": {"files": [{"name": "x"}]}}
    assert extract_artifact_contract(bad) is None


def test_strip_removes_artifact_key_only():
    res = {"response": "done", "artifact": {"files": []}}
    stripped = strip_artifact_from_result(res)
    assert stripped == {"response": "done"}
    # original untouched (returns a new dict)
    assert "artifact" in res


def test_strip_passthrough_for_non_dict():
    assert strip_artifact_from_result("text") == "text"
    assert strip_artifact_from_result({"a": 1}) == {"a": 1}


# --------------------------------------------------------------------------- #
# S3 key scheme
# --------------------------------------------------------------------------- #


def test_build_s3_key_scheme():
    conv = uuid4()
    art = uuid4()
    key = ArtifactService.build_s3_key(conv, art, "out.pdf")
    assert key == f"_artifacts/{conv}/{art}_out.pdf"


def test_build_s3_key_sanitizes_separators():
    conv = uuid4()
    art = uuid4()
    key = ArtifactService.build_s3_key(conv, art, "a/b\\c.txt")
    assert key.endswith("_a_b_c.txt")
    assert "/" not in key.split("/", 2)[2]  # filename segment has no path separators


# --------------------------------------------------------------------------- #
# Persist
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_persist_writes_files_and_returns_metadata():
    db = AsyncMock()
    db.add = lambda *_: None  # sync
    svc = _svc(db)
    fake_storage = AsyncMock()
    contract = ArtifactToolContract.model_validate(
        _contract(
            files=[
                {"name": "a.csv", "content_type": "text/csv", "content_base64": _b64(b"x,y\n1,2")},
            ],
            preview={"kind": "csv", "content_ref": "a.csv"},
        )
    )
    with patch("src.services.artifacts.get_file_storage_service", return_value=fake_storage):
        info = await svc.persist(contract=contract, conversation_id=uuid4(), message_id=uuid4())

    assert fake_storage.write_raw_to_s3.await_count == 1
    assert len(info.files) == 1
    assert info.files[0].filename == "a.csv"
    assert info.files[0].sha256  # computed
    # csv preview points at the persisted file id (no URL in the contract)
    assert info.preview is not None
    assert info.preview.kind == "csv"
    assert info.preview.file_id == info.files[0].id


@pytest.mark.asyncio
async def test_persist_markdown_preview_is_inline():
    db = AsyncMock()
    db.add = lambda *_: None
    svc = _svc(db)
    fake_storage = AsyncMock()
    contract = ArtifactToolContract.model_validate(
        _contract(preview={"kind": "markdown", "inline": "# Title"})
    )
    with patch("src.services.artifacts.get_file_storage_service", return_value=fake_storage):
        info = await svc.persist(contract=contract, conversation_id=uuid4(), message_id=uuid4())
    assert info.preview is not None
    assert info.preview.kind == "markdown"
    assert info.preview.inline == "# Title"
    assert info.preview.file_id is None


@pytest.mark.asyncio
async def test_persist_rejects_no_files():
    svc = _svc()
    contract = ArtifactToolContract(title="x", files=[])
    with pytest.raises(ArtifactError):
        await svc.persist(contract=contract, conversation_id=uuid4(), message_id=uuid4())


@pytest.mark.asyncio
async def test_persist_rejects_too_many_files():
    svc = _svc()
    files = [
        {"name": f"f{i}.txt", "content_type": "text/plain", "content_base64": _b64(b"x")}
        for i in range(MAX_FILES_PER_ARTIFACT + 1)
    ]
    contract = ArtifactToolContract.model_validate(_contract(files=files))
    with pytest.raises(ArtifactError):
        await svc.persist(contract=contract, conversation_id=uuid4(), message_id=uuid4())


@pytest.mark.asyncio
async def test_persist_rejects_bad_base64():
    db = AsyncMock()
    db.add = lambda *_: None
    svc = _svc(db)
    contract = ArtifactToolContract.model_validate(
        _contract(files=[{"name": "x.txt", "content_type": "text/plain", "content_base64": "!!notb64!!"}])
    )
    with patch("src.services.artifacts.get_file_storage_service", return_value=AsyncMock()):
        with pytest.raises(ArtifactError):
            await svc.persist(contract=contract, conversation_id=uuid4(), message_id=uuid4())


@pytest.mark.asyncio
async def test_persist_rejects_oversize():
    db = AsyncMock()
    db.add = lambda *_: None
    svc = _svc(db)
    big = b"x" * (MAX_ARTIFACT_FILE_BYTES + 1)
    contract = ArtifactToolContract.model_validate(
        _contract(files=[{"name": "big.bin", "content_type": "application/octet-stream", "content_base64": _b64(big)}])
    )
    with patch("src.services.artifacts.get_file_storage_service", return_value=AsyncMock()):
        with pytest.raises(ArtifactError):
            await svc.persist(contract=contract, conversation_id=uuid4(), message_id=uuid4())


@pytest.mark.asyncio
async def test_persist_drops_preview_when_ref_missing():
    db = AsyncMock()
    db.add = lambda *_: None
    svc = _svc(db)
    fake_storage = AsyncMock()
    contract = ArtifactToolContract.model_validate(
        _contract(
            files=[{"name": "a.txt", "content_type": "text/plain", "content_base64": _b64(b"x")}],
            preview={"kind": "image", "content_ref": "missing.png"},
        )
    )
    with patch("src.services.artifacts.get_file_storage_service", return_value=fake_storage):
        info = await svc.persist(contract=contract, conversation_id=uuid4(), message_id=uuid4())
    # files kept, preview dropped (soft failure, not a turn failure)
    assert len(info.files) == 1
    assert info.preview is None


@pytest.mark.asyncio
async def test_persist_rejects_unsupported_preview_kind():
    svc = _svc()
    # bypass pydantic Literal by constructing the model with a forced bad kind is
    # not possible; instead ensure the service guards even if a kind slips through.
    contract = ArtifactToolContract.model_validate(_contract(preview={"kind": "markdown", "inline": "x"}))
    # mutate to an unsupported kind to exercise the guard
    object.__setattr__(contract.preview, "kind", "html")
    with pytest.raises(ArtifactError):
        await svc.persist(contract=contract, conversation_id=uuid4(), message_id=uuid4())


@pytest.mark.asyncio
async def test_mint_download_url_uses_storage():
    svc = _svc()
    fake_storage = AsyncMock()
    fake_storage.generate_presigned_download_url.return_value = "https://signed/url"
    art = MessageArtifact(
        id=uuid4(), message_id=uuid4(), conversation_id=uuid4(),
        s3_key="_artifacts/c/a_x.pdf", filename="x.pdf",
        content_type="application/pdf", size_bytes=10,
    )
    with patch("src.services.artifacts.get_file_storage_service", return_value=fake_storage):
        url = await svc.mint_download_url(art)
    assert url == "https://signed/url"
    fake_storage.generate_presigned_download_url.assert_awaited_once()


# --------------------------------------------------------------------------- #
# Reconstruction from persisted rows
# --------------------------------------------------------------------------- #


def _row(**kw) -> MessageArtifact:
    base = dict(
        id=uuid4(), message_id=uuid4(), conversation_id=uuid4(),
        title="T", s3_key="k", filename="f.txt", content_type="text/plain",
        size_bytes=3, sha256="abc", preview_kind=None, preview_inline=None,
    )
    base.update(kw)
    return MessageArtifact(**base)


def test_build_artifact_infos_empty():
    assert build_artifact_infos([]) == []


def test_build_artifact_infos_groups_by_title():
    mid = uuid4()
    rows = [
        _row(message_id=mid, title="A", filename="a1.txt"),
        _row(message_id=mid, title="A", filename="a2.txt"),
        _row(message_id=mid, title="B", filename="b1.txt"),
    ]
    infos = build_artifact_infos(rows)
    assert len(infos) == 2
    assert {i.title for i in infos} == {"A", "B"}
    assert len(infos[0].files) == 2


def test_build_artifact_infos_markdown_preview():
    rows = [_row(preview_kind="markdown", preview_inline="# md")]
    infos = build_artifact_infos(rows)
    assert infos[0].preview is not None
    assert infos[0].preview.kind == "markdown"
    assert infos[0].preview.inline == "# md"


def test_build_artifact_infos_file_preview_points_at_file():
    art_id = uuid4()
    rows = [_row(id=art_id, preview_kind="pdf", filename="r.pdf", content_type="application/pdf")]
    infos = build_artifact_infos(rows)
    assert infos[0].preview is not None
    assert infos[0].preview.kind == "pdf"
    assert infos[0].preview.file_id == art_id
