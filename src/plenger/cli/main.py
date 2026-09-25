import getpass
import json
import sqlite3
import tempfile
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, cast

import typer
import uvicorn

from plenger.adapters.promptfoo import MAX_OUTPUT_BYTES, PromptfooImportError, import_promptfoo
from plenger.adapters.python_parser import SandboxError
from plenger.api.app import DEFAULT_PORT, create_app
from plenger.api.pairing import Sessions
from plenger.domain.errors import safe_code
from plenger.evaluators.models import AssessmentError
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec
from plenger.runner.cases import FIXED_CASES
from plenger.runner.observer import (
    SignedTraceObserver,
    SignedTraceObserverSocket,
    SignedTraceSocketEndpoint,
    load_observer_secret,
)
from plenger.services.active import (
    approve_for_project,
    cancel_active_run,
    execute_active_run,
    plan_for_project,
    queue_active_run,
)
from plenger.services.application import (
    capabilities,
    ci_exit_code,
    export_stored_report,
    latest,
    project_id,
    run_status,
    scan,
    ungated_candidate_count,
)
from plenger.services.assessment import evaluate_finding
from plenger.services.scanners import provision_osv_database, provision_scanners
from plenger.services.workspace import initialize, load_config
from plenger.storage.backup import create_database_backup, restore_database_backup
from plenger.storage.locking import StoreBusy
from plenger.storage.purge import delete_project_storage
from plenger.storage.runs import RunConflict

app = typer.Typer(no_args_is_help=True, pretty_exceptions_enable=False)
Project = Annotated[Path, typer.Option(exists=True, file_okay=False)]
ObserverSecretFile = Annotated[
    Path | None,
    typer.Option(
        "--observer-secret-file",
        help="Owner-only file containing the HMAC key for an approved observer sidecar.",
    ),
]
ObserverSocket = Annotated[
    Path | None,
    typer.Option(
        "--observer-socket",
        help="Owner-only Unix socket path for the observer sidecar.",
    ),
]


@contextmanager
def _observer_session(
    secret_file: Path | None,
    socket_path: Path | None,
) -> Iterator[tuple[SignedTraceObserver | None, SignedTraceSocketEndpoint | None]]:
    if socket_path is not None and secret_file is None:
        raise ValueError("observer_secret_file_required")
    observer: SignedTraceObserver | None = None
    transport: SignedTraceObserverSocket | None = None
    runtime_directory: tempfile.TemporaryDirectory[str] | None = None
    endpoint: SignedTraceSocketEndpoint | None = None
    try:
        if secret_file is not None:
            observer = SignedTraceObserver(load_observer_secret(secret_file))
            if socket_path is None:
                runtime_directory = tempfile.TemporaryDirectory(prefix="wko-", dir="/tmp")
                socket_path = Path(runtime_directory.name) / "observer.sock"
            transport = SignedTraceObserverSocket(observer, socket_path)
            endpoint = transport.start()
        yield observer, endpoint
    finally:
        if transport is not None:
            transport.close()
        if runtime_directory is not None:
            runtime_directory.cleanup()


@app.command()
def init(path: Annotated[Path, typer.Argument(exists=True, file_okay=False)]) -> None:
    try:
        created = initialize(path)
    except (ValueError, OSError):
        typer.echo('{"code":"invalid_workspace_or_config"}')
        raise typer.Exit(3) from None
    typer.echo("Konfigurasi dibuat." if created else "Konfigurasi valid sudah ada; tidak diubah.")
    typer.echo("Tambahkan .plenger/ ke .gitignore sebelum commit (tidak diubah otomatis).")


@app.command(name="delete-storage")
def delete_storage_command(
    project: Project = Path("."),
    confirm_project_id: str = typer.Option(
        ...,
        "--confirm-project-id",
        help="Harus sama dengan project_id; hanya .plenger yang dihapus.",
    ),
) -> None:
    """Delete this project's private plenger data after exact confirmation."""

    try:
        result = delete_project_storage(project, confirm_project_id)
    except StoreBusy:
        typer.echo('{"code":"project_worker_busy"}')
        raise typer.Exit(3) from None
    except (ValueError, OSError):
        typer.echo('{"code":"project_storage_delete_failed"}')
        raise typer.Exit(2) from None
    typer.echo(json.dumps(result, indent=2))


