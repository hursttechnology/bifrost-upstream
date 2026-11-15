"""E2E tests for workflow execution via embed token."""

import hashlib
import hmac as hmac_module
import uuid
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest
import pytest_asyncio
from sqlalchemy import delete

from tests.e2e.conftest import poll_until, write_and_register


def _compute_hmac(params: dict[str, str], secret: str) -> str:
    message = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    return hmac_module.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def _extract_token_from_redirect(response) -> str:
    """Extract the access token from the redirect URL fragment."""
    location = response.headers.get("location", "")
    parsed = urlparse(location)
    fragment = parsed.fragment  # e.g. "embed_token=eyJ..."
    assert fragment.startswith("embed_token="), f"Expected embed_token in fragment, got: {fragment}"
    return fragment.split("=", 1)[1]


def _mint_app_embed_session(e2e_client, platform_admin) -> dict:
    """Create a fresh app with an embed secret and return its embed token."""
    slug = f"embed-exec-read-{uuid.uuid4().hex[:8]}"
    r = e2e_client.post(
        "/api/applications",
        headers=platform_admin.headers,
        json={"name": slug, "slug": slug, "app_model": "inline_v1"},
    )
    assert r.status_code == 201, r.text
    app = r.json()

    r = e2e_client.post(
        f"/api/applications/{app['id']}/embed-secrets",
        headers=platform_admin.headers,
        json={"name": "Test"},
    )
    assert r.status_code in (200, 201), r.text
    raw_secret = r.json()["raw_secret"]

    params = {"agent_id": "1"}
    r = e2e_client.get(
        f"/embed/apps/{app['slug']}",
        params={**params, "hmac": _compute_hmac(params, raw_secret)},
        follow_redirects=False,
    )
    assert r.status_code == 302, r.text
    return {"app": app, "embed_token": _extract_token_from_redirect(r)}


@pytest.mark.e2e
@pytest.mark.usefixtures("secrets_reader_platform_admin")
class TestEmbedWorkflowExecution:
    """Test that embed tokens can authenticate workflow execution."""

    @pytest.fixture
    def embed_session(self, e2e_client, platform_admin):
        """Create an app with embed secret and get an embed token."""
        # Create app
        r = e2e_client.post(
            "/api/applications",
            headers=platform_admin.headers,
            json={"name": "embed-wf-test", "slug": "embed-wf-test", "app_model": "inline_v1"},
        )
        assert r.status_code == 201, r.text
        app = r.json()

        # Create embed secret
        r = e2e_client.post(
            f"/api/applications/{app['id']}/embed-secrets",
            headers=platform_admin.headers,
            json={"name": "Test"},
        )
        raw_secret = r.json()["raw_secret"]

        # Get embed token via HMAC-verified entry point
        params = {"agent_id": "42"}
        hmac_val = _compute_hmac(params, raw_secret)
        r = e2e_client.get(
            f"/embed/apps/{app['slug']}",
            params={**params, "hmac": hmac_val},
            follow_redirects=False,
        )
        assert r.status_code == 302, r.text
        embed_token = _extract_token_from_redirect(r)

        yield {
            "app": app,
            "embed_token": embed_token,
            "verified_params": params,
        }

        # Cleanup
        e2e_client.delete(f"/api/applications/{app['id']}", headers=platform_admin.headers)

    def test_embed_token_authenticates_workflow_execute(self, e2e_client, embed_session):
        """An embed token should be accepted by the workflow execute endpoint.

        We send a request with a nonexistent workflow — we expect 404 (not found)
        rather than 401/403 (unauthorized), proving the token was accepted.
        """
        r = e2e_client.post(
            "/api/workflows/execute",
            headers={"Authorization": f"Bearer {embed_session['embed_token']}"},
            json={
                "workflow_id": "nonexistent-workflow-for-auth-test",
                "parameters": {},
            },
        )
        # Should get 404 (workflow not found) rather than 401/403 (unauthorized)
        assert r.status_code != 401, f"Embed token rejected as unauthorized: {r.text}"
        assert r.status_code != 403, f"Embed token rejected as forbidden: {r.text}"

    def test_embed_token_cannot_access_admin_endpoints(self, e2e_client, embed_session):
        """Embed tokens should be blocked from admin endpoints by EmbedScopeMiddleware."""
        r = e2e_client.get(
            "/api/users",
            headers={"Authorization": f"Bearer {embed_session['embed_token']}"},
        )
        assert r.status_code == 403, f"Expected 403, got {r.status_code}: {r.text}"
        assert "Embed tokens cannot access" in r.text


