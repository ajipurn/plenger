"""Trusted stdlib-only parser, executed by the isolated container; never imports target code."""

import ast
import hashlib
import json
import sys
from typing import Any

MAX_INPUT = 550 * 1024 * 1024


def fastapi_receivers(tree: ast.Module) -> dict[str, tuple[str, str]]:
    """Resolve only unambiguous, module-level constructor assignments."""
    counts: dict[str, int] = {}
    aliases: dict[str, str] = {}

    class Bindings(ast.NodeVisitor):
        def bind(self, name: str) -> None:
            counts[name] = counts.get(name, 0) + 1

        def visit_Name(self, node: ast.Name) -> None:
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                self.bind(node.id)

        def visit_FunctionDef(
            self, node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef
        ) -> None:
            self.bind(node.name)  # Nested function/class bodies have separate namespaces.

        visit_AsyncFunctionDef = visit_FunctionDef
        visit_ClassDef = visit_FunctionDef

        def visit_Import(self, node: ast.Import) -> None:
            for item in node.names:
                self.bind(item.asname or item.name.split(".")[0])

        def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
            for item in node.names:
                self.bind(item.asname or item.name)

    Bindings().visit(tree)
    if "*" in counts:
        return {}
    for statement in tree.body:
        if (
            isinstance(statement, ast.ImportFrom)
            and statement.module == "fastapi"
            and not statement.level
        ):
            for item in statement.names:
                alias = item.asname or item.name
                if counts.get(alias) == 1:
                    aliases[alias] = "fastapi." + item.name
        if isinstance(statement, ast.Import):
            for item in statement.names:
                alias = item.asname or item.name
                if item.name == "fastapi" and counts.get(alias) == 1:
                    aliases[alias] = "fastapi"
    receivers: dict[str, tuple[str, str]] = {}
    value: ast.expr | None
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            target, value = statement.targets[0], statement.value
        elif isinstance(statement, ast.AnnAssign):
            target, value = statement.target, statement.value
        else:
            continue
        if (
            not isinstance(target, ast.Name)
            or counts.get(target.id) != 1
            or not isinstance(value, ast.Call)
        ):
            continue
        constructor = ""
        if isinstance(value.func, ast.Name):
            constructor = aliases.get(value.func.id, "")
        elif isinstance(value.func, ast.Attribute) and isinstance(value.func.value, ast.Name):
            constructor = aliases.get(value.func.value.id, "") + "." + value.func.attr
        if constructor not in {"fastapi.FastAPI", "fastapi.APIRouter"}:
            continue
        prefix = ""
        valid = True
        for keyword in value.keywords:
            if keyword.arg is None:
                valid = False  # **kwargs may change routing semantics.
            if keyword.arg == "prefix":
                if isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str):
                    prefix = keyword.value.value
                else:
                    valid = False
        if valid:
            receivers[target.id] = (constructor, prefix)
    return receivers


