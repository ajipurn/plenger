"""Normalized graph persistence and bounded project-scoped pagination."""

import json
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from plenger.policy import redact
from plenger.storage.runs import digest


def _source_ref(item: dict[str, Any]) -> tuple[str, int]:
    source_ref = item.get("source_ref")
    if not isinstance(source_ref, dict):
        return "", 1
    path = source_ref.get("path")
    line = source_ref.get("line")
    return (
        str(path)[:2048] if isinstance(path, str) else "",
        line if isinstance(line, int) and line >= 1 else 1,
    )


def persist_graph_entities(connection: Connection, report: dict[str, Any]) -> None:
    report = cast(dict[str, Any], redact(report))
    run_id = report.get("run_id")
    project_id = report.get("project_id")
    snapshot_id = report.get("snapshot_id")
    if not all(isinstance(value, str) for value in (run_id, project_id, snapshot_id)):
        return
    for node in report.get("nodes", []):
        if not isinstance(node, dict) or not isinstance(node.get("id"), str):
            continue
        path, line = _source_ref(node)
        attributes = node.get("attributes")
        if not isinstance(attributes, dict):
            attributes = {}
        connection.execute(
            text(
                "INSERT OR IGNORE INTO graph_nodes "
                "(entity_key,run_id,project_id,snapshot_id,node_id,kind,label,source_path,"
                "source_line,provenance,attributes) "
                "VALUES (:entity,:run,:project,:snapshot,:node,:kind,:label,:path,:line,"
                ":provenance,:attributes)"
            ),
            {
                "entity": digest(["graph-node", run_id, node["id"]]),
                "run": run_id,
                "project": project_id,
                "snapshot": snapshot_id,
                "node": node["id"][:128],
                "kind": str(node.get("kind", "unknown"))[:128],
                "label": str(node.get("label", ""))[:4096],
                "path": path,
                "line": line,
                "provenance": str(node.get("provenance", "unknown"))[:64],
                "attributes": json.dumps(redact(attributes), ensure_ascii=False),
            },
        )
    for edge in report.get("edges", []):
        if not isinstance(edge, dict) or not isinstance(edge.get("id"), str):
            continue
        source = edge.get("source")
        target = edge.get("target")
        if not isinstance(source, str) or not isinstance(target, str):
            continue
        path, line = _source_ref(edge)
        connection.execute(
            text(
                "INSERT OR IGNORE INTO graph_edges "
                "(entity_key,run_id,project_id,snapshot_id,edge_id,source_id,target_id,kind,"
                "source_path,source_line,provenance) "
                "VALUES (:entity,:run,:project,:snapshot,:edge,:source,:target,:kind,:path,"
                ":line,:provenance)"
            ),
            {
                "entity": digest(["graph-edge", run_id, edge["id"]]),
                "run": run_id,
                "project": project_id,
                "snapshot": snapshot_id,
                "edge": edge["id"][:128],
                "source": source[:128],
                "target": target[:128],
                "kind": str(edge.get("kind", "unknown"))[:128],
                "path": path,
                "line": line,
                "provenance": str(edge.get("provenance", "unknown"))[:64],
            },
        )


def graph_page(
    engine: Engine,
    project_id: str,
    run_id: str,
    limit: int = 100,
    offset: int = 0,
    node_kind: str | None = None,
    source_path: str | None = None,
) -> dict[str, Any]:
    if not 1 <= limit <= 100 or offset < 0:
        raise ValueError("invalid_graph_pagination")
    if node_kind is not None and (not node_kind or len(node_kind) > 128):
        raise ValueError("invalid_graph_filter")
    if source_path is not None and (not source_path or len(source_path) > 4096):
        raise ValueError("invalid_graph_filter")
    with engine.connect() as connection:
        snapshot_id = connection.execute(
            text("SELECT id FROM snapshots WHERE project_id=:project AND run_id=:run"),
            {"project": project_id, "run": run_id},
        ).scalar_one_or_none()
        fetch_limit = limit + 1
        node_values: dict[str, Any] = {
            "project": project_id,
            "run": run_id,
            "limit": fetch_limit,
            "offset": offset,
        }
        node_filters = ""
        if node_kind is not None:
            node_filters += " AND kind=:node_kind"
            node_values["node_kind"] = node_kind
        if source_path is not None:
            node_filters += " AND source_path=:node_source_path"
            node_values["node_source_path"] = source_path
        node_rows = (
            connection.execute(
                text(
                    "SELECT node_id,kind,label,source_path,source_line,provenance,attributes "
                    "FROM graph_nodes WHERE project_id=:project AND run_id=:run "
                    f"{node_filters} "
                    "ORDER BY source_path,source_line,node_id LIMIT :limit OFFSET :offset"
                ),
                node_values,
            )
            .mappings()
            .all()
        )
        edge_values: dict[str, Any] = {
            "project": project_id,
            "run": run_id,
            "limit": fetch_limit,
            "offset": offset,
        }
        edge_filters = ""
        # Component filters describe a subgraph.  Do not return an edge whose
        # endpoint was removed by the same filter: clients should not have to
        # guess whether a relation to an invisible node is still in scope.
        if node_kind is not None or source_path is not None:
            selected_node_filters = ""
            if node_kind is not None:
                selected_node_filters += " AND kind=:edge_node_kind"
                edge_values["edge_node_kind"] = node_kind
            if source_path is not None:
                selected_node_filters += " AND source_path=:edge_node_source_path"
                edge_values["edge_node_source_path"] = source_path
            edge_filters += (
                " AND source_id IN (SELECT node_id FROM graph_nodes "
                "WHERE project_id=:project AND run_id=:run"
                f"{selected_node_filters})"
                " AND target_id IN (SELECT node_id FROM graph_nodes "
                "WHERE project_id=:project AND run_id=:run"
                f"{selected_node_filters})"
            )
        if source_path is not None:
            edge_filters += " AND source_path=:edge_source_path"
            edge_values["edge_source_path"] = source_path
        edge_rows = (
            connection.execute(
                text(
                    "SELECT edge_id,source_id,target_id,kind,source_path,source_line,provenance "
                    "FROM graph_edges WHERE project_id=:project AND run_id=:run "
                    f"{edge_filters} "
                    "ORDER BY source_path,source_line,edge_id LIMIT :limit OFFSET :offset"
                ),
                edge_values,
            )
            .mappings()
            .all()
        )
        has_more = len(node_rows) > limit or len(edge_rows) > limit
        node_rows = node_rows[:limit]
        edge_rows = edge_rows[:limit]
        nodes = []
        for row in node_rows:
            try:
                attributes = redact(json.loads(row["attributes"]))
            except (TypeError, json.JSONDecodeError):
                attributes = {}
            nodes.append(
                cast(
                    dict[str, Any],
                    redact(
                        {
                            "id": row["node_id"],
                            "kind": row["kind"],
                            "label": row["label"],
                            "source_ref": {
                                "path": row["source_path"],
                                "line": row["source_line"],
                            },
                            "provenance": row["provenance"],
                            "attributes": attributes,
                        }
                    ),
                )
            )
        edges = [
            cast(
                dict[str, Any],
                redact(
                    {
                        "id": row["edge_id"],
                        "source": row["source_id"],
                        "target": row["target_id"],
                        "kind": row["kind"],
                        "source_ref": {"path": row["source_path"], "line": row["source_line"]},
                        "provenance": row["provenance"],
                    }
                ),
            )
            for row in edge_rows
        ]
    return {
        "snapshot_id": str(snapshot_id) if snapshot_id is not None else None,
        "nodes": nodes,
        "edges": edges,
        "next_offset": offset + limit if has_more else None,
    }
