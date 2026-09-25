import json
from pathlib import Path

from typer.testing import CliRunner

from plenger.cli import app
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec
from plenger.services.active import approve_for_project, plan_for_project
from plenger.services.application import project_id
from plenger.services.workspace import initialize
from plenger.storage.database import open_store


def test_plan_cli_creates_preview_without_dispatch(tmp_path):
    initialize(tmp_path)
    result = CliRunner().invoke(
        app,
        [
            "plan",
            "--project",
            str(tmp_path),
            "--target",
            "local-fixture",
            "--snapshot-digest",
            "a" * 64,
            "--cost-guard",
            "request_only",
            "--cost-acknowledged",
        ],
    )
    assert result.exit_code == 0, result.stdout
    payload = json.loads(result.stdout)
    assert payload["state"] == "draft"
    assert payload["preview"]["target_ref"] == "local-fixture"


def test_plan_cli_can_explicitly_authorize_trace_observability(tmp_path):
    initialize(tmp_path)
    result = CliRunner().invoke(
        app,
        [
            "plan",
            "--project",
            str(tmp_path),
            "--target",
            "trace-fixture",
            "--case-ids",
            "LLM06-tool-authorization",
            "--snapshot-digest",
            "a" * 64,
            "--observability",
            "trace",
            "--cost-guard",
            "request_only",
            "--cost-acknowledged",
        ],
    )
    assert result.exit_code == 0, result.stdout
    assert json.loads(result.stdout)["payload"]["target"]["observability"] == "trace"


def test_approve_cli_requires_explicit_acknowledgment(tmp_path):
    initialize(tmp_path)
    result = CliRunner().invoke(
        app,
        ["approve", "plan-id", "--project", str(tmp_path)],
    )
    assert result.exit_code == 3
    assert json.loads(result.stdout)["code"] == "authorization_acknowledgment_required"


def test_delete_storage_cli_requires_confirmation_and_deletes_private_data(tmp_path):
    initialize(tmp_path)
    engine = open_store(tmp_path)
    engine.dispose()

    rejected = CliRunner().invoke(
        app,
        [
            "delete-storage",
            "--project",
            str(tmp_path),
            "--confirm-project-id",
            "wrong-project-id",
        ],
    )
    assert rejected.exit_code == 2, rejected.stdout
    assert json.loads(rejected.stdout)["code"] == "project_storage_delete_failed"
    assert (tmp_path / ".plenger" / "state.sqlite3").exists()

    deleted = CliRunner().invoke(
        app,
        [
            "delete-storage",
            "--project",
            str(tmp_path),
            "--confirm-project-id",
            project_id(tmp_path),
        ],
    )
    assert deleted.exit_code == 0, deleted.stdout
    assert json.loads(deleted.stdout)["status"] == "deleted"
    assert not (tmp_path / ".plenger" / "state.sqlite3").exists()


def test_doctor_cli_exposes_project_id_when_capability_is_unavailable(tmp_path):
    initialize(tmp_path)

    result = CliRunner().invoke(app, ["doctor", "--project", str(tmp_path)])

    assert result.exit_code in {0, 3}, result.stdout
    assert json.loads(result.stdout)["project_id"] == project_id(tmp_path)


def test_provision_scanners_allows_explicit_osv_database_follow_up(tmp_path, monkeypatch):
    from plenger import cli as cli_module

    initialize(tmp_path)
    monkeypatch.setattr(
        cli_module,
        "provision_scanners",
        lambda project, selected, *, container, pull: {
            "engines": {
                "semgrep": {"status": "ready"},
                "osv": {"status": "unavailable", "reason": "osv_database_not_provisioned"},
            }
        },
    )

    result = CliRunner().invoke(
        app,
        [
            "provision-scanners",
            "--project",
            str(tmp_path),
            "--container",
            "--pull",
        ],
    )

    assert result.exit_code == 0, result.stdout
    assert json.loads(result.stdout)["engines"]["osv"]["reason"] == "osv_database_not_provisioned"


def test_serve_opt_in_observer_socket_is_wired_and_cleaned(tmp_path, monkeypatch):
    from plenger import cli as cli_module

    initialize(tmp_path)
    secret_path = tmp_path / "observer.key"
    secret_path.write_bytes(b"o" * 32)
    secret_path.chmod(0o600)
    captured: dict[str, object] = {}

    def fake_run(application, **kwargs):
        captured["application"] = application
        captured["kwargs"] = kwargs

    monkeypatch.setattr(cli_module.uvicorn, "run", fake_run)
    result = CliRunner().invoke(
        app,
        [
            "serve",
            "--project",
            str(tmp_path),
            "--observer-secret-file",
            str(secret_path),
        ],
    )

    assert result.exit_code == 0, result.stdout
    endpoint = json.loads(result.stdout.splitlines()[0])
    assert endpoint["observer_socket"].endswith("/observer.sock")
    assert endpoint["observer_capability"]
    assert captured["application"].state.active_observer is not None
    assert not Path(endpoint["observer_socket"]).exists()


