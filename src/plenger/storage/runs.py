"""Transactional static-run ledger. No target requests or approval semantics."""

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from plenger.domain import RunState, transition
from plenger.domain.digests import digest as digest
from plenger.policy import redact


class RunConflict(ValueError):
    pass


def _safe_reason(reason: str | None) -> str | None:
    return None if reason is None else str(redact(reason))[:1000]


def now() -> str:
    return datetime.now(UTC).isoformat()


def create_run(
    engine: Engine, project_id: str, profile: str, fixture: bool, config_hash: str, request_key: str
) -> tuple[str, bool]:
    request_digest = digest([profile, fixture, config_hash])
    timestamp = now()
    with engine.begin() as connection:
        # Acquire the SQLite writer reservation before reading the idempotency record.
        connection.execute(
            text("INSERT OR IGNORE INTO projects (id,created_at,content_key) VALUES (:p,:t,:k)"),
            {"p": project_id, "t": timestamp, "k": secrets.token_bytes(32)},
        )
        previous = connection.execute(
            text("SELECT id,request_digest FROM runs WHERE project_id=:p AND request_key=:k"),
            {"p": project_id, "k": request_key},
        ).first()
        if previous:
            if previous[1] != request_digest:
                raise RunConflict("idempotency_conflict")
            return previous[0], False
        pending = connection.execute(
            text("SELECT COUNT(*) FROM runs WHERE project_id=:p AND state IN ('queued','running')"),
            {"p": project_id},
        ).scalar_one()
        if pending >= 2:
            raise RunConflict("queue_capacity")
        identity = str(uuid.uuid4())
        connection.execute(
            text(
                "INSERT INTO runs "
                "(id,project_id,state,profile,fixture,config_hash,request_key,request_digest,"
                "created_at,updated_at,revision) VALUES "
                "(:id,:p,'queued',:profile,:fixture,:config,:key,:digest,:t,:t,0)"
            ),
            {
                "id": identity,
                "p": project_id,
                "profile": profile,
                "fixture": fixture,
                "config": config_hash,
                "key": request_key,
                "digest": request_digest,
                "t": timestamp,
            },
        )
        connection.execute(
            text(
                "INSERT INTO run_events (run_id,sequence,state,created_at) "
                "VALUES (:id,0,'queued',:t)"
            ),
            {"id": identity, "t": timestamp},
        )
        return identity, True


def get_run(engine: Engine, project_id: str, run_id: str) -> dict[str, Any] | None:
    with engine.connect() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT id,project_id,state,profile,fixture,config_hash,plan_id,approval_id,"
                    "cancel_requested,attempts,lease_owner,lease_expires_at,heartbeat_at,"
                    "attempt_index,reason,created_at,updated_at,revision "
                    "FROM runs WHERE id=:id AND project_id=:p"
                ),
                {"id": run_id, "p": project_id},
            )
            .mappings()
            .first()
        )
        return cast(dict[str, Any], redact(dict(row))) if row else None


def list_runs_page(
    engine: Engine, project_id: str, limit: int = 50, offset: int = 0
) -> tuple[list[dict[str, Any]], bool]:
    """Return a bounded run-history page and whether another page exists."""

    if not 1 <= limit <= 100 or offset < 0:
        raise ValueError("invalid_run_pagination")
    with engine.connect() as connection:
        rows = (
            connection.execute(
                text(
                    "SELECT id,state,profile,fixture,plan_id,approval_id,attempts,reason,"
                    "created_at,updated_at,revision "
                    "FROM runs WHERE project_id=:project "
                    "ORDER BY created_at DESC,id DESC LIMIT :query_limit OFFSET :offset"
                ),
                {"project": project_id, "query_limit": limit + 1, "offset": offset},
            )
            .mappings()
            .all()
        )
    items = [cast(dict[str, Any], redact(dict(row))) for row in rows]
    return items[:limit], len(items) > limit