@app.command(name="backup")
def backup_command(project: Project = Path(".")) -> None:
    """Create an offline SQLite snapshot before upgrading plenger."""

    try:
        load_config(project)
        result = create_database_backup(project)
    except StoreBusy:
        typer.echo('{"code":"project_must_be_stopped_for_backup"}')
        raise typer.Exit(3) from None
    except (ValueError, OSError, sqlite3.DatabaseError):
        typer.echo('{"code":"database_backup_failed"}')
        raise typer.Exit(2) from None
    typer.echo(json.dumps(result, indent=2))


@app.command(name="restore")
def restore_command(
    backup_id: Annotated[str, typer.Argument()],
    project: Project = Path("."),
    confirm_project_id: str = typer.Option(
        ...,
        "--confirm-project-id",
        help="Harus sama dengan project_id dari `plenger doctor`.",
    ),
) -> None:
    """Restore an offline same-project database snapshot without migrating it."""

    try:
        load_config(project)
        result = restore_database_backup(project, backup_id, confirm_project_id)
    except StoreBusy:
        typer.echo('{"code":"project_must_be_stopped_for_restore"}')
        raise typer.Exit(3) from None
    except (ValueError, OSError, sqlite3.DatabaseError):
        typer.echo('{"code":"database_restore_failed"}')
        raise typer.Exit(2) from None
    typer.echo(json.dumps(result, indent=2))


@app.command()
def doctor(project: Project = Path(".")) -> None:
    try:
        load_config(project)
    except (ValueError, OSError):
        typer.echo('{"code":"invalid_workspace_or_config"}')
        raise typer.Exit(3) from None
    result = capabilities(project)
    result["project_id"] = project_id(project)
    typer.echo(json.dumps(result, indent=2))
    if result["deterministic"]["status"] != "ready":
        raise typer.Exit(3)


@app.command(name="provision-scanners")
def provision_scanners_command(
    project: Project = Path("."),
    engines: str = typer.Option("semgrep,osv,trivy", "--engines"),
    container: bool = typer.Option(
        False,
        "--container",
        help="Gunakan digest image resmi yang dipin dan isolasi Docker untuk scanner.",
    ),
    pull: bool = typer.Option(
        False,
        "--pull",
        help="Tarik digest image resmi yang belum ada selama provisioning.",
    ),
) -> None:
    """Pin installed binaries or explicitly provision pinned scanner images."""

    try:
        selected = [item.strip() for item in engines.split(",") if item.strip()]
        if not selected or any(item not in {"semgrep", "osv", "trivy"} for item in selected):
            raise ValueError("unsupported_scanner")
        result = provision_scanners(
            project,
            selected,  # type: ignore[arg-type]
            container=container,
            pull=pull,
        )
    except (ValueError, OSError):
        typer.echo('{"code":"scanner_provisioning_failed"}')
        raise typer.Exit(3) from None
    typer.echo(json.dumps(result, indent=2))
    pending_setup = {"osv_database_not_provisioned"}
    if any(
        item.get("status") != "ready" and item.get("reason") not in pending_setup
        for item in result["engines"].values()
    ):
        raise typer.Exit(3)


@app.command(name="provision-osv-db")
def provision_osv_db_command(project: Project = Path(".")) -> None:
    """Explicitly download and fingerprint the local OSV advisory database."""

    try:
        result = provision_osv_database(project)
    except (ValueError, OSError):
        typer.echo('{"code":"osv_database_provisioning_failed"}')
        raise typer.Exit(3) from None
    typer.echo(json.dumps(result, indent=2))
    if result.get("status") != "ready":
        raise typer.Exit(3)