def test_approve_cli_rejects_invalid_ttl(tmp_path):
    initialize(tmp_path)
    result = CliRunner().invoke(
        app,
        [
            "approve",
            "plan-id",
            "--project",
            str(tmp_path),
            "--ttl",
            "31m",
            "--ack-authorized",
        ],
    )
    assert result.exit_code == 2
    assert json.loads(result.stdout)["code"] == "invalid_approval_ttl"


def test_approve_cli_creates_scoped_approval_after_explicit_acknowledgment(tmp_path):
    initialize(tmp_path)
    planned = CliRunner().invoke(
        app,
        [
            "plan",
            "--project",
            str(tmp_path),
            "--target",
            "local-fixture",
            "--snapshot-digest",
            "a" * 64,
            "--cost-guard",
            "request_only",
            "--cost-acknowledged",
        ],
    )
    assert planned.exit_code == 0, planned.stdout
    plan = json.loads(planned.stdout)
    approved = CliRunner().invoke(
        app,
        [
            "approve",
            plan["id"],
            "--project",
            str(tmp_path),
            "--actor",
            "cli-user",
            "--ttl",
            "5m",
            "--ack-authorized",
        ],
    )
    assert approved.exit_code == 0, approved.stdout
    approval = json.loads(approved.stdout)
    assert approval["plan_id"] == plan["id"]
    assert approval["actor"] == "cli-user"


def test_promptfoo_import_cli_validates_without_executing_provider(tmp_path):
    source = tmp_path / "results.json"
    source.write_text(
        json.dumps(
            {
                "results": [
                    {
                        "id": "case-1",
                        "provider": "file://repository/provider.py",
                        "status": "passed",
                    }
                ]
            }
        )
    )
    result = CliRunner().invoke(app, ["import-promptfoo", str(source)])
    assert result.exit_code == 0, result.stdout
    payload = json.loads(result.stdout)
    assert payload["results"][0]["provider_ref"].startswith("file://")


def test_run_cli_reports_unavailable_active_runner_as_blocked(tmp_path, monkeypatch):
    from plenger.services import active as active_service

    initialize(tmp_path)
    plan = plan_for_project(
        tmp_path,
        PlanSpec(
            target=TargetSpec(
                target_ref="local-fixture",
                base_url="http://127.0.0.1:8080",
                environment="local",
                allowed_paths=["/test"],
                allowed_methods=["POST"],
            ),
            case_ids=["LLM01-direct-policy"],
            snapshot_digest="b" * 64,
            auth_identity="cli-user",
            budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
        ),
    )
    approval = approve_for_project(
        tmp_path,
        plan["id"],
        "cli-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    monkeypatch.setattr(
        active_service,
        "active_runner_capability",
        lambda: {"status": "unavailable", "reason": "posix_unix_socket_required"},
    )

    result = CliRunner().invoke(
        app,
        [
            "run",
            plan["id"],
            "--project",
            str(tmp_path),
            "--approval",
            approval["id"],
            "--idempotency-key",
            "cli-unavailable-runner",
        ],
    )
    assert result.exit_code == 3, result.stdout
    assert json.loads(result.stdout)["code"] == "active_runner_unavailable"


