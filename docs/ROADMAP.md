# Roadmap

## Goal

For an agentic AI project in Python, JavaScript or TypeScript, help a developer or
security reviewer answer three questions quickly:

1. **What can the agent do?** Its models, tools, MCP servers, retrievers and what
   each tool can reach (shell, files, network, databases, messages).
2. **What can reach it?** HTTP routes, chat inputs, retrieved documents and tool
   outputs that end up in a prompt or a tool call.
3. **What should I look at first?** Findings ranked by severity and confidence,
   each pointing at the code that justifies it.

Triage comes first. Red-teaming and adversarial testing build on its inventory
later (see [After triage](#after-triage)).

## Principles

These come from what went wrong in v0 (on `feat/backup`), where the trust and
isolation infrastructure grew far ahead of what the tool could detect.

1. **Detection value first.** Add infrastructure (sandboxing, storage, policy) only
   when a feature needs it.
2. **Static triage never executes, imports or installs project code** and needs no
   network.
3. **Evidence or it did not happen.** Every finding cites file, line and snippet and
   states its confidence. Not finding something is reported as "not detected", never
   as "absent".
4. **Measured accuracy.** Every detector and rule has a fixture corpus with expected
   results; precision and recall are reported, not assumed.
5. **Deterministic output.** The same input gives the same JSON, apart from timing.
6. **Few dependencies.** Pinned, aged at least three days, no install scripts.

## Stack

Node.js 22.18+ and TypeScript (strict, erasable syntax only), web-tree-sitter with
vendored WASM grammars for Python, JavaScript, TypeScript and TSX, pnpm, Vitest and
Biome. One parser for all three languages keeps the tool free of native add-ons, so
it can later ship as a single binary.

## Milestones

### M0 Foundation (done)

- File walker: excludes dependency, build and cache directories and any virtualenv
  (detected by `pyvenv.cfg`); never follows symlinks; size and file-count limits.
- Parsing with the four grammars; syntax errors reported per file; type declarations
  and minified bundles skipped with a reason.
- `plenger scan [path] [--json]`.

### M1 Code facts (done)

One fact model for Python and JS/TS ([src/facts/model.ts](../src/facts/model.ts)),
extracted per file and shown by `plenger facts`:

- imports: Python `import`/`from` (relative and wildcard included), ESM default,
  named, namespace, type-only and re-exports, `require` and dynamic `import()`
- definitions: functions, methods, classes, lambdas and arrow functions, named after
  the variable or object property that holds them, with decorators (TS included),
  base classes, parameters, exports and Python docstrings
- assignments, including destructuring, linked from every name that refers to them
- calls with their arguments summarised as values (strings, f-strings and template
  literals with their interpolations, `+` concatenation, lists, dicts, nested calls,
  inline functions) and parameters marked
- call targets resolved through imports, scope-aware variables, `with ... as`,
  `self`/`this` attributes (private fields included), destructuring and call chains,
  so `self.client.messages.create` becomes `anthropic.Anthropic().messages.create`
- `.gitignore` support in the walker (`--no-gitignore` to turn it off)

Measured on 1 October 2026: 89 tests, including framework fixtures for the OpenAI
and Anthropic SDKs, LangChain/LangGraph (Python and JS), MCP (FastMCP and the
TypeScript SDK), the Vercel AI SDK, llmfy, FastAPI, Express and Next.js. Scans
without errors: v0 (40k lines), llmfy 0.11.0 (19k), the CPython 3.12 standard library
(312k), openai-agents-python (478k), the MCP TypeScript SDK (194k) and langgraphjs
(283k), at roughly 55k–95k lines per second with 80–90% of calls resolved.

Known limits: resolution is per file (imports of the project's own modules stay as
module names until M3 links files); a variable takes its nearest earlier assignment in
its own scope and the last one from an outer scope; parameters, loop variables and
tuple unpacking are not followed.

### M2 Agent inventory (first batch done)

`plenger scan` now reports, per project: frameworks, models and clients (model name,
base URL, where the API key comes from, never its value), LLM calls (model, client,
system prompts, tools, and the non-constant parts of their input), agents (model,
tools, prompts, graph nodes, the calls that run them), tools (name, description,
handler, parameters, how they are declared), MCP servers (tools, resources, prompts,
transport) and clients (command or URL), prompts (fixed text, dynamic parts, template
variables, users), data stores (vector stores, embeddings, retrievers, checkpointers)
and HTTP entry points. `--json` has the full inventory
([src/inventory/model.ts](../src/inventory/model.ts)).

Detection is data: patterns over canonical call, decorator and base-class names in
[src/inventory/catalog/](../src/inventory/catalog/), with argument paths such as
`messages[role=system].content`. Components built from a constructor are tracked as
instances, so `llm.register_tool(...)`, `@mcp.tool()`, `builder.add_node(...)` and
`agent.invoke(...)` attach to the right model, server or agent.

First batch, with fixtures and expected results: the OpenAI and Anthropic SDKs,
LangChain and LangGraph (Python and JS, including LangChain v1 `create_agent`),
MCP (Python SDK, FastMCP, TypeScript SDK, fastmcp, LangChain MCP adapters), the
Vercel AI SDK, [llmfy](https://llmfy.readthedocs.io/), FastAPI, Flask, Django,
Express, Hono, Fastify and Next.js. Libraries without detectors yet (CrewAI,
AutoGen, LlamaIndex, Pydantic AI, smolagents, LiteLLM, Google GenAI, the OpenAI
Agents SDK, Mastra and others) are reported as "not understood yet", not dropped.

Measured on 2 October 2026: precision and recall 1.0 in every section on the fixture
corpus (`node scripts/benchmark-inventory.ts`; 15 files, 102 expected items). Spot
checks on real code, read by hand: all 26 llmfy examples (37 models, 47 agents, 39
LLM calls all linked to their `LLMfy` instance, 12 tools, 14 data stores), the MCP
TypeScript SDK (458 servers, 423 tools) and langgraphjs (220 agents, 190 tools); the
samples checked were correct, and the misses seen are the cross-file limits below.

Second batch: CrewAI, AutoGen/AG2, LlamaIndex, Pydantic AI, smolagents, the OpenAI
Agents SDK (Python and JS), Mastra, Google GenAI, AWS Bedrock, LiteLLM and Ollama.

Known limits until M3: everything is per file. A server, app or agent created in
one file and used in another (`from app.server import mcp`), or returned from a
builder function (`agent = build_agent()`), is not linked, so its tools, transport
or runs can be missing. Values derived from a parameter through a call (`(await
req.json()).messages`) are not yet marked as coming from outside.

### M3 Tool capabilities

For each tool, what its body can do, following calls into the project's own
functions to a bounded depth: process execution, dynamic code evaluation, file
writes and deletes, file reads, network requests, database writes, outbound
messages (email, chat), payments and credential access. Each capability carries the
call chain from the tool to the sink.

### M4 Risk rules and triage

Rules over the inventory and capabilities, for example:

- an agent can call a tool that runs commands, evaluates code or writes files, and
  no human approval step was detected
- untrusted input (route parameters, retrieved documents, tool output) reaches a
  prompt or a dangerous tool argument, including the system prompt through template
  variables (llmfy's `{{var}}` placeholders filled by `invoke(..., var=...)`)
- a tool takes a URL or path chosen by the model with no allow-list
- an MCP server exposes a dangerous capability
- credentials in prompts or source
- agent loops with no iteration or cost limit

Each rule has an ID, severity, confidence, remediation, a mapping to the OWASP Top
10 for LLM Applications (2025) and the OWASP agentic AI guidance, and CWE IDs where
they fit. A triage score orders the findings.

### M5 Reports and CI

Terminal report, versioned JSON schema, SARIF 2.1.0 and Markdown; a baseline and
suppression file; `--fail-on` for CI; a GitHub Action.

### M6 Distribution

npm package, single binaries for macOS, Linux and Windows, user documentation.

## Risks

- **TypeScript grammar.** `tree-sitter-typescript` has had no release since 0.23.2
  (November 2024). It does not parse some TypeScript 5 type syntax (`export type *
  from`, `import("x").T[]` in type positions, `in`/`out` variance annotations).
  tree-sitter recovers around these, so runtime facts are unaffected in the files
  seen so far, but the gap will grow. Options when it matters: oxc-parser for JS/TS,
  or building the grammar from a maintained fork.

## After triage

- **Dashboard** sharing types with the CLI.
- **Red-teaming:** black-box test cases against an agent endpoint the user runs and
  owns, planned from the triage inventory, with an explicit target allow-list.
- **Adversarial testing:** indirect prompt injection through tool outputs and
  documents, scored with canaries. Model-level attacks that need weights and PyTorch
  would run in a separate Python worker.