@app.command(name="scan")
def scan_command(
    project: Project = Path("."),
    profile: str | None = typer.Option(
        None,
        "--profile",
        help="deterministic or baseline; defaults to the profile in plenger.yaml.",
    ),
    fixture: bool = False,
    ci: bool = typer.Option(False, "--ci"),
    fail_on: str | None = typer.Option(
        None,
        "--fail-on",
        help="Severity gate (info/low/medium/high/critical) for supported/confirmed findings.",
    ),
    fail_on_candidates: bool = typer.Option(
        False,
        "--fail-on-candidates",
        help="Let the --fail-on gate count scanner/parser candidates as well.",
    ),
) -> None:
    try:
        report = scan(project, profile or load_config(project).profile, fixture)
    except StoreBusy:
        typer.echo('{"code":"project_worker_busy"}')
        raise typer.Exit(3) from None
    except SandboxError as exc:
        typer.echo(json.dumps({"code": str(exc)}))
        raise typer.Exit(3 if str(exc) == "sandbox_unavailable" else 2) from None
    except RunConflict as exc:
        typer.echo(json.dumps({"code": str(exc)}))
        raise typer.Exit(2) from None
    except RuntimeError:
        typer.echo('{"code":"scan_failed"}')
        raise typer.Exit(2) from None
    except (ValueError, OSError):
        typer.echo('{"code":"invalid_workspace_or_scan_input"}')
        raise typer.Exit(2) from None
    typer.echo(json.dumps(report, indent=2, ensure_ascii=False))
    if ci:
        try:
            code = ci_exit_code(report, fail_on, include_candidates=fail_on_candidates)
            ignored = 0 if fail_on_candidates else ungated_candidate_count(report, fail_on)
        except ValueError:
            raise typer.Exit(2) from None
        if ignored:
            # Keep stdout machine-readable; explain the gate semantics on stderr.
            typer.echo(
                json.dumps(
                    {
                        "warning": "candidate_findings_not_gated",
                        "count": ignored,
                        "hint": "use --fail-on-candidates to fail on scanner candidates",
                    }
                ),
                err=True,
            )
        if code:
            raise typer.Exit(code)
    elif report["state"] != "completed":
        raise typer.Exit(2)


def _csv(value: str, label: str) -> list[str]:
    items = [item.strip() for item in value.split(",") if item.strip()]
    if not items:
        raise ValueError(f"{label}_required")
    return items


def _approval_ttl_minutes(value: str) -> int:
    normalized = value.strip().lower()
    if normalized.endswith("m"):
        normalized = normalized[:-1]
    if not normalized.isdigit():
        raise ValueError("invalid_approval_ttl")
    minutes = int(normalized)
    if not 1 <= minutes <= 30:
        raise ValueError("invalid_approval_ttl")
    return minutes


def _latest_snapshot_digest(project: Path) -> str | None:
    report = latest(project)
    if not report:
        return None
    snapshot = report.get("snapshot")
    digest = snapshot.get("manifest_digest") if isinstance(snapshot, dict) else None
    return digest if isinstance(digest, str) else None


def _active_exit(result: dict[str, Any]) -> int:
    """Exit 1 when a fixed case observed a failure, with the shared CI precedence."""

    state = str(result.get("state", "failed"))
    if state == "cancelled":
        return 130
    if state == "blocked":
        return 3
    if state != "completed":
        return 2
    return ci_exit_code(result)


@app.command(name="plan")
def plan_command(
    project: Project = Path("."),
    target: str = typer.Option(..., "--target"),
    base_url: str | None = typer.Option(None, "--base-url"),
    environment: Literal["local", "staging"] = typer.Option("local", "--environment"),
    path: str = typer.Option("/test", "--path"),
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = typer.Option("POST", "--method"),
    observability: Literal["none", "trace"] = typer.Option("none", "--observability"),
    profile: Literal["owasp-llm-2025-core"] = typer.Option("owasp-llm-2025-core", "--profile"),
    case_ids: str = typer.Option(
        ",".join(FIXED_CASES),
        "--case-ids",
        help="Comma-separated reviewed fixed-case IDs.",
    ),
    snapshot_digest: str | None = typer.Option(None, "--snapshot-digest"),
    auth_identity: str | None = typer.Option(None, "--auth-identity"),
    data_classes: str = typer.Option("metadata,prompt,response,trace", "--data-classes"),
    max_cases: int = typer.Option(40, "--max-cases", min=1, max=40),
    max_attempts: int = typer.Option(80, "--max-attempts", min=1, max=80),
    concurrency: int = typer.Option(2, "--concurrency", min=1, max=2),
    request_timeout: int = typer.Option(30, "--request-timeout", min=1, max=30),
    wall_time: int = typer.Option(600, "--wall-time", min=1, max=600),
    cost_guard: Literal["strict", "request_only"] = typer.Option("strict", "--cost-guard"),
    cost_acknowledged: bool = typer.Option(False, "--cost-acknowledged"),
) -> None:
    """Create an immutable active-test plan; this command never dispatches."""

    try:
        selected_cases = _csv(case_ids, "case_ids")
        selected_classes = _csv(data_classes, "data_classes")
        origin = base_url or ("http://127.0.0.1:8080" if environment == "local" else None)
        if origin is None:
            raise ValueError("staging_base_url_required")
        snapshot = snapshot_digest or _latest_snapshot_digest(project)
        if snapshot is None:
            raise ValueError("snapshot_digest_required")
        plan = PlanSpec(
            target=TargetSpec(
                target_ref=target,
                base_url=origin,
                environment=environment,
                allowed_paths=_csv(path, "path"),
                allowed_methods=[method],
                observability=observability,
            ),
            profile=profile,
            case_ids=selected_cases,
            snapshot_digest=snapshot,
            auth_identity=auth_identity or getpass.getuser(),
            data_classes=cast(
                list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]],
                selected_classes,
            ),
            budget=BudgetSpec(
                max_cases=max_cases,
                max_attempts=max_attempts,
                concurrency=concurrency,
                request_timeout_seconds=request_timeout,
                wall_time_seconds=wall_time,
                cost_guard=cost_guard,
                cost_acknowledged=cost_acknowledged,
            ),
        )
        typer.echo(json.dumps(plan_for_project(project, plan), indent=2, ensure_ascii=False))
    except ValueError as exc:
        typer.echo(json.dumps({"code": safe_code(exc, "invalid_plan")}))
        raise typer.Exit(2) from None
    except OSError:
        typer.echo('{"code":"invalid_plan"}')
        raise typer.Exit(2) from None