def list_runs(
    engine: Engine, project_id: str, limit: int = 50, offset: int = 0
) -> list[dict[str, Any]]:
    """Return a bounded, project-scoped run history without loading reports."""

    items, _ = list_runs_page(engine, project_id, limit, offset)
    return items


def list_events(
    engine: Engine,
    project_id: str,
    run_id: str,
    after_sequence: int = -1,
    limit: int = 100,
) -> list[dict[str, Any]]:
    if after_sequence < -1 or not 1 <= limit <= 100:
        raise ValueError("invalid_event_pagination")
    with engine.connect() as connection:
        rows = (
            connection.execute(
                text(
                    "SELECT e.run_id,e.sequence,e.state,e.reason,e.created_at "
                    "FROM run_events e JOIN runs r ON r.id=e.run_id "
                    "WHERE e.run_id=:run AND r.project_id=:project "
                    "AND e.sequence>:after ORDER BY e.sequence LIMIT :limit"
                ),
                {
                    "run": run_id,
                    "project": project_id,
                    "after": after_sequence,
                    "limit": limit,
                },
            )
            .mappings()
            .all()
        )
    return [cast(dict[str, Any], redact(dict(row))) for row in rows]


def advance(
    connection: Connection,
    project_id: str,
    run_id: str,
    target: RunState,
    reason: str | None = None,
) -> None:
    row = connection.execute(
        text("SELECT state,revision FROM runs WHERE id=:id AND project_id=:p"),
        {"id": run_id, "p": project_id},
    ).first()
    if row is None:
        raise RunConflict("run_not_found")
    transition(RunState(row[0]), target)
    revision = row[1] + 1
    timestamp = now()
    update = connection.execute(
        text(
            "UPDATE runs SET state=:state,reason=:reason,revision=:new,"
            "updated_at=:t WHERE id=:id AND revision=:old"
        ),
        {
            "state": target.value,
            "reason": _safe_reason(reason),
            "new": revision,
            "t": timestamp,
            "id": run_id,
            "old": row[1],
        },
    )
    if update.rowcount != 1:
        raise RunConflict("run_revision_conflict")
    connection.execute(
        text(
            "INSERT INTO run_events (run_id,sequence,state,reason,created_at) "
            "VALUES (:id,:seq,:state,:reason,:t)"
        ),
        {
            "id": run_id,
            "seq": revision,
            "state": target.value,
            "reason": _safe_reason(reason),
            "t": timestamp,
        },
    )


def annotate_cleanup(connection: Connection, project_id: str, run_id: str) -> None:
    row = connection.execute(
        text(
            "SELECT state,revision FROM runs WHERE id=:id AND project_id=:p "
            "AND reason='orphan_cleanup_pending'"
        ),
        {"id": run_id, "p": project_id},
    ).first()
    if row is None:
        return
    timestamp = now()
    revision = row[1] + 1
    changed = connection.execute(
        text(
            "UPDATE runs SET reason='process_interrupted',revision=:new,"
            "updated_at=:t WHERE id=:id AND revision=:old"
        ),
        {"id": run_id, "old": row[1], "new": revision, "t": timestamp},
    )
    if changed.rowcount != 1:
        raise RunConflict("run_revision_conflict")
    connection.execute(
        text(
            "INSERT INTO run_events (run_id,sequence,state,reason,created_at) "
            "VALUES (:id,:seq,:state,'orphan_cleanup_completed',:t)"
        ),
        {"id": run_id, "seq": revision, "state": row[0], "t": timestamp},
    )


def recover(
    engine: Engine, project_id: str, include_queued: bool = False, cleanup_pending: bool = False
) -> int:
    # Caller must own the project worker lock; otherwise another process may be alive.
    states = "('queued','running','cancelling')" if include_queued else "('running','cancelling')"
    with engine.begin() as connection:
        rows = connection.execute(
            text("SELECT id FROM runs WHERE project_id=:p AND state IN " + states),
            {"p": project_id},
        ).all()
        for row in rows:
            advance(
                connection,
                project_id,
                row[0],
                RunState.INTERRUPTED,
                "orphan_cleanup_pending" if cleanup_pending else "process_interrupted",
            )
        return len(rows)


