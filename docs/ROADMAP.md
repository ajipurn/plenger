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

### M2 Agent inventory (done)

`plenger scan` reports, per project: frameworks, models and clients (model name,
base URL, where the API key comes from, never its value), LLM calls (model, client,
system prompts, tools, and the non-constant parts of their input), agents (model,
tools, prompts, graph nodes, delegates such as handoffs and crew or team members,
MCP clients, and the calls that run them with their inputs), tools (name,
description, handler, parameters, how they are declared: decorator, class, factory,
plain function, built-in, agent-as-tool, MCP or JSON schema), MCP servers (tools,
resources, prompts, transport) and clients (command or URL), prompts (fixed text,
dynamic parts, template variables, users), data stores (vector stores, embeddings,
retrievers, checkpointers) and HTTP entry points. `--json` has the full inventory
([src/inventory/model.ts](../src/inventory/model.ts)).

Detection is data: patterns over canonical call, decorator and base-class names in
[src/inventory/catalog/](../src/inventory/catalog/), with argument paths such as
`messages[role=system].content` that see through variables and constructor calls,
and optional conditions (`boto3.client("bedrock-runtime")`). Components built from a
constructor are tracked as instances, so `llm.register_tool(...)`, `@mcp.tool()`,
`@agent.tool`, `builder.add_node(...)`, `agent.invoke(...)` and `Runner.run(agent,
...)` attach to the right model, server or agent. Imports of the project's own Python
modules are never taken for a framework: a local `agents/` package is not the OpenAI
Agents SDK.

Supported, with fixtures and expected results:

- **Model SDKs:** OpenAI, Anthropic (including Bedrock and Vertex clients), Google
  GenAI (and `google.generativeai`), AWS Bedrock (boto3 and the JS SDK), LiteLLM,
  Ollama, Vercel AI SDK providers
- **Agent frameworks:** LangChain and LangGraph (Python and JS, including LangChain v1
  `create_agent`), OpenAI Agents SDK (Python and JS), CrewAI, Pydantic AI, smolagents,
  AutoGen (AgentChat and AG2), LlamaIndex, Mastra, Vercel AI SDK agents,
  [llmfy](https://llmfy.readthedocs.io/)
- **MCP:** Python SDK, FastMCP, TypeScript SDK, fastmcp (JS), LangChain MCP adapters,
  and the MCP clients of the agent frameworks above
- **Web entry points:** FastAPI, Flask, Django, Express, Hono, Fastify, Next.js

Other AI libraries (DSPy, Haystack, Semantic Kernel, Instructor, Cohere, Mistral,
Groq, Hugging Face, Agno, Strands, VoltAgent, LlamaIndex.TS and others) are reported
as "not understood yet", not dropped.

Measured on 2 October 2026: precision and recall 1.0 in every section on the fixture
corpus (`node scripts/benchmark-inventory.ts`; 25 files, 197 expected items, each
reviewed against its source). Spot checks on real code, read by hand: all 26 llmfy
examples (37 models, 47 agents, 39 LLM calls all linked to their `LLMfy` instance, 12
tools, 14 data stores), the openai-agents-python examples (149 agents, 79 tools, 13
MCP clients), the MCP TypeScript SDK (458 servers, 423 tools) and langgraphjs (220
agents, 190 tools); the samples checked were correct, and the misses seen are the
cross-file limits below.

Known limits until M3: everything is per file. A server, app or agent created in
one file and used in another (`from app.server import mcp`), or returned from a
builder function (`agent = build_agent()`), is not linked, so its tools, transport
or runs can be missing. Values derived from a parameter through a call (`(await
req.json()).messages`) are not yet marked as coming from outside.

### M3 Cross-file links and tool capabilities (done)

**Project linking** ([src/project/project.ts](../src/project/project.ts)). Imports of
the project's own modules resolve to files: Python absolute, relative and
namespace-package imports, JS/TS relative paths (with `.js` to `.ts` and index
files), CommonJS `require` and `tsconfig.json` path aliases. Refs through those
imports are rewritten to what the other file defines, so `@mcp.tool()` in `tools.py`
attaches to the `FastMCP` server created in `server.py`, a prompt constant imported
from `prompts.py` is read, and an agent returned by a builder function
(`agent = build_agent()`) is the agent its runs attach to. Detection runs in phases
over the whole project (tools, then agents, then everything that uses them).

**Capabilities** ([src/capabilities/](../src/capabilities/)). For every tool handler
and HTTP entry point, plenger follows calls into project functions, methods and
constructors (across files, six levels deep, recursion-safe) down to calls with an
outside effect, from a data catalog of sinks: process execution, code evaluation,
file reads, writes and deletes, network, databases, outbound messages, payments,
secret and environment reads, unsafe deserialization and browser automation. Each
capability carries the call chain and the non-constant parts of the effect's main
argument (command, path, URL, query), with caller arguments bound to callee
parameters at every step: `restart(service)` → `helpers.run(f"systemctl restart
{service}")` → `subprocess.run(command)` reports `service` as the command's input.
Entry points also report the models and agents they reach and with what input.
Agents roll up their tools' capabilities, their MCP servers, delegates and their own
code execution (smolagents `CodeAgent`, CrewAI `allow_code_execution`, AutoGen
`CodeExecutorAgent`, AG2 `code_execution_config`); framework built-in tools map to
known capabilities, marked `hosted` when they run at the provider.

Measured on 2 October 2026: 141 tests; the fixture corpora (frameworks and
crossfile) score precision and recall 1.0, now including capabilities and entry
point reach. On real code: the openai-agents-python examples (shell, computer,
apply-patch and hosted tools, nine agents-as-tools), the MCP TypeScript SDK (six
network tools) and langgraphjs, where it found four example calculator tools that
evaluate the model's `expression` with `Function(...)`. Peak memory stays under
260 MB on the largest repositories (about 1,200 files).

Known limits: data flow is name-based (a parameter used in an argument), not
field- or path-sensitive; effects are found through calls, so environment reads are
seen only in arguments, assignments and return values; dynamic dispatch, callbacks
passed in from other files and framework-internal effects (a vector store writing to
disk) are not followed.

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
