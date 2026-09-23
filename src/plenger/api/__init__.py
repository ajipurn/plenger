"""Loopback API with one-use pairing, short sessions and CSRF protection."""

import json
import secrets
import threading
import time
import uuid
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import Field

from plenger.domain import StrictModel
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec
from plenger.runner import TrustedObserver
from plenger.services.active import (
    approve_for_project,
    cancel_active_run,
    execute_active_run,
    get_project_plan,
    plan_for_project,
    queue_active_run,
    revoke_project_plan,
)
from plenger.services.application import (
    capabilities,
    execute_scan,
    export_stored_report,
    findings_page_with_cursor,
    graph_page,
    latest,
    project_id,
    queue_scan,
    recover_runs,
    run_history_page,
    run_status,
    update_finding_lifecycle,
)
from plenger.services.assessment import (
    assessment_consent_preview,
    assessment_count_for_run,
    assessments_page_for_run,
    evaluate_finding,
    grant_hosted_consent_for_project,
    revoke_hosted_consent_for_project,
)
from plenger.services.diff import diff_reports
from plenger.storage import open_store
from plenger.storage.attempts import list_active_attempts
from plenger.storage.runs import RunConflict, list_events

ORIGIN = "http://127.0.0.1:7331"
SESSION_COOKIE_NAME = "plenger_session"
LEGACY_SESSION_COOKIE_NAME = "wonderkit_session"
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    ),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


class PairBody(StrictModel):
    code: str = Field(min_length=16, max_length=128)


class ScanBody(StrictModel):
    profile: Literal["deterministic", "baseline"] = "deterministic"
    fixture: bool = False


class FindingLifecycleBody(StrictModel):
    lifecycle_state: Literal["open", "acknowledged", "suppressed", "resolved"]
    reason: str = Field(min_length=1, max_length=1000)
    expected_revision: int = Field(ge=0)
    actor: str = Field(default="local-user", min_length=1, max_length=128)
    expiry_days: int = Field(default=30, ge=1, le=365)


class PlanBody(StrictModel):
    target: TargetSpec
    case_ids: list[str] = Field(min_length=1, max_length=40)
    snapshot_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    auth_identity: str = Field(min_length=1, max_length=128)
    data_classes: list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]] = Field(
        default_factory=list, max_length=5
    )
    budget: BudgetSpec = Field(default_factory=BudgetSpec)

    def to_plan(self) -> PlanSpec:
        return PlanSpec(
            target=self.target,
            case_ids=self.case_ids,
            snapshot_digest=self.snapshot_digest,
            auth_identity=self.auth_identity,
            data_classes=self.data_classes,
            budget=self.budget,
        )


class ApprovalBody(StrictModel):
    actor: str = Field(min_length=1, max_length=128)
    acknowledgment: Literal["I_AUTHORIZE_THIS_EXPLICIT_SCOPE"]
    ttl_minutes: int = Field(default=30, ge=1, le=30)


class PlanRunBody(StrictModel):
    approval_id: str = Field(min_length=36, max_length=36)


class AssessmentBody(StrictModel):
    finding_id: str = Field(min_length=64, max_length=64)
    provider: Literal["deterministic", "manual", "jev"] = "deterministic"
    consent: bool = False
    data_classes: list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]] = Field(
        default_factory=list, max_length=5
    )


class AssessmentConsentBody(StrictModel):
    provider: Literal["jev"] = "jev"
    data_classes: list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]] = Field(
        default_factory=lambda: cast(
            list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]],
            ["metadata", "code_excerpt", "response"],
        ),
        max_length=5,
    )
    acknowledgment: Literal["I_AUTHORIZE_HOSTED_ASSESSMENT"]


class ExportBody(StrictModel):
    format: Literal["json", "html"]


class Sessions:
    def __init__(self) -> None:
        self.code = secrets.token_urlsafe(24)
        self.deadline = time.monotonic() + 60
        self.used = False
        self.attempts = 0
        self.lock = threading.Lock()
        self.sessions: dict[str, tuple[float, str]] = {}

    def pair(self, code: str) -> tuple[str, str] | None:
        with self.lock:
            self.attempts += 1
            if (
                self.attempts > 5
                or self.used
                or time.monotonic() >= self.deadline
                or not secrets.compare_digest(code, self.code)
            ):
                return None
            self.used = True
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.sessions[token] = (time.monotonic() + 1800, csrf)
            return token, csrf

    def valid(self, token: str) -> tuple[float, str] | None:
        with self.lock:
            session = self.sessions.get(token)
            if session is None:
                return None
            if time.monotonic() >= session[0]:
                self.sessions.pop(token, None)
                return None
            return session