def analyze(files: dict[str, str], project_id: str) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    def identity(*parts: str) -> str:
        return hashlib.sha256("\0".join((project_id, *parts)).encode()).hexdigest()

    for path, source in sorted(files.items()):
        file_id = identity(path, "file")
        nodes.append(
            {
                "id": file_id,
                "kind": "file",
                "label": path,
                "source_ref": {"path": path, "line": 1},
                "provenance": "observed_static",
            }
        )
        try:
            tree = ast.parse(source)
        except (SyntaxError, ValueError, RecursionError):
            errors.append({"path": path, "reason": "parse_error"})
            continue

        receivers = fastapi_receivers(tree)

        imported = {
            alias.asname or alias.name.split(".")[0]: alias.name
            for statement in tree.body
            if isinstance(statement, ast.Import)
            for alias in statement.names
        }
        imported_from = {
            alias.asname or alias.name: (statement.module or "") + "." + alias.name
            for statement in tree.body
            if isinstance(statement, ast.ImportFrom) and not statement.level
            for alias in statement.names
        }

        def dotted(node: ast.AST) -> str | None:
            if isinstance(node, ast.Name):
                return node.id
            if isinstance(node, ast.Attribute):
                parent = dotted(node.value)
                return parent + "." + node.attr if parent else None
            return None

        def imported_name(
            name: str,
            imported: dict[str, str] = imported,
            imported_from: dict[str, str] = imported_from,
        ) -> str:
            if name in imported_from:
                return imported_from[name]
            head, separator, tail = name.partition(".")
            resolved_head = imported_from.get(head, imported.get(head, head))
            return resolved_head + separator + tail if separator else resolved_head

        inventory_nodes: dict[tuple[str, str, int], str] = {}
        inventory_counts: dict[tuple[str, str], int] = {}

        def add_inventory_node(
            kind: str,
            label: str,
            location: dict[str, Any],
            attributes: dict[str, str] | None = None,
            inventory_nodes: dict[tuple[str, str, int], str] = inventory_nodes,
            inventory_counts: dict[tuple[str, str], int] = inventory_counts,
            source_path: str = path,
        ) -> str:
            key = (kind, label, int(location["line"]))
            existing = inventory_nodes.get(key)
            if existing:
                return existing
            ordinal_key = (kind, label)
            ordinal = inventory_counts.get(ordinal_key, 0)
            inventory_counts[ordinal_key] = ordinal + 1
            node_id = identity(source_path, label, kind, str(location["line"]), str(ordinal))
            nodes.append(
                {
                    "id": node_id,
                    "kind": kind,
                    "label": label,
                    "source_ref": location,
                    "provenance": "observed_static",
                    "attributes": attributes or {},
                }
            )
            inventory_nodes[key] = node_id
            return node_id

        def add_inventory_edge(
            source: str, target: str, kind: str, location: dict[str, Any]
        ) -> None:
            edges.append(
                {
                    "id": identity(source, target, kind, str(location["line"])),
                    "source": source,
                    "target": target,
                    "kind": kind,
                    "source_ref": location,
                    "provenance": "observed_static",
                }
            )

        class Visitor(ast.NodeVisitor):
            def __init__(
                self, source_path: str, parent_id: str, route_receivers: dict[str, tuple[str, str]]
            ) -> None:
                self.scope: list[str] = []
                self.parent = parent_id
                self.path = source_path
                self.receivers = route_receivers
                self.occurrences: dict[str, int] = {}
                self.sinks: dict[str, int] = {}

            def visit_FunctionDef(
                self, node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef
            ) -> None:
                self.symbol(node)

            visit_AsyncFunctionDef = visit_FunctionDef
            visit_ClassDef = visit_FunctionDef

            def symbol(self, node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> None:
                qualified = ".".join([*self.scope, node.name])
                # Repeated definitions are distinct; line movement alone preserves IDs.
                ordinal = self.occurrences.get(qualified, 0)
                self.occurrences[qualified] = ordinal + 1
                node_id = identity(self.path, qualified, "symbol", str(ordinal))
                ref = {"path": self.path, "line": node.lineno}
                nodes.append(
                    {
                        "id": node_id,
                        "kind": "symbol",
                        "label": qualified,
                        "source_ref": ref,
                        "provenance": "observed_static",
                    }
                )
                edges.append(
                    {
                        "id": identity(self.parent, node_id, "defines"),
                        "source": self.parent,
                        "target": node_id,
                        "kind": "defines",
                        "source_ref": ref,
                        "provenance": "observed_static",
                    }
                )
                if not self.scope and not isinstance(node, ast.ClassDef):
                    for index, decorator in enumerate(node.decorator_list):
                        if not (
                            isinstance(decorator, ast.Call)
                            and isinstance(decorator.func, ast.Attribute)
                            and isinstance(decorator.func.value, ast.Name)
                        ):
                            continue
                        receiver = self.receivers.get(decorator.func.value.id)
                        method = decorator.func.attr.upper()
                        if receiver is None or method not in {
                            "GET",
                            "POST",
                            "PUT",
                            "PATCH",
                            "DELETE",
                            "HEAD",
                            "OPTIONS",
                        }:
                            continue
                        route = (
                            decorator.args[0]
                            if decorator.args
                            else next(
                                (k.value for k in decorator.keywords if k.arg == "path"), None
                            )
                        )
                        if not isinstance(route, ast.Constant) or not isinstance(route.value, str):
                            continue
                        label = method + " " + receiver[1] + route.value
                        if receiver[0] == "fastapi.APIRouter":
                            label += " [router-local]"
                        endpoint = identity(
                            self.path, qualified, "endpoint", str(ordinal), str(index), label
                        )
                        location = {"path": self.path, "line": decorator.lineno}
                        nodes.append(
                            {
                                "id": endpoint,
                                "kind": "endpoint",
                                "label": label,
                                "source_ref": location,
                                "provenance": "observed_static",
                            }
                        )
                        edges.append(
                            {
                                "id": identity(node_id, endpoint, "defines"),
                                "source": node_id,
                                "target": endpoint,
                                "kind": "defines",
                                "source_ref": location,
                                "provenance": "observed_static",
                            }
                        )
                parent = self.parent
                self.parent = node_id
                self.scope.append(node.name)
                self.generic_visit(node)
                self.scope.pop()
                self.parent = parent

            def visit_Call(self, node: ast.Call, imported: dict[str, str] = imported) -> None:
                # Syntactic candidate only: shadowing and data flow are not resolved.
                if isinstance(node.func, ast.Name) and node.func.id in {"eval", "exec"}:
                    rule = "WK-PY-001"
                    sink = ".".join([*self.scope, node.func.id])
                    ordinal = self.sinks.get(sink, 0)
                    self.sinks[sink] = ordinal + 1
                    fingerprint = identity(self.path, sink, rule, str(ordinal))
                    evidence_id = identity(fingerprint, str(node.lineno), "evidence")
                    findings.append(
                        {
                            "id": identity(fingerprint, str(node.lineno)),
                            "fingerprint": fingerprint,
                            "rule_id": rule,
                            "kind": "dynamic_code_execution",
                            "severity": "high",
                            "severity_source": "plenger-rule",
                            "validation_state": "candidate",
                            "lifecycle_state": "open",
                            "assessment_state": "needs_review",
                            "title": "Pemanggilan eval/exec memerlukan peninjauan",
                            "source_ref": {"path": self.path, "line": node.lineno},
                            "evidence": {
                                "id": evidence_id,
                                "source": "python-ast-v2",
                                "observed": "Syntactic call to eval/exec; data flow unknown",
                                "redaction_version": "metadata-only-v1",
                            },
                        }
                    )
                function_name = dotted(node.func)
                resolved_name = imported_name(function_name or "")
                location = {"path": self.path, "line": node.lineno}
                owner = self.parent

                # OpenAI Agents SDK inventory is only enabled for explicit imports.
                if resolved_name in {"agents.Agent", "agents.agent.Agent"}:
                    agent_label = "agent " + (self.literal_keyword(node, "name") or "anonymous")
                    agent = add_inventory_node(
                        "agent",
                        agent_label,
                        location,
                        {"framework": "openai-agents", "pattern": "Agent"},
                    )
                    for keyword in node.keywords:
                        if keyword.arg != "tools" or not isinstance(
                            keyword.value, (ast.List, ast.Tuple)
                        ):
                            continue
                        for item in keyword.value.elts:
                            tool_label = dotted(item)
                            if tool_label:
                                tool = add_inventory_node(
                                    "tool",
                                    tool_label,
                                    location,
                                    {"framework": "openai-agents", "pattern": "Agent.tools"},
                                )
                                add_inventory_edge(agent, tool, "invokes_tool", location)
                    add_inventory_edge(owner, agent, "calls", location)
                elif resolved_name in {"agents.Runner.run", "agents.Runner.run_sync"}:
                    call = add_inventory_node(
                        "llm_call",
                        resolved_name,
                        location,
                        {"framework": "openai-agents", "pattern": "Runner"},
                    )
                    add_inventory_edge(owner, call, "calls", location)
                elif resolved_name in {"openai.OpenAI", "openai.AsyncOpenAI"}:
                    client = add_inventory_node(
                        "llm_call",
                        resolved_name,
                        location,
                        {"framework": "openai", "pattern": "client_constructor"},
                    )
                    add_inventory_edge(owner, client, "calls", location)
                elif (
                    function_name
                    and function_name.endswith((".chat.completions.create", ".responses.create"))
                    and function_name.split(".", 1)[0] in imported
                ):
                    call = add_inventory_node(
                        "llm_call",
                        function_name,
                        location,
                        {"framework": "openai", "pattern": "explicit_client_call"},
                    )
                    add_inventory_edge(owner, call, "calls", location)
                elif (
                    function_name
                    and function_name.split(".", 1)[0]
                    in {
                        "retriever",
                        "vector_store",
                        "document_store",
                    }
                    and function_name.endswith((".search", ".retrieve", ".similarity_search"))
                ):
                    retriever = add_inventory_node(
                        "retriever",
                        function_name.split(".", 1)[0],
                        location,
                        {"pattern": "explicit_retriever_receiver"},
                    )
                    add_inventory_edge(owner, retriever, "retrieves_from", location)
                self.generic_visit(node)

            @staticmethod
            def literal_keyword(node: ast.Call, name: str) -> str | None:
                for keyword in node.keywords:
                    if keyword.arg == name and isinstance(keyword.value, ast.Constant):
                        return keyword.value.value if isinstance(keyword.value.value, str) else None
                return None

        Visitor(path, file_id, receivers).visit(tree)
    return {
        "nodes": nodes,
        "edges": edges,
        "findings": findings,
        "errors": errors,
        "limitations": [
            "Python definitions, explicit module-level FastAPI routes and lexical eval/exec calls",
            "Dynamic routes, router mounting, call resolution and agent mapping remain unknown",
            "No runtime reachability or exploitability claims",
        ],
    }


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        sys.exit(2)
    payload = json.loads(raw)
    print(json.dumps(analyze(payload["files"], payload["project_id"])))