def test_run_cli_passes_opt_in_observer_to_executor(tmp_path, monkeypatch):
    from plenger import cli as cli_module

    initialize(tmp_path)
    plan = plan_for_project(
        tmp_path,
        PlanSpec(
            target=TargetSpec(
                target_ref="trace-fixture",
                base_url="http://127.0.0.1:8080",
                environment="local",
                allowed_paths=["/test"],
                allowed_methods=["POST"],
                observability="trace",
            ),
            case_ids=["LLM06-tool-authorization"],
            snapshot_digest="e" * 64,
            auth_identity="cli-user",
            budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
        ),
    )
    approval = approve_for_project(
        tmp_path,
        plan["id"],
        "cli-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    secret_path = tmp_path / "observer.key"
    secret_path.write_bytes(b"r" * 32)
    secret_path.chmod(0o600)
    captured: dict[str, object] = {}

    def fake_execute(root, run_id, *, observer=None):
        captured["root"] = root
        captured["run_id"] = run_id
        captured["observer"] = observer
        return {"run_id": run_id, "state": "completed"}

    monkeypatch.setattr(cli_module, "execute_active_run", fake_execute)
    result = CliRunner().invoke(
        app,
        [
            "run",
            plan["id"],
            "--project",
            str(tmp_path),
            "--approval",
            approval["id"],
            "--observer-secret-file",
            str(secret_path),
        ],
    )

    assert result.exit_code == 0, result.stdout
    assert json.loads(result.stdout)["state"] == "completed"
    assert captured["root"] == tmp_path
    assert captured["observer"] is not None


def test_run_cli_redacts_unexpected_runtime_error(tmp_path, monkeypatch):
    from plenger import cli as cli_module

    initialize(tmp_path)
    plan = plan_for_project(
        tmp_path,
        PlanSpec(
            target=TargetSpec(
                target_ref="local-fixture",
                base_url="http://127.0.0.1:8080",
                environment="local",
                allowed_paths=["/test"],
                allowed_methods=["POST"],
            ),
            case_ids=["LLM01-direct-policy"],
            snapshot_digest="c" * 64,
            auth_identity="cli-user",
            budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
        ),
    )
    approval = approve_for_project(
        tmp_path,
        plan["id"],
        "cli-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )

    def fail_with_sensitive_detail(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("sensitive-broker-detail")

    monkeypatch.setattr(cli_module, "execute_active_run", fail_with_sensitive_detail)
    result = CliRunner().invoke(
        app,
        [
            "run",
            plan["id"],
            "--project",
            str(tmp_path),
            "--approval",
            approval["id"],
            "--idempotency-key",
            "cli-runtime-error",
        ],
    )
    assert result.exit_code == 3, result.stdout
    assert json.loads(result.stdout)["code"] == "active_runner_failed"
    assert "sensitive-broker-detail" not in result.stdout


def test_scan_cli_redacts_unexpected_runtime_error(tmp_path, monkeypatch):
    from plenger import cli as cli_module

    initialize(tmp_path)

    def fail_with_sensitive_detail(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("sensitive-scanner-detail")

    monkeypatch.setattr(cli_module, "scan", fail_with_sensitive_detail)
    result = CliRunner().invoke(app, ["scan", "--project", str(tmp_path)])
    assert result.exit_code == 2, result.stdout
    assert json.loads(result.stdout)["code"] == "scan_failed"
    assert "sensitive-scanner-detail" not in result.stdout


def _candidate_report(severity="critical"):
    return {
        "run_id": "run",
        "state": "completed",
        "errors": [],
        "findings": [
            {
                "id": "f" * 64,
                "severity": severity,
                "validation_state": "candidate",
                "lifecycle_state": "open",
            }
        ],
    }


def test_scan_ci_warns_when_candidates_are_not_gated(tmp_path, monkeypatch):
    from plenger import cli as cli_module

    initialize(tmp_path)
    monkeypatch.setattr(cli_module, "scan", lambda *args: _candidate_report())
    runner = CliRunner()

    ignored = runner.invoke(app, ["scan", "--project", str(tmp_path), "--ci", "--fail-on", "high"])
    assert ignored.exit_code == 0
    assert "candidate_findings_not_gated" in ignored.stderr

    gated = runner.invoke(
        app,
        [
            "scan",
            "--project",
            str(tmp_path),
            "--ci",
            "--fail-on",
            "high",
            "--fail-on-candidates",
        ],
    )
    assert gated.exit_code == 1
    assert "candidate_findings_not_gated" not in gated.stderr


def test_run_cli_exits_one_when_a_fixed_case_fails(tmp_path, monkeypatch):
    from plenger import cli as cli_module

    initialize(tmp_path)
    monkeypatch.setattr(cli_module, "queue_active_run", lambda *args: ("run-id", True))
    monkeypatch.setattr(
        cli_module,
        "execute_active_run",
        lambda *args, **kwargs: {
            "run_id": "run-id",
            "state": "completed",
            "errors": [],
            "findings": [],
            "test_results": [{"case_id": "LLM02-synthetic-disclosure", "result": "fail"}],
        },
    )

    result = CliRunner().invoke(
        app, ["run", "plan-id", "--project", str(tmp_path), "--approval", "approval-id"]
    )

    assert result.exit_code == 1, result.stdout


def test_plan_cli_reports_strict_cost_guard_before_approval(tmp_path):
    initialize(tmp_path)
    result = CliRunner().invoke(
        app,
        [
            "plan",
            "--project",
            str(tmp_path),
            "--target",
            "local-fixture",
            "--snapshot-digest",
            "a" * 64,
        ],
    )
    assert result.exit_code == 2
    assert json.loads(result.stdout)["code"] == "strict_cost_guard_requires_target_control"


def test_scan_cli_uses_configured_profile_by_default(tmp_path, monkeypatch):
    from plenger import cli as cli_module

    initialize(tmp_path)
    (tmp_path / "plenger.yaml").write_text("schema_version: 1\nprofile: baseline\n")
    captured = []

    def fake_scan(project, profile, fixture):
        captured.append(profile)
        return {"run_id": "run", "state": "completed", "errors": [], "findings": []}

    monkeypatch.setattr(cli_module, "scan", fake_scan)
    runner = CliRunner()
    assert runner.invoke(app, ["scan", "--project", str(tmp_path)]).exit_code == 0
    assert (
        runner.invoke(
            app, ["scan", "--project", str(tmp_path), "--profile", "deterministic"]
        ).exit_code
        == 0
    )
    assert captured == ["baseline", "deterministic"]