@pytest.mark.e2e
@pytest.mark.usefixtures("secrets_reader_platform_admin")
class TestEmbedWorkflowExecutionCanReadItsOwnResult:
    """An app-embed token that starts a workflow execution must be able to
    read that execution back with the SAME token (the V2 app SDK always
    follows up POST /api/workflows/execute with GET /api/executions/{id} for
    the terminal result), and must NOT be able to read an execution created
    by a DIFFERENT app-embed session.
    """

    @pytest.fixture
    def echo_workflow(self, e2e_client, platform_admin):
        workflow = write_and_register(
            e2e_client,
            platform_admin.headers,
            f"embed_exec_read_{uuid.uuid4().hex[:8]}.py",
            (
                '"""Embed execution-read test workflow"""\n'
                "from bifrost import workflow\n\n"
                "@workflow(name='embed_exec_read')\n"
                "async def embed_exec_read() -> dict:\n"
                "    return {'ok': True}\n"
            ),
            "embed_exec_read",
            organization_id=None,  # global: runnable by any app-embed session
        )
        # Newly registered workflows default to access_level="role_based",
        # which an app-embed session (no role assignments) can't satisfy.
        # Open it to any authenticated caller so the access check in
        # execute_sdk_workflow's UUID-resolution path passes.
        r = e2e_client.patch(
            f"/api/workflows/{workflow['id']}",
            headers=platform_admin.headers,
            json={"access_level": "authenticated"},
        )
        assert r.status_code == 200, r.text
        return workflow

    def test_own_session_can_read_execution_result(
        self, e2e_client, platform_admin, echo_workflow
    ):
        session = _mint_app_embed_session(e2e_client, platform_admin)
        headers = {"Authorization": f"Bearer {session['embed_token']}"}
        try:
            r = e2e_client.post(
                "/api/workflows/execute",
                headers=headers,
                json={"workflow_id": echo_workflow["id"], "input_data": {}},
            )
            assert r.status_code == 200, r.text
            execution_id = r.json()["execution_id"]

            def check_terminal():
                resp = e2e_client.get(
                    f"/api/executions/{execution_id}", headers=headers
                )
                if resp.status_code == 200 and resp.json().get("status") in (
                    "Success",
                    "Failed",
                ):
                    return resp.json()
                return None

            result = poll_until(check_terminal, max_wait=30.0)
            assert result is not None, "Execution never reached a terminal status"
            assert result["status"] == "Success", result
            assert result["result"] == {"ok": True}
        finally:
            e2e_client.delete(
                f"/api/applications/{session['app']['id']}",
                headers=platform_admin.headers,
            )

    def test_other_session_cannot_read_execution_result(
        self, e2e_client, platform_admin, echo_workflow
    ):
        owner_session = _mint_app_embed_session(e2e_client, platform_admin)
        other_session = _mint_app_embed_session(e2e_client, platform_admin)
        owner_headers = {"Authorization": f"Bearer {owner_session['embed_token']}"}
        other_headers = {"Authorization": f"Bearer {other_session['embed_token']}"}
        try:
            r = e2e_client.post(
                "/api/workflows/execute",
                headers=owner_headers,
                json={"workflow_id": echo_workflow["id"], "input_data": {}},
            )
            assert r.status_code == 200, r.text
            execution_id = r.json()["execution_id"]

            r = e2e_client.get(
                f"/api/executions/{execution_id}", headers=other_headers
            )
            assert r.status_code == 403, (
                f"a different app-embed session must not read another "
                f"session's execution: {r.status_code} {r.text}"
            )
        finally:
            for session in (owner_session, other_session):
                e2e_client.delete(
                    f"/api/applications/{session['app']['id']}",
                    headers=platform_admin.headers,
                )