@app.command(name="approve")
def approve_command(
    plan_id: str,
    project: Project = Path("."),
    actor: str | None = typer.Option(None, "--actor"),
    ttl: str = typer.Option("30", "--ttl", help="Approval lifetime in minutes, for example 30m."),
    ack_authorized: bool = typer.Option(False, "--ack-authorized"),
) -> None:
    """Approve one exact plan after showing its preview to the user."""

    if not ack_authorized:
        typer.echo('{"code":"authorization_acknowledgment_required"}')
        raise typer.Exit(3)
    try:
        result = approve_for_project(
            project,
            plan_id,
            actor or getpass.getuser(),
            "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            _approval_ttl_minutes(ttl),
        )
        typer.echo(json.dumps(result, indent=2, ensure_ascii=False))
    except (RunConflict, ValueError, OSError) as exc:
        typer.echo(json.dumps({"code": str(exc)}))
        raise typer.Exit(2) from None


@app.command(name="run")
def run_command(
    plan_id: str,
    project: Project = Path("."),
    approval: str = typer.Option(..., "--approval"),
    request_key: str | None = typer.Option(None, "--idempotency-key"),
    observer_secret_file: ObserverSecretFile = None,
    observer_socket: ObserverSocket = None,
) -> None:
    """Consume an approval and synchronously run the bounded fixed suite."""

    run_id: str | None = None
    try:
        with _observer_session(observer_secret_file, observer_socket) as (observer, endpoint):
            if endpoint is not None:
                typer.echo(
                    json.dumps(
                        {
                            "observer_socket": endpoint.path,
                            "observer_capability": endpoint.capability,
                        },
                        ensure_ascii=False,
                    ),
                    err=True,
                )
            run_id, created = queue_active_run(
                project, plan_id, approval, request_key or ("cli-" + uuid.uuid4().hex)
            )
            result: dict[str, Any] | None
            if created:
                result = execute_active_run(project, run_id, observer=observer)
            else:
                result = latest(project, run_id) or run_status(project, run_id)
                if result is None:
                    raise RunConflict("run_not_found")
        typer.echo(json.dumps(result, indent=2, ensure_ascii=False))
        raise typer.Exit(_active_exit(result))
    except (RunConflict, ValueError, OSError) as exc:
        typer.echo(json.dumps({"code": str(exc)}))
        raise typer.Exit(
            3 if str(exc) in {"project_worker_busy", "active_runner_unavailable"} else 2
        ) from None
    except typer.Exit:
        raise
    except RuntimeError:
        code = "active_runner_failed"
        exit_code = 3
        if run_id is not None:
            try:
                current = run_status(project, run_id)
            except (ValueError, OSError):
                current = None
            if current and current.get("state") == "failed":
                code, exit_code = "active_run_failed", 2
            elif current and current.get("state") == "blocked":
                reason = current.get("reason")
                if reason in {"active_runner_unavailable", "project_worker_busy"}:
                    code = str(reason)
        typer.echo(json.dumps({"code": code}))
        raise typer.Exit(exit_code) from None