def error(code: str, status: int) -> JSONResponse:
    response = JSONResponse(
        {"code": code, "message": code, "request_id": str(uuid.uuid4()), "details": {}},
        status_code=status,
    )
    for name, value in SECURITY_HEADERS.items():
        response.headers[name] = value
    return response


def create_app(
    root: Path,
    sessions: Sessions | None = None,
    active_observer: TrustedObserver | None = None,
) -> FastAPI:
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="plenger-static")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        recover_runs(root)
        try:
            yield
        finally:
            pool.shutdown(wait=True, cancel_futures=True)

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    pairing = sessions or Sessions()
    app.state.pairing = pairing
    app.state.project_root = root
    app.state.active_observer = active_observer
    identity = project_id(root)
    assets = Path(__file__).resolve().parents[1] / "ui"

    @app.middleware("http")
    async def guard(request: Request, call_next: Any) -> Response:
        if request.headers.get("host") != "127.0.0.1:7331":
            return error("invalid_host", 403)
        origin = request.headers.get("origin")
        if origin is not None and origin != ORIGIN:
            return error("invalid_origin", 403)
        mutating = request.method not in {"GET", "HEAD", "OPTIONS"}
        if mutating and origin != ORIGIN:
            return error("origin_required", 403)
        path = request.url.path
        if path.startswith("/api/") and path not in {"/api/v1/health", "/api/v1/pair"}:
            token = request.cookies.get(
                SESSION_COOKIE_NAME,
                request.cookies.get(LEGACY_SESSION_COOKIE_NAME, ""),
            )
            session = pairing.valid(token)
            if not session:
                return error("session_required", 401)
            if mutating and not secrets.compare_digest(
                request.headers.get("x-csrf-token", ""), session[1]
            ):
                return error("csrf_required", 403)
        # Bound all mutation bodies before schema parsing.
        if mutating:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                body_limit = 8192 if "/plans" in request.url.path else 1024
                if len(body) > body_limit:
                    return error("body_too_large", 413)
            request._body = bytes(body)
        response: Response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers[name] = value
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, exc: RequestValidationError) -> JSONResponse:
        return error("invalid_request", 422)  # Never echo submitted sensitive input.

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        del request, exc
        return error("internal_error", 500)

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/pair")
    def pair(body: PairBody) -> Response:
        result = pairing.pair(body.code)
        if not result:
            return error("pairing_invalid_or_expired", 429 if pairing.attempts > 5 else 401)
        token, csrf = result
        response = JSONResponse({"csrf_token": csrf, "project_id": identity})
        response.set_cookie(
            SESSION_COOKIE_NAME, token, max_age=1800, httponly=True, samesite="strict", path="/"
        )
        return response

    @app.get("/api/v1/session")
    def session(request: Request) -> dict[str, str]:
        token = request.cookies.get(
            SESSION_COOKIE_NAME,
            request.cookies.get(LEGACY_SESSION_COOKIE_NAME, ""),
        )
        valid = pairing.valid(token)
        assert valid is not None
        return {"project_id": identity, "csrf_token": valid[1]}

    @app.post("/api/v1/logout")
    def logout(request: Request) -> Response:
        with pairing.lock:
            token = request.cookies.get(
                SESSION_COOKIE_NAME,
                request.cookies.get(LEGACY_SESSION_COOKIE_NAME, ""),
            )
            pairing.sessions.pop(token, None)
        response = JSONResponse({"status": "logged_out"})
        response.delete_cookie(SESSION_COOKIE_NAME)
        response.delete_cookie(LEGACY_SESSION_COOKIE_NAME)
        return response

    @app.get("/api/v1/capabilities")
    def get_capabilities() -> dict[str, Any]:
        return capabilities(root)

    @app.get("/api/v1/assessment-consent")
    def get_assessment_consent() -> Response:
        try:
            return JSONResponse(assessment_consent_preview(root))
        except (ValueError, OSError):
            return error("assessment_consent_unavailable", 422)

    @app.post("/api/v1/assessment-consent", status_code=201)
    def create_assessment_consent(body: AssessmentConsentBody) -> Response:
        try:
            return JSONResponse(
                grant_hosted_consent_for_project(
                    root,
                    body.provider,
                    body.data_classes,
                    actor="browser-session",
                ),
                status_code=201,
            )
        except ValueError as exc:
            return error(str(exc), 422)

    @app.delete("/api/v1/assessment-consent")
    def delete_assessment_consent() -> Response:
        try:
            if not revoke_hosted_consent_for_project(root):
                return error("assessment_consent_not_found", 404)
            return JSONResponse({"revoked": True})
        except (ValueError, OSError):
            return error("assessment_consent_unavailable", 422)

    @app.post("/api/v1/projects/{requested}/plans", status_code=201)
    def create_plan_endpoint(requested: str, body: PlanBody) -> Response:
        if requested != identity:
            return error("not_found", 404)
        try:
            return JSONResponse(plan_for_project(root, body.to_plan()), status_code=201)
        except (ValueError, OSError):
            return error("invalid_plan", 422)

    @app.get("/api/v1/plans/{plan_id}")
    def plan_endpoint(plan_id: str) -> Response:
        current = get_project_plan(root, plan_id)
        return JSONResponse(current) if current else error("not_found", 404)

    @app.post("/api/v1/plans/{plan_id}/approvals", status_code=201)
    def approve_endpoint(plan_id: str, body: ApprovalBody) -> Response:
        try:
            return JSONResponse(
                approve_for_project(
                    root, plan_id, body.actor, body.acknowledgment, body.ttl_minutes
                ),
                status_code=201,
            )
        except RunConflict as exc:
            return error(str(exc), 409)
        except ValueError as exc:
            return error(str(exc), 422)

    @app.post("/api/v1/plans/{plan_id}/runs", status_code=202)
    def run_plan_endpoint(plan_id: str, body: PlanRunBody, request: Request) -> Response:
        if get_project_plan(root, plan_id) is None:
            return error("not_found", 404)
        key = request.headers.get("idempotency-key", "")
        if not key or len(key) > 128:
            return error("idempotency_key_required", 422)
        try:
            run_id, created = queue_active_run(root, plan_id, body.approval_id, key)
        except RunConflict as exc:
            code = str(exc)
            status = (
                503
                if code == "active_runner_unavailable"
                else 429
                if code == "queue_capacity"
                else 409
            )
            return error(code, status)
        except (ValueError, OSError):
            return error("active_runner_unavailable", 503)
        if created:
            pool.submit(run_active_background, run_id)
        return JSONResponse({"run_id": run_id}, status_code=202)

    @app.post("/api/v1/plans/{plan_id}/revoke")
    def revoke_endpoint(plan_id: str) -> Response:
        if not revoke_project_plan(root, plan_id):
            return error("plan_not_found_or_closed", 409)
        return JSONResponse({"status": "revoked", "plan_id": plan_id})

    @app.get("/api/v1/projects/{requested}/report")
    def report(requested: str, run_id: str | None = None) -> Response:
        if requested != identity:
            return error("not_found", 404)
        if run_id is not None and run_id and run_status(root, run_id) is None:
            return error("not_found", 404)
        current = latest(root, run_id)
        if current:
            counts: dict[str, int] = {}
            for key in ("nodes", "edges", "findings", "skipped", "assessments"):
                value = current.get(key, [])
                counts[key] = len(value) if isinstance(value, list) else 0
                if key == "findings" and isinstance(value, list):
                    counts["priority_findings"] = sum(
                        isinstance(item, dict)
                        and str(item.get("severity", "")).lower() in {"high", "critical"}
                        for item in value
                    )
                current[key] = value[:100] if isinstance(value, list) else []
            snapshot = current.get("snapshot")
            if isinstance(snapshot, dict):
                for key in ("files", "skipped"):
                    value = snapshot.get(key, [])
                    counts[f"snapshot_{key}"] = len(value) if isinstance(value, list) else 0
                    snapshot[key] = value[:100] if isinstance(value, list) else []
            current_run_id = current.get("run_id")
            if isinstance(current_run_id, str):
                counts["assessments"] = assessment_count_for_run(root, current_run_id)
            current["counts"] = counts
            current["view_limit"] = 100
            current["view_truncated"] = any(count > 100 for count in counts.values())
        return JSONResponse({"report": current})

    @app.get("/api/v1/projects/{requested}/findings")
    def findings(
        requested: str,
        limit: int = 100,
        offset: int = 0,
        cursor: str | None = None,
        run_id: str | None = None,
        severity: str | None = None,
        validation_state: str | None = None,
        lifecycle_state: str | None = None,
        kind: str | None = None,
        source_path: str | None = None,
    ) -> Response:
        if requested != identity:
            return error("not_found", 404)
        if not 1 <= limit <= 100 or offset < 0 or (cursor is not None and offset != 0):
            return error("invalid_pagination", 422)
        if run_id is not None and run_status(root, run_id) is None:
            return error("not_found", 404)
        filters = {
            name: value
            for name, value in {
                "severity": severity,
                "validation_state": validation_state,
                "lifecycle_state": lifecycle_state,
                "kind": kind,
                "source_path": source_path,
            }.items()
            if value is not None
        }
        try:
            items, next_cursor = findings_page_with_cursor(
                root, limit, offset, cursor, filters, run_id
            )
        except ValueError as exc:
            code = str(exc)
            if code not in {"invalid_finding_filter", "invalid_finding_cursor"}:
                code = "invalid_pagination"
            return error(code, 422)
        return JSONResponse({"items": items, "next_cursor": next_cursor})

    @app.get("/api/v1/projects/{requested}/diff")
    def compare(requested: str, base_run_id: str, current_run_id: str) -> Response:
        if requested != identity:
            return error("not_found", 404)
        base = latest(root, base_run_id)
        current = latest(root, current_run_id)
        if base is None or current is None:
            return error("not_found", 404)
        return JSONResponse(diff_reports(base, current))

    @app.get("/api/v1/projects/{requested}/runs")
    def history(requested: str, limit: int = 50, offset: int = 0) -> Response:
        if requested != identity:
            return error("not_found", 404)
        if not 1 <= limit <= 100 or offset < 0:
            return error("invalid_pagination", 422)
        items, has_more = run_history_page(root, limit, offset)
        payload: dict[str, Any] = {"items": items}
        if has_more:
            payload["next_offset"] = offset + limit
        return JSONResponse(payload)

    def run_background(run_id: str) -> None:
        try:
            execute_scan(root, run_id)
        except Exception:
            # execute_scan persists a bounded reason; do not log source or vendor exceptions.
            return

    def run_active_background(run_id: str) -> None:
        try:
            execute_active_run(root, run_id, observer=active_observer)
        except Exception:
            return

    @app.post("/api/v1/projects/{requested}/scans", status_code=202)
    def start_scan(requested: str, body: ScanBody, request: Request) -> Response:
        if requested != identity:
            return error("not_found", 404)
        key = request.headers.get("idempotency-key", "")
        if not key or len(key) > 128:
            return error("idempotency_key_required", 422)
        try:
            run_id, created = queue_scan(root, body.profile, body.fixture, key)
        except RunConflict as exc:
            return error(str(exc), 429 if str(exc) == "queue_capacity" else 409)
        except (ValueError, OSError):
            return error("invalid_workspace_or_config", 422)
        if created:
            pool.submit(run_background, run_id)
        return JSONResponse({"run_id": run_id}, status_code=202)

    @app.get("/api/v1/runs/{run_id}")
    def get_run(run_id: str) -> Response:
        current = run_status(root, run_id)
        return JSONResponse(current) if current else error("not_found", 404)

    @app.get("/api/v1/runs/{run_id}/events")
    def run_events(
        run_id: str,
        request: Request,
        after_sequence: int = -1,
        limit: int = 100,
    ) -> Response:
        if run_status(root, run_id) is None:
            return error("not_found", 404)
        raw_last = request.headers.get("last-event-id")
        if raw_last is not None:
            try:
                after_sequence = int(raw_last)
            except ValueError:
                return error("invalid_event_cursor", 422)
        engine = open_store(root)
        try:
            events = list_events(engine, identity, run_id, after_sequence, limit)
        except ValueError:
            return error("invalid_event_pagination", 422)
        finally:
            engine.dispose()
        payload = "".join(
            "id: {sequence}\nevent: run_state\ndata: {data}\n\n".format(
                sequence=item["sequence"],
                data=json.dumps(
                    {
                        "run_id": item["run_id"],
                        "sequence": item["sequence"],
                        "state": item["state"],
                        "reason": item["reason"],
                        "created_at": item["created_at"],
                    },
                    ensure_ascii=False,
                ),
            )
            for item in events
        )
        return Response(payload, media_type="text/event-stream")

    @app.post("/api/v1/runs/{run_id}/cancel")
    def cancel_run(run_id: str) -> Response:
        try:
            state = cancel_active_run(root, run_id)
        except RunConflict as exc:
            return error(str(exc), 409)
        if state is None:
            return error("not_found", 404)
        return JSONResponse({"run_id": run_id, "state": state})

    @app.get("/api/v1/runs/{run_id}/assessments")
    def get_assessments(
        run_id: str, finding_id: str | None = None, limit: int = 50, offset: int = 0
    ) -> Response:
        if run_status(root, run_id) is None:
            return error("not_found", 404)
        if not 1 <= limit <= 100 or offset < 0:
            return error("invalid_pagination", 422)
        try:
            items, has_more = assessments_page_for_run(root, run_id, finding_id, limit, offset)
        except ValueError as exc:
            if str(exc) == "invalid_assessment_payload":
                return error("assessment_unavailable", 503)
            return error("invalid_pagination", 422)
        payload: dict[str, Any] = {"items": items}
        if has_more:
            payload["next_offset"] = offset + limit
        return JSONResponse(payload)

    @app.get("/api/v1/runs/{run_id}/attempts")
    def get_attempts(run_id: str) -> Response:
        if run_status(root, run_id) is None:
            return error("not_found", 404)
        engine = open_store(root)
        try:
            return JSONResponse({"items": list_active_attempts(engine, identity, run_id)})
        finally:
            engine.dispose()

    @app.post("/api/v1/runs/{run_id}/assessments", status_code=201)
    def create_assessment(run_id: str, body: AssessmentBody) -> Response:
        try:
            result = evaluate_finding(
                root,
                run_id,
                body.finding_id,
                body.provider,
                body.consent,
                body.data_classes,
                consent_actor="browser-session",
            )
        except PermissionError as exc:
            return error(str(exc), 403)
        except RunConflict as exc:
            return error(str(exc), 404)
        except (ValueError, OSError):
            return error("assessment_unavailable", 422)
        return JSONResponse(result, status_code=201)

    @app.get("/api/v1/projects/{requested}/graph")
    def graph(
        requested: str,
        limit: int = 100,
        offset: int = 0,
        run_id: str | None = None,
        node_kind: str | None = None,
        source_path: str | None = None,
    ) -> Response:
        if requested != identity:
            return error("not_found", 404)
        if not 1 <= limit <= 100 or offset < 0:
            return error("invalid_pagination", 422)
        if run_id is not None and run_status(root, run_id) is None:
            return error("not_found", 404)
        if (node_kind is not None and (not node_kind or len(node_kind) > 128)) or (
            source_path is not None and (not source_path or len(source_path) > 4096)
        ):
            return error("invalid_graph_filter", 422)
        try:
            return JSONResponse(graph_page(root, limit, offset, run_id, node_kind, source_path))
        except ValueError as exc:
            code = str(exc)
            if code not in {"invalid_graph_filter", "invalid_run_id"}:
                code = "invalid_pagination"
            return error(code, 422)

    @app.get("/api/v1/findings/{finding_id}")
    def finding(finding_id: str, run_id: str) -> Response:
        current = latest(root, run_id)
        if current:
            for item in current["findings"]:
                if item["id"] == finding_id:
                    return JSONResponse(item)
        return error("not_found", 404)

    @app.patch("/api/v1/findings/{finding_id}")
    def update_finding(finding_id: str, body: FindingLifecycleBody) -> Response:
        try:
            result = update_finding_lifecycle(
                root,
                finding_id,
                body.lifecycle_state,
                body.reason,
                body.expected_revision,
                body.actor,
                body.expiry_days,
            )
        except ValueError as exc:
            return error(str(exc), 422)
        if result is None:
            return error("finding_revision_conflict_or_not_found", 409)
        current = latest(root, result["run_id"])
        if current:
            for item in current["findings"]:
                if item["id"] == finding_id:
                    return JSONResponse(item)
        return error("not_found", 404)

    @app.get("/api/v1/runs/{run_id}/exports/{format}")
    def download(run_id: str, format: Literal["json", "html"]) -> Response:
        content = export_stored_report(root, run_id, format)
        if content is None:
            return error("not_found", 404)
        return Response(
            content,
            media_type="application/json" if format == "json" else "text/html",
            headers={"Content-Disposition": f'attachment; filename="plenger.{format}"'},
        )

    @app.post("/api/v1/runs/{run_id}/exports")
    def create_export(run_id: str, body: ExportBody) -> Response:
        content = export_stored_report(root, run_id, body.format)
        if content is None:
            return error("not_found", 404)
        return Response(
            content,
            media_type="application/json" if body.format == "json" else "text/html",
            headers={"Content-Disposition": f'attachment; filename="plenger.{body.format}"'},
        )

    @app.get("/")
    def index() -> Response:
        if not (assets / "index.html").is_file():
            return error("ui_assets_not_built", 503)
        return FileResponse(assets / "index.html")

    @app.get("/assets/{name}")
    def asset(name: str) -> Response:
        # Names produced by Vite only; no recursive or user-controlled path serving.
        if any(
            c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
            for c in name
        ):
            return error("not_found", 404)
        path = assets / "assets" / name
        if not path.is_file() or path.is_symlink():
            return error("not_found", 404)
        return FileResponse(path)

    return app