@pytest_asyncio.fixture
async def solution_app_embed(e2e_client, platform_admin, db_session, org1):
    """A solution allowing global repo access, an app in it and an embed token.

    Metadata is seeded directly: these cases exercise request resolution
    through real embed authentication, without a deploy or an app build.
    """
    from shared.identities import ensure_default_identity
    from src.models.orm.applications import Application
    from src.models.orm.executions import Execution
    from src.models.orm.organizations import Organization
    from src.models.orm.solutions import Solution
    from src.models.orm.workflows import Workflow

    org_id = uuid.UUID(org1["id"])
    suffix = uuid.uuid4().hex[:10]
    organization = await db_session.get(Organization, org_id)
    await ensure_default_identity(db_session, organization)
    solution = Solution(
        id=uuid.uuid4(), slug=f"heimdall-{suffix}", name="Heimdall Embed Fixture",
        organization_id=org_id, allow_inbound_access=True,
        allow_outbound_access=True,
    )
    app = Application(
        id=uuid.uuid4(), slug=f"heimdall-{suffix}", name="Heimdall Embed Fixture",
        organization_id=org_id, solution_id=solution.id,
        app_model="standalone_v2", access_level="authenticated",
    )
    own = Workflow(
        id=uuid.uuid4(), name=f"heimdall_tab_context_{suffix}",
        path=f"workflows/heimdall_tab_{suffix}.py", function_name="heimdall_tab_context",
        organization_id=org_id, solution_id=solution.id,
        access_level="authenticated", type="workflow", is_active=True,
    )
    root_org = Workflow(
        id=uuid.uuid4(), name=f"root_ad_script_{suffix}",
        path=f"workflows/root_ad_{suffix}.py", function_name="main",
        organization_id=org_id, access_level="authenticated",
        type="workflow", is_active=True,
    )
    root_global = Workflow(
        id=uuid.uuid4(), name=f"root_global_script_{suffix}",
        path=f"workflows/root_global_{suffix}.py", function_name="main",
        organization_id=None, access_level="everyone",
        type="workflow", is_active=True,
    )
    db_session.add(solution)
    await db_session.flush()
    db_session.add_all([app, own, root_org, root_global])
    await db_session.commit()
    workflow_ids = [own.id, root_org.id, root_global.id]
    solution_id = solution.id
    try:
        r = e2e_client.post(
            f"/api/applications/{app.id}/embed-secrets",
            headers=platform_admin.headers,
            json={"name": "Test"},
        )
        assert r.status_code in (200, 201), r.text
        raw_secret = r.json()["raw_secret"]
        params = {"agent_id": "42"}
        r = e2e_client.get(
            f"/embed/apps/{app.slug}",
            params={**params, "hmac": _compute_hmac(params, raw_secret)},
            follow_redirects=False,
        )
        assert r.status_code == 302, r.text
        yield SimpleNamespace(
            headers={"Authorization": f"Bearer {_extract_token_from_redirect(r)}"},
            own=own,
            root_org=root_org,
            root_global=root_global,
        )
    finally:
        await db_session.rollback()
        await db_session.execute(delete(Execution).where(Execution.workflow_id.in_(workflow_ids)))
        await db_session.execute(delete(Workflow).where(Workflow.id.in_(workflow_ids)))
        await db_session.execute(delete(Application).where(Application.solution_id == solution_id))
        await db_session.execute(delete(Solution).where(Solution.id == solution_id))
        await db_session.commit()


def _ref(workflow, kind: str) -> str:
    if kind == "uuid":
        return str(workflow.id)
    if kind == "name":
        return workflow.name
    return f"{workflow.path}::{workflow.function_name}"


@pytest.mark.e2e
@pytest.mark.usefixtures("secrets_reader_platform_admin")
class TestSolutionAppEmbedRunsOnlyItsOwnWorkflows:
    """A solution app's embed reaches only that solution's workflows, even
    when the solution allows global repo access."""

    @pytest.mark.parametrize("kind", ["uuid", "name", "path"])
    @pytest.mark.parametrize("root", ["root_org", "root_global"])
    def test_root_workflows_are_refused(self, e2e_client, solution_app_embed, root, kind):
        ref = _ref(getattr(solution_app_embed, root), kind)
        r = e2e_client.post(
            "/api/workflows/execute",
            headers=solution_app_embed.headers,
            json={"workflow_id": ref, "input_data": {}},
        )
        assert r.status_code == 404, r.text
        assert r.json()["detail"]["message"] == f"Workflow '{ref}' not found"

    def test_own_solution_workflow_is_admitted(self, e2e_client, solution_app_embed):
        # One representative admission. The run is queued but not awaited:
        # the fixture seeds metadata only, and refusals happen before enqueue.
        r = e2e_client.post(
            "/api/workflows/execute",
            headers=solution_app_embed.headers,
            json={"workflow_id": solution_app_embed.own.name, "input_data": {}},
        )
        assert r.status_code == 200, r.text
        assert r.json()["workflow_id"] == str(solution_app_embed.own.id)
