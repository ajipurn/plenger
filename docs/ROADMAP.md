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

### M1 Code facts

One fact model for Python and JS/TS, extracted per file:

- imports (module, imported names, aliases, `require`)
- definitions (functions, classes, methods) with decorators and exports
- calls with the callee resolved through imports where possible, and their arguments
- string and template literals (prompt candidates)
- `.gitignore` support in the walker

Done when a facts corpus passes and scans of v0 plus three public agent repositories
finish without errors.

### M2 Agent inventory

Detectors, data-driven where possible, for:

- **LLM clients:** OpenAI, Anthropic, Google GenAI, AWS Bedrock, Azure OpenAI,
  LiteLLM, Ollama
- **Agent frameworks:** LangChain and LangGraph (Python and JS), OpenAI Agents SDK
  (Python and JS), CrewAI, AutoGen/AG2, LlamaIndex, Pydantic AI, smolagents, Vercel
  AI SDK, Mastra
- **Tools:** decorators (`@tool`, `@function_tool`, `@mcp.tool`), `tool()` factories,
  hand-written tool schemas
- **MCP:** servers (Python SDK, FastMCP, TypeScript SDK) with their tools, resources
  and prompts; clients and the servers they connect to
- **Prompts, retrievers, vector stores and agent memory**
- **Entry points:** FastAPI, Flask, Django, Express, Hono and Next.js route handlers

Done when each framework has fixtures with expected inventory and measured
precision and recall. Framework usage that is imported but not understood is
reported as unrecognised, not dropped.

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
  prompt or a dangerous tool argument
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

## After triage

- **Dashboard** sharing types with the CLI.
- **Red-teaming:** black-box test cases against an agent endpoint the user runs and
  owns, planned from the triage inventory, with an explicit target allow-list.
- **Adversarial testing:** indirect prompt injection through tool outputs and
  documents, scored with canaries. Model-level attacks that need weights and PyTorch
  would run in a separate Python worker.
