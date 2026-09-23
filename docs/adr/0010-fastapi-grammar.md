# ADR 0010 — Conservative explicit FastAPI mapping

Status: accepted for parser python-ast-v2.

Recognize module-level `FastAPI()` / `APIRouter()` receiver bindings from direct
or aliased FastAPI imports, only when the import/receiver is not rebound. Supported
decorators: get/post/put/patch/delete/head/options with literal paths. Literal
APIRouter constructor prefixes are included, but labels explicitly say router-local;
include_router/mount topology is not resolved and no final target URL is inferred.

Map Python definitions and their lexical hierarchy. Route nodes and defines edges
carry decorator line references with observed_static provenance. This means the
syntax was observed, not that a route is reachable, authorized, or exploitable.
Unknown/dynamic receivers, path expressions, constructor kwargs, local factories,
wildcards and route methods outside this grammar remain unmapped. Agent patterns
and call graph resolution remain unfinished.

55 hand-labeled regression cases cover positive patterns, nested Python scopes,
negative lookalikes, aliases, rebindings and dynamic forms. Expected labels are
checked independently of executing/importing target code. They are an authored
regression corpus, not a statistically representative accuracy benchmark.

Official behavior references: FastAPI first steps and bigger-applications docs,
listed in SOURCES.md. No framework package is imported inside the scanner.