def project_key(engine: Engine, project_id: str) -> bytes:
    with engine.connect() as connection:
        value = connection.execute(
            text("SELECT content_key FROM projects WHERE id=:p"), {"p": project_id}
        ).scalar_one()
        return bytes(value)


def request_cancel(connection: Connection, project_id: str, run_id: str) -> str | None:
    row = connection.execute(
        text("SELECT state,profile FROM runs WHERE id=:id AND project_id=:project"),
        {"id": run_id, "project": project_id},
    ).first()
    if row is None:
        return None
    if row[1] != "active":
        raise RunConflict("cancel_not_supported_for_static_run")
    state = RunState(row[0])
    if state in {RunState.QUEUED, RunState.RUNNING}:
        advance(connection, project_id, run_id, RunState.CANCELLING, "cancel_requested")
        connection.execute(
            text("UPDATE runs SET cancel_requested=1 WHERE id=:id AND project_id=:project"),
            {"id": run_id, "project": project_id},
        )
        return RunState.CANCELLING.value
    return state.value


def update_attempts(connection: Connection, project_id: str, run_id: str, attempts: int) -> None:
    if attempts < 0:
        raise ValueError("invalid_attempt_count")
    connection.execute(
        text(
            "UPDATE runs SET attempts=:attempts,updated_at=:updated "
            "WHERE id=:id AND project_id=:project"
        ),
        {"attempts": attempts, "updated": now(), "id": run_id, "project": project_id},
    )


def claim_lease(
    connection: Connection,
    project_id: str,
    run_id: str,
    owner: str,
    ttl_seconds: int = 30,
) -> None:
    if not owner or len(owner) > 128 or not 1 <= ttl_seconds <= 600:
        raise ValueError("invalid_lease")
    current = datetime.now(UTC)
    changed = connection.execute(
        text(
            "UPDATE runs SET lease_owner=:owner,lease_expires_at=:expires,heartbeat_at=:heartbeat "
            "WHERE id=:id AND project_id=:project "
            "AND state IN ('queued','running') "
            "AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=:current "
            "OR lease_owner=:owner)"
        ),
        {
            "owner": owner,
            "expires": (current + timedelta(seconds=ttl_seconds)).isoformat(),
            "heartbeat": current.isoformat(),
            "current": current.isoformat(),
            "id": run_id,
            "project": project_id,
        },
    )
    if changed.rowcount != 1:
        raise RunConflict("lease_owned_or_run_unavailable")


def heartbeat_lease(
    connection: Connection,
    project_id: str,
    run_id: str,
    owner: str,
    ttl_seconds: int = 30,
) -> None:
    if not owner or not 1 <= ttl_seconds <= 600:
        raise ValueError("invalid_lease")
    current = datetime.now(UTC)
    changed = connection.execute(
        text(
            "UPDATE runs SET lease_expires_at=:expires,heartbeat_at=:heartbeat "
            "WHERE id=:id AND project_id=:project AND lease_owner=:owner "
            "AND state IN ('queued','running')"
        ),
        {
            "expires": (current + timedelta(seconds=ttl_seconds)).isoformat(),
            "heartbeat": current.isoformat(),
            "id": run_id,
            "project": project_id,
            "owner": owner,
        },
    )
    if changed.rowcount != 1:
        raise RunConflict("lease_not_owned")


def release_lease(connection: Connection, project_id: str, run_id: str, owner: str) -> None:
    connection.execute(
        text(
            "UPDATE runs SET lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL "
            "WHERE id=:id AND project_id=:project AND lease_owner=:owner"
        ),
        {"id": run_id, "project": project_id, "owner": owner},
    )
