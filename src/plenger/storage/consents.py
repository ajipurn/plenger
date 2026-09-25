"""Durable, project-bound hosted-consent records."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterable
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from plenger.policy.consent import normalize_data_classes
from plenger.policy.redaction import redact
from plenger.storage.runs import now


def project_config_hash(connection: Connection, project_id: str) -> str:
    value = connection.execute(
        text("SELECT config_hash FROM projects WHERE id=:project"),
        {"project": project_id},
    ).scalar_one_or_none()
    if not isinstance(value, str) or not value or value == "unknown":
        raise ValueError("project_config_hash_unavailable")
    return value


def grant_consent(
    connection: Connection,
    project_id: str,
    config_hash: str,
    provider: str,
    data_classes: Iterable[str],
    domain: str,
    actor: str,
) -> dict[str, Any]:
    classes = normalize_data_classes(data_classes)
    if not provider or len(provider) > 32 or not domain or len(domain) > 255:
        raise ValueError("invalid_consent_scope")
    if not actor or len(actor) > 128:
        raise ValueError("invalid_consent_actor")
    safe_actor = str(redact(actor))[:128]
    encoded_classes = json.dumps(classes, ensure_ascii=True, separators=(",", ":"))
    created_at = now()
    row = (
        connection.execute(
            text(
                "SELECT id FROM hosted_consents WHERE project_id=:project "
                "AND config_hash=:config AND provider=:provider "
                "AND data_classes=:classes AND domain=:domain"
            ),
            {
                "project": project_id,
                "config": config_hash,
                "provider": provider,
                "classes": encoded_classes,
                "domain": domain,
            },
        )
        .mappings()
        .first()
    )
    if row:
        identity = str(row["id"])
        connection.execute(
            text(
                "UPDATE hosted_consents SET actor=:actor,created_at=:created,revoked_at=NULL "
                "WHERE id=:id AND project_id=:project"
            ),
            {
                "actor": safe_actor,
                "created": created_at,
                "id": identity,
                "project": project_id,
            },
        )
    else:
        identity = str(uuid.uuid4())
        connection.execute(
            text(
                "INSERT INTO hosted_consents "
                "(id,project_id,config_hash,provider,data_classes,domain,actor,created_at,"
                "revoked_at) "
                "VALUES (:id,:project,:config,:provider,:classes,:domain,:actor,:created,NULL)"
            ),
            {
                "id": identity,
                "project": project_id,
                "config": config_hash,
                "provider": provider,
                "classes": encoded_classes,
                "domain": domain,
                "actor": safe_actor,
                "created": created_at,
            },
        )
    return {
        "id": identity,
        "project_id": project_id,
        "config_hash": config_hash,
        "provider": provider,
        "data_classes": list(classes),
        "domain": domain,
        "actor": safe_actor,
        "created_at": created_at,
        "revoked_at": None,
    }


def has_effective_consent(
    engine: Engine,
    project_id: str,
    config_hash: str,
    provider: str,
    data_classes: Iterable[str],
    domain: str,
) -> bool:
    classes = set(normalize_data_classes(data_classes))
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT data_classes FROM hosted_consents WHERE project_id=:project "
                "AND config_hash=:config AND provider=:provider "
                "AND domain=:domain AND revoked_at IS NULL"
            ),
            {
                "project": project_id,
                "config": config_hash,
                "provider": provider,
                "domain": domain,
            },
        ).scalars()
        for encoded in rows:
            try:
                granted = set(normalize_data_classes(json.loads(str(encoded))))
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if classes.issubset(granted):
                return True
    return False


def revoke_consent(
    connection: Connection,
    project_id: str,
    config_hash: str,
    provider: str,
    data_classes: Iterable[str],
    domain: str,
) -> bool:
    classes = set(normalize_data_classes(data_classes))
    rows = (
        connection.execute(
            text(
                "SELECT id,data_classes FROM hosted_consents WHERE project_id=:project "
                "AND config_hash=:config AND provider=:provider "
                "AND domain=:domain AND revoked_at IS NULL"
            ),
            {
                "project": project_id,
                "config": config_hash,
                "provider": provider,
                "domain": domain,
            },
        )
        .mappings()
        .all()
    )
    revoked = 0
    for row in rows:
        try:
            granted = set(normalize_data_classes(json.loads(str(row["data_classes"]))))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if classes.issubset(granted):
            changed = connection.execute(
                text("UPDATE hosted_consents SET revoked_at=:revoked WHERE id=:id"),
                {"revoked": now(), "id": row["id"]},
            )
            revoked += changed.rowcount
    return revoked > 0