@app.command(name="cancel")
def cancel_command(run_id: str, project: Project = Path(".")) -> None:
    """Request cancellation of an active run."""

    try:
        state = cancel_active_run(project, run_id)
        if state is None:
            typer.echo('{"code":"not_found"}')
            raise typer.Exit(2)
        typer.echo(json.dumps({"run_id": run_id, "state": state}))
        raise typer.Exit(_active_exit({"state": state}))
    except (RunConflict, ValueError, OSError) as exc:
        typer.echo(json.dumps({"code": str(exc)}))
        raise typer.Exit(2) from None


@app.command(name="evaluate")
def evaluate_command(
    run_id: str,
    project: Project = Path("."),
    provider: Literal["deterministic", "manual", "jev"] = typer.Option(
        "deterministic", "--provider"
    ),
    finding_id: str | None = typer.Option(None, "--finding"),
    allow_hosted: bool = typer.Option(False, "--allow-hosted"),
) -> None:
    """Create a separate finding assessment; it cannot change run authority."""

    try:
        report = latest(project, run_id)
        if report is None:
            raise RunConflict("run_not_found")
        ids = [finding_id] if finding_id else [item["id"] for item in report.get("findings", [])]
        results = [
            evaluate_finding(
                project,
                run_id,
                current,
                provider,
                allow_hosted,
                consent_actor="local-cli",
            )
            for current in ids
        ]
        typer.echo(json.dumps(results, indent=2, ensure_ascii=False))
    except (AssessmentError, PermissionError, RunConflict, ValueError, OSError) as exc:
        typer.echo(json.dumps({"code": str(exc)}))
        raise typer.Exit(2) from None


@app.command()
def serve(
    project: Project = Path("."),
    observer_secret_file: ObserverSecretFile = None,
    observer_socket: ObserverSocket = None,
    port: int = typer.Option(
        DEFAULT_PORT, "--port", min=1024, max=65535, help="Loopback port for the dashboard."
    ),
) -> None:
    try:
        load_config(project)
        with _observer_session(observer_secret_file, observer_socket) as (observer, endpoint):
            if endpoint is not None:
                typer.echo(
                    json.dumps(
                        {
                            "observer_socket": endpoint.path,
                            "observer_capability": endpoint.capability,
                        },
                        ensure_ascii=False,
                    )
                )
            pairing = Sessions(
                announce=lambda code: typer.echo(f"Kode pairing baru (60 detik): {code}")
            )
            typer.echo(
                f"Buka http://127.0.0.1:{port} — kode sekali pakai (60 detik): {pairing.code}"
            )
            uvicorn.run(
                create_app(project, pairing, observer, port=port),
                host="127.0.0.1",
                port=port,
                access_log=False,
                proxy_headers=False,
            )
    except StoreBusy:
        typer.echo('{"code":"project_server_busy"}')
        raise typer.Exit(3) from None
    except (ValueError, OSError):
        typer.echo('{"code":"invalid_workspace_or_config"}')
        raise typer.Exit(3) from None


@app.command(name="export")
def export_command(run_id: str, project: Project = Path("."), format: str = "json") -> None:
    try:
        content = export_stored_report(project, run_id, format)
        if content is None:
            raise ValueError("not_found")
        typer.echo(content)
    except (ValueError, OSError):
        typer.echo('{"code":"export_unavailable"}')
        raise typer.Exit(2) from None


@app.command(name="import-promptfoo")
def import_promptfoo_command(
    source: Annotated[Path, typer.Argument(exists=True, file_okay=True, dir_okay=False)],
) -> None:
    """Import bounded Promptfoo JSON as evidence; never execute its providers or config."""

    try:
        with source.open("rb") as stream:
            raw = stream.read(MAX_OUTPUT_BYTES + 1)
        if len(raw) > MAX_OUTPUT_BYTES:
            raise PromptfooImportError("promptfoo_output_too_large")
        result = import_promptfoo(raw)
    except PromptfooImportError as exc:
        typer.echo(json.dumps({"code": str(exc)}))
        raise typer.Exit(2) from None
    except OSError:
        typer.echo('{"code":"promptfoo_input_unavailable"}')
        raise typer.Exit(2) from None
    typer.echo(json.dumps(result.model_dump(), indent=2, ensure_ascii=False))
