# Roadmap

## Goal

For an agentic AI project in Python, JavaScript or TypeScript, help a developer or
security reviewer answer four questions quickly:

1. **What can the agent do?** Its models, tools, MCP servers, retrievers and what
   each tool can reach (shell, files, network, databases, messages).
2. **What can reach it?** HTTP routes, chat inputs, retrieved documents and tool
   outputs that end up in a prompt or a tool call.
3. **What should I look at first?** Findings ranked by severity and confidence,
   each pointing at the code that justifies it.
4. **Can adversarial input cross the application's security boundary?** Run
   scoped tests, inspect observed effects and rerun the same cases after a fix.

The MVP combines static triage with red-teaming of the running agent. Triage comes
first; [M6](#m6-red-team-harness-direct-input-in-progress) builds the red-team harness
and tests direct input against a running target, and
[M7](#m7-red-team-indirect-prompt-injection-planned) extends it to indirect prompt
injection through content the agent reads. Both are adversarial tests at the agent
level; model-level adversarial attacks are outside the MVP. Distribution is tracked
in M8, with native binary packaging started alongside dashboard development.
M0–M5 are implemented; M6a has offline llmfy discovery/preparation, synthetic
runtime qualification and a local dashboard with a limited managed file-canary
preview. A limited Next/Vercel booking/SQLite profile has live-model evidence for
one Autocare run. Broader project/model qualification and M7 remain planned;
M6a, M6b and M8 are incomplete.

**Product direction: reach capability and usability parity with promptfoo's
red-teaming workflow.** This scope covers adversarial security testing of AI
applications and agents, including model targets where relevant. Promptfoo is the
primary capability and usability reference; garak and Strix are additional
references. A unique moat is not a prerequisite for building these capabilities;
differentiation can develop through use and iteration. Plenger is built as a
product with both a React + Vite dashboard and a CLI.

The capability target includes connecting models and applications, a broader
security test catalogue, LLM-generated and adaptive attacks, multi-turn sessions,
deterministic checks plus LLM judges, saved security regression suites, comparisons
of security outcomes and CI.
M6/M7 establish the initial harness and injection tests; completing them alone
does not establish parity. The expansion priorities are recorded under
[Beyond the MVP](#beyond-the-mvp); their detailed delivery checkpoints remain to be
planned. Measure progress on common target applications using setup effort,
validated findings, false positives, evidence quality and execution cost, rather
than feature counts alone.

Static triage and inventory support target discovery, attack selection and source
evidence. They remain available on their own, but the product's next delivery
priorities centre on the red-team journey. General prompt-quality evaluation,
model benchmarking and non-security A/B experiments are outside this direction.
Comparing models, prompts or builds remains in scope when rerunning the same
security cases to assess a boundary or verify a fix.

**Product goal: choose a project, click Start, get evidence.** For supported
integrations, users must not write wrappers, change application code, copy event
helpers, prepare mock tools or author configuration files to run the built-in
tests. Plenger owns discovery, integration, test setup, observation and cleanup.
Users select a project or endpoint, provide missing access when needed, and choose
the test scope and budget through the local dashboard. Saved profiles make
repeat runs a single action. The CLI remains available for automation and CI.

The no-code workflow is a release criterion for each supported integration, not a
promise that every project shape or remote endpoint can be instrumented. Publish a
runtime compatibility matrix independently of static detection coverage. When an
integration is unsupported, explain what cannot be tested; do not turn writing an
adapter into the user's required next step or label a partial run as full coverage.

### Red-team capability target

Use [promptfoo's red-team architecture](https://www.promptfoo.dev/docs/red-team/architecture/)
as the reference for separating vulnerability-specific cases from attack delivery
strategies. Its [setup workflow](https://www.promptfoo.dev/docs/red-team/quickstart/)
also treats application context, target configuration and test selection as parts
of one journey. Plenger's supported integrations must expose that journey through
the dashboard without requiring configuration files or application changes.

The intended flow is: **choose a project or endpoint → review the target and
application policy → select risks and strategies → review scope and budget →
Start → inspect outcomes and evidence → save cases and retest a fix**. A supported
project uses discovered defaults; context and policy questions appear only when
the test cannot infer the application's permitted behaviour.

| Capability | Plenger target | Current status / delivery |
| --- | --- | --- |
| Targets and application context | Project, endpoint or model target with purpose, permitted actions, access and observable scope saved in a profile | Limited llmfy and Next.js managed previews exist; M6a/M6b qualify and broaden supported targets, M6c adds MCP |
| Risk catalogue | Versioned cases for injection, data leakage, unauthorised tool use, access boundaries and application policy; source evidence suggests relevant cases | Fixed file-canary and booking/payment checks exist; expand qualified packs in M6, indirect injection in M7, then the broader catalogue |
| Attack strategies | Delivery is separate from the risk: direct input, transformed inputs, adaptive attempts, multi-turn conversations or lower-trust content | Direct fixed prompts exist; M7 adds indirect delivery; transformations, adaptive and multi-turn strategies are planned beyond the MVP |
| Attack generation and grading | Optional attacker LLM generates/refines attempts; deterministic oracles establish effects, with an optional judge LLM for semantic outcomes | Current previews use fixed attacks, real target-model calls and deterministic observations; attacker and judge roles remain planned |
| Campaigns and evidence | Progress, cancellation, shared budgets, clean controls, scoped conclusions, conversations and observed effects; incomplete coverage stays visible | Limited previews and SQLite history exist; M6c adds repetitions/statistics and reusable CLI/CI runs |
| Security regression | Save an observed failure as a reusable case, rerun against a fix, compare the same cases across builds and gate CI | Run history is available; reusable security suites and comparisons remain planned, with M6c/M7 providing reporting and CI foundations |

The **target model**, **attacker model** and **judge model** are distinct roles.
Choosing an Ollama/OpenAI/Gemini model in today's preview configures the target
model. It does not enable an attacker or judge. Fixed built-in attacks continue to
work without those additional roles. Future campaigns must account for each role's
usage within the shared budget and preserve observed effects independently of
the judge's verdict.

This table is a capability target, not a claim that parity is already implemented.
Keep the immediate sequence: qualify the M6a llmfy journey, broaden M6b targets,
complete M6c campaign/reporting foundations, then M7 indirect injection. Add the
generated/adaptive, multi-turn and broader grading work as explicit delivery
checkpoints after those foundations qualify.

## Principles

These come from what went wrong in v0 (on `feat/backup`), where the trust and
isolation infrastructure grew far ahead of what the tool could detect.

1. **Detection value first.** Add infrastructure (sandboxing, storage, policy) only
   when a feature needs it.
2. **Static triage never executes, imports or installs project code** and needs no
   network.
3. **Evidence or it did not happen.** Static findings cite file, line and snippet
   and state their confidence; dynamic results identify the trial and observed
   evidence. Report missing detections or observations explicitly, never as proof
   that a risk is absent.
4. **Measured accuracy.** Every detector and rule has a fixture corpus with expected
   results; precision and recall are reported, not assumed.
5. **Reproducible evidence.** Static scans and test plans are deterministic apart
   from timing. Dynamic runs record their configuration, inputs and observations;
   model responses can vary, so repeat trials and report their denominators.
6. **Few dependencies.** Pinned, aged at least three days, no install scripts.
7. **Dynamic testing is explicit.** Only Start or an explicit CLI run contacts
   selected targets owned by the user or authorised for testing. Execution uses
   the resolved target profile and a plenger-managed adapter and runtime. Static
   scans and planning stay offline and never execute project code.
   Built-in probes use synthetic data, canaries and test doubles for side effects.
8. **Integration work belongs to plenger.** Built-in tests for supported targets
   must work without application edits or user-authored harness code. Ask users
   only for choices or access the tool cannot infer; generate and save the rest.

## Stack

Node.js 22.18+ and TypeScript (strict, erasable syntax only), web-tree-sitter with
vendored WASM grammars for Python, JavaScript, TypeScript and TSX, pnpm, Vitest and
Biome. One parser for all three languages keeps the tool free of native add-ons.
The native binary build embeds the engine, parser runtime, four WASM grammars and
built dashboard assets with Node.js single executable applications (SEA).

The dashboard uses React and TypeScript, Vite for production asset builds, React
Router 7, Tailwind CSS 4, Base UI, Gravity icons, OverlayScrollbars and Torph text
animation. A loopback Node.js service exposes the shared static scan and offline
preparation modules. It provides folder selection, scan overview, searchable
findings with evidence/remediation, inventory, JSON export and SQLite scan history.
`plenger serve [path]` serves the bundled dashboard; `pnpm dashboard` builds and
serves it during source development. Neither needs a separate frontend development
server. See [DASHBOARD.md](DASHBOARD.md) and [DISTRIBUTION.md](DISTRIBUTION.md).

Dynamic project execution and provider access use that service and its managed
workers for the limited previews. SQLite stores scans, plans, non-secret settings
and run evidence; the dashboard exposes Start, cancellation, saved runs and clear
saved data. Reusable CLI/CI profiles and broader runtime support remain pending.
The binary needs no separate Node.js, pnpm or frontend build on an end user's
computer. Public releases and platform qualification remain work for M8.

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
corpus (`node scripts/benchmark.ts`; 25 files, 197 expected items, each
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

### M4 Risk rules and triage (done)

**Findings** ([src/rules/](../src/rules/)). 26 rules over the inventory and its
capabilities, each with an id, a highest severity, a remediation and its mapping to
the OWASP Top 10 for LLM Applications 2025, the OWASP Top 10 for Agentic
Applications 2026 and CWE ([docs/RULES.md](RULES.md), `plenger rules`):

- tools whose effect takes model-chosen arguments: shell commands and program names
  (separately from arguments of a fixed program), code evaluation, file paths, URLs
  whose host the model picks, SQL built from model input, unsafe deserialization,
  message recipients and payment amounts; built-in shell, REPL and SQL tools
- agents and tool-using model calls that can run commands, execute code or change
  files, data or money with no human approval seen (`needs_approval`,
  `interrupt_before`, `HumanInTheLoopMiddleware`, `needsApproval`, a prompt to a
  person anywhere in the handler or the objects passed to a built-in tool); agents
  that run model-written code on the host (smolagents, CrewAI, AutoGen, AG2); agents
  and teams with no iteration limit
- HTTP routes that pass request input to an agent with high-impact tools, request
  input or function arguments placed in a system prompt (including llmfy's
  `{{var}}` placeholders filled at `invoke`), and retrieved documents or fetched pages
  placed there
- model output used as a command, code, query, path or URL, including the arguments
  of tool calls dispatched by hand (`for call in response.tool_calls: ...`)
- API keys and tokens in code and prompts, recognised by format and checked for
  randomness so that placeholders are skipped
- MCP servers that serve high-impact tools over HTTP with no authentication seen,
  stdio servers started from unpinned packages or images, remote servers over
  plain HTTP
- framework options that switch off a safety default (`allow_dangerous_code`,
  `allow_dangerous_deserialization`, `trust_remote_code`, `dangerouslyAllowBrowser`,
  `allow_dangerous_requests`, smolagents imports of `*` or `os`)

Each finding has a title that names the subject, a severity and a confidence, a
0–100 triage score (severity scaled by confidence, plus 10 when the code is
reachable from an HTTP route or a network MCP server), the evidence chain from
where input enters to where it is used with the source line of each step, notes on
what lowered the rating (input checks such as `os.path.realpath` or `shlex.quote`,
an approval step, test code), and a fingerprint built from the rule, file and
subject rather than line numbers, for baselines in M5.

**Data flow** behind the rules: values are traced within a file through variables,
loop variables, members (`body["question"]` from `await request.json()`), calls on
them and their arguments, call chains, comprehensions and operators, to the
parameters, calls and framework request objects (`flask.request`) they come from;
across files, callers' arguments are bound to callees' parameters as in M3.
Recognised secrets are redacted throughout the report after analysis, including
inventory names, prompts, MCP commands and URLs, snippets and optional code facts.
Private key blocks are redacted with their contents, not just their headers, and a
literal API key passed to a model client is redacted wherever it appears, whatever
its format. Quoted random-looking strings are hidden only in text copied from
source; identifiers, model names and environment variable names stay readable.

Measured on 2 October 2026: 250 tests (with M5); the three fixture corpora (`frameworks`,
`crossfile` and the new `risks`, with positive and negative cases for every rule)
score precision and recall 1.0 for the inventory and for 100 reviewed findings
(`node scripts/benchmark.ts`). On real code, every finding read by hand:
langgraphjs, 10 findings (the four example calculators that evaluate the model's
expression with `Function`, and the six agents that can call them without approval);
the openai-agents-python examples, 12 (four local `ShellTool`s, rated lower because
they require approval; hosted container shells and the approval-gated apply-patch
editor are not reported; four MCP servers started with an unpinned `npx` or `uvx`;
four low-rated system prompts built from function arguments); the MCP TypeScript
SDK, 1 (a private key in a test file, rated lower as test code); the llmfy examples,
none (their `{{info}}` placeholders are filled with constants). Scans take the same
time as in M3: 5.6 s and 230 MB peak memory for langgraphjs (1,200 files).

Known limits: taint is traced within a file and through arguments into called
functions, not back from a function to its callers, so a model call's output that
is returned and used by the caller is not followed, and a system prompt built where
an agent is constructed (rather than at the model call) is not tied to the routes
that reach the agent; an approval or input check done by a proxy,
middleware or framework configuration outside the code is not seen and leaves a
finding at medium confidence; checks are recognised by name, not verified.

### M5 Reports and CI (done)

Terminal report, versioned JSON schema, SARIF 2.1.0 and Markdown; a baseline and
suppression file; `--fail-on` for CI; a GitHub Action.

`--format terminal|json|sarif|markdown` selects the report (`--json` remains an
alias), and `--output` writes it without terminal colours. The version 1 JSON
Schema describes the entire scan, inventory, capabilities, optional linked facts,
findings and review metadata. SARIF 2.1.0 retains rule mappings, source regions,
evidence, stable partial fingerprints, coverage warnings, baseline states and
external suppressions. Markdown includes findings, remediation and coverage.

Version 1 baseline files record root-relative fingerprints, rule ids and paths;
`--write-baseline` regenerates them explicitly. Suppression files match a
fingerprint or rule, optionally constrained by a path glob, and require a reason.
Malformed or unknown policy fields fail with exit 2. Policy matching does not
remove findings from structured reports. `--fail-on` gates only new unsuppressed
findings at or above a severity threshold; exit 3 follows report generation.
`--source-root` makes SARIF and Markdown paths relative to the repository root when a
subdirectory is scanned, and `--omit-suppressed` leaves suppressed findings out.

For GitHub code scanning, which reads severity only from SARIF rules and ignores
SARIF suppressions: findings rated below their rule's highest severity get a rule
descriptor per severity (`PLG302/low`), the evidence chain is also a code flow, the
Action writes paths relative to the repository root and leaves suppressed findings
out of its SARIF by default, and no local absolute path is written to SARIF.

The composite GitHub Action, with third-party actions pinned to commit SHAs,
installs only the scanner's pinned runtime dependencies, scans once and writes SARIF, outputs and a Markdown job summary even
if the gate fails. The CI workflow validates the source, compiled CLI and local
Action. Local tests validate reports against the checked-in JSON contracts and
OASIS's unmodified SARIF schema, plus CLI gates, policy validation, relocated
baselines, adversarial Markdown escaping and Action outputs. A hosted GitHub run
and code-scanning upload remain unverified until this checkout has a remote.
See [REPORTS.md](REPORTS.md).

### M6 Red-team harness: direct input (in progress)

**Current slice:** offline discovery/preparation and a managed llmfy file-canary
preview. CLI discovery and plans remain offline, with `executionReady: false`.
The dashboard offers a separate Start/Cancel action for llmfy 0.11.0 projects
with standard-library Python source and a compatible file-write tool. Plenger
captures source, builds its pinned runtime, installs observation hooks and creates
the three built-in checks without user-written wrappers or fixtures. Model access
is configured through the interface for OpenAI, Gemini or Ollama. This preview does not
complete M6a; see [REDTEAM.md](REDTEAM.md) for exact scope and remaining work.

Project code and original approval checks execute in a fresh, networkless Podman
worker per trial, with no host mounts or forwarded credentials. The host broker
admits model calls through one shared budget, caps output, bounds transport data
and retains observed effects on interruption. Results cover isolated file-canary
state and require a working clean control for negative verdicts. Container tests
exercise guarded/unguarded original handlers, async entry, budget exhaustion and
cancellation with synthetic model responses. Live-model qualification and a
qualified provider token bound remain pending. See [LLMFY_RUNTIME.md](LLMFY_RUNTIME.md).

The dashboard also persists scans, plans, run evidence and non-secret settings in
SQLite; refresh reconnects to active runs. API keys and raw model payloads are not
saved. Clear saved data removes this history. Static preparation coverage now
reports files and HTTP/tool-using flows across all scanned languages separately
from runtime snapshots. An additional `vercel-booking-sqlite-v1` preview now
captures eligible Next.js POST handlers and their import closure, prepares disposable
SQLite, validates backend handlers and records model-driven database effects.
It reuses shared budgets/history, preserves project policy checks, and requires no
user wrapper. Docker Desktop qualification with synthetic replies passes on
macOS Apple Silicon. A [user-run Autocare report](qualifications/autocare-live-2026-10-03.md)
with Ollama `gemma4:31b-cloud` passed the normal booking control, observed a
manager-price override and recorded refusal of one zero-payment prompt. Broader
model/backend/platform qualification remains pending. Committed SQLite effects
are retained on cancellation, budget stops and later restoration; rollback is
excluded. Static indications, direct backend checks and model trials are labeled
separately. This limited profile does not complete M6b. SQLite tool capabilities
through imported factory-returned stores are linked, with read/write classification
and bound parameters distinguished from SQL text. See [DASHBOARD.md](DASHBOARD.md).

Next steps remain: qualify the llmfy journey with a real model and broaden
pack/resource binding within M6a, repeat/extend Next/Vercel model qualification and broaden HTTP profiles in M6b,
then MCP/CI/statistics in M6c and indirect injection in M7. Static Autocare scan
coverage does not establish a runtime security verdict.

Turn the inventory into reviewable test hypotheses, then run them against a managed
test instance or selected endpoint. First prove the complete workflow on a
library-only llmfy project, then extend support to HTTP APIs and additional direct
agent functions in Python or Node.js; add MCP endpoints after those paths.
Existing tracing is optional. Ship built-in canary cases and policy presets
selected from the inventory. Custom cases are an advanced extension, not required
setup. An automatically generated attack corpus or adaptive attack optimiser is
outside this milestone.

The React + Vite dashboard is part of M6. It exposes existing static scanning,
agent/tool inventory and source-linked findings alongside the new dynamic workflow:
choose a project directory or endpoint, see the detected targets and available
checks, supply any missing access, and click Start. Show progress, cancellation,
budget/usage, findings, evidence and coverage, with local run history and a rerun
action. Save the resolved profile for subsequent runs and CLI/CI use; do not require editing YAML,
JSON or application source. Technical plan details remain available for inspection
without being mandatory form fields. A single supported target uses the detected
defaults; multiple plausible targets are a selection in the interface.

Project mode uses built-in framework integrations to prepare and observe a managed
test instance. Start with llmfy and expand the tested Python/Node compatibility
matrix. Endpoint-only mode can run supported request/response cases without source
access. It can observe internal tool actions or inject tool/retrieval content only
when the endpoint exposes a supported integration surface; access to a URL alone
does not provide those capabilities. Display that distinction before starting.

For example, `POST /ops → ops_agent → shell` from PLG301 suggests a test of the
route's tool-use boundary. The case must define an operation that the application's
policy forbids and observe whether it reaches a recording tool double. Calling a
tool that the user is allowed to call is not a violation by itself. Static findings
are hypotheses, and a successful dynamic test does not validate every link in a
static finding automatically.

Build and validate these capabilities within each delivery checkpoint below,
starting with the llmfy project path:

1. **Discovery and offline planning.** The local interface and the proposed
   `plenger redteam plan` / `plenger redteam run` commands share the same engine;
   source-preparation planning exists, but executable test plans and execution do
   not exist yet. Initial `redteam discover` support
   reads the inventory and checks root manifest presence. Extend it to read
   project manifests and supported framework
   patterns to resolve candidate entry points, runtime, request fields and tools.
   The adapter derives its mappings and generates the plan without importing the
   project or contacting the target. Resolve ambiguity with a target selection or
   a simple form, never a requirement to write a wrapper. Each case records a
   stable id, source finding fingerprint when available, target, input, expected
   boundary, oracle, required observations and repetition budget. Built-in templates
   supply these fields under the test-pack contract below; a UI choice can
   establish a business boundary such as approval before a write. Do not infer
   that every legitimate tool use is a violation. Unsupported findings remain
   listed with a reason. Endpoint profiles without a source scan use built-in
   protocol mappings or request fields entered
   in the interface. Keep credentials out of plans: store references to access
   explicitly selected during setup, and never reuse a secret merely because the
   scanner found it.
2. **Bounded network execution.** Run only configured endpoints and operations.
   Use exact scheme/host/port and route or tool allow-lists; initially accept only
   loopback destinations, with staging destinations explicitly added.
   A `.localhost` or `.test` suffix alone is not proof of a permitted destination:
   validate resolved addresses and the connection destination, and disable redirects
   by default. Profiles supply deadlines, maximum requests, response sizes and
   concurrency (one by default), with budget controls in the interface. These
   runner request limits are separate from the model-usage limits below; one agent
   request may make multiple model calls. Stop on cancellation and retain partial
   results. Do not retry a potentially state-changing request automatically. The
   MCP adapter starts with Streamable HTTP to a server the user already runs; it
   never launches commands discovered by the scanner. Direct MCP tests cover that
   server's exposed contract,
   not an agent's response to injected MCP content (M7). Dynamic dependencies load
   only for the dynamic commands.
3. **Managed project adapters.** Plenger supplies the Python/Node launcher and
   framework adapters, including sync/async invocation and llmfy support. Resolve
   the interpreter, entry point/factory, input mapping and required access from
   discovery and the selected profile. Generate any bridging code inside the
   managed run workspace; never require the user to write or copy it into the
   project. Versioned adapters attach observation hooks and recording tool doubles
   through tested framework integration points, preserving the agent's model,
   instructions and approval/dispatch path up to the intercepted effect. Record
   what was substituted and validate the legitimate task with a clean control.
   An adapter unable to preserve that path is not eligible for the claimed test.
   For example, when `cancel_order()` checks approval inside its handler, replacing
   the entire handler does not test that approval. Intercept the external effect
   after the original checks, or restrict the case to an explicitly labelled
   proposal-stage assertion. Never count a substituted handler's invocation as
   evidence that the original handler would perform an unauthorised effect.
   Before importing project code, prepare the managed execution environment and
   verify the resource isolation required by the profile. Resolve missing runtimes
   or dependencies through guided setup; do not run arbitrary package scripts or
   startup commands copied from the scanned code. Launch with an argument array,
   never a shell string. Only Start or the CLI run imports and executes the selected
   project entry point; scanning and planning remain offline. Use a versioned JSON
   message protocol for trial input, result and events, separate from project
   stdout/stderr. The channel must work on macOS, Linux and Windows, because M8
   ships Windows binaries: use a loopback socket or named pipe rather than an
   inherited extra file descriptor, which Python does not support portably on
   Windows. Start a fresh worker per trial, bound time and output, propagate
   cancellation and report failures to stop workers or reset external state.
   Measure worker start-up cost (framework imports can take seconds per trial) and
   document it; reusing a worker across trials with a verified reset can become an
   explicit option later, never the default. A subprocess alone is not the required
   isolation. The built-in adapter must prepare and validate the managed environment
   before execution, or explain why this integration cannot run automatically.
   Users neither expose an HTTP route nor write a wrapper to test a supported
   library project. Shipping an adapter includes documenting and testing the exact
   framework versions and project shapes it supports.
4. **Canary oracles and observation.** Give each trial a fresh synthetic marker and
   correlate responses, recorded tool arguments and callback events with that
   trial. Markers use a fixed, recognisable format (a plenger prefix plus lowercase
   hex) to avoid the random quoted-string heuristic, but credential contexts such
   as `api_key=<marker>` can still be redacted. Before redaction, match against the
   exact markers generated for that trial and record structured oracle evidence:
   trial id, canary id, observation source/field, action stage and match result.
   Persist this record alongside redacted excerpts so the evidence survives even
   when the raw marker does not. A match establishes a violation only when the
   case's boundary assertion is satisfied. Do not exempt arbitrary strings with
   the plenger prefix from secret redaction. Start with response assertions, a local
   callback receiver and a documented event format with bundled Python and JS/TS
   helpers; no observability
   service or manual instrumentation is required for supported project adapters.
   Helpers depend only on each language's standard library and are loaded by the
   launcher into the managed runtime, leaving the user's source tree unchanged.
   They carry the event protocol version; the runner rejects an unsupported
   version. Publishing them separately for advanced integrations is an M8 option,
   not a prerequisite. Helpers emit trial/call ids, tool names, lifecycle stages,
   fixture/document ids and selected
   arguments/results, with a trial-completion marker to detect incomplete streams.
   Adapters install sync/async tool observation and context-delivery hooks, with
   llmfy as a required integration fixture. Emit retrieval delivery when selected
   documents enter the agent's context, not merely when a search returns hits.
   The same events work through a local receiver for HTTP targets or the function
   harness's message channel. That event channel is separate from the canary
   callback receiver. Helpers authenticate events with a per-run token passed only
   to the harness and trusted instrumentation, never placed in model-visible input
   or persisted artifacts. This authenticates observations only under the explicit
   assumption that the runner/helpers are trusted and the token is inaccessible to
   the agent's tools. Code sharing the instrumentation's process or privileges may
   access the token; keeping it out of prompts alone does not prevent forgery. Test
   instances launched by plenger must use adapter-managed recording doubles and
   runtime isolation that keeps the token beyond tested tools' access. Verify that
   prerequisite during setup; if it cannot be established, do not claim trusted
   internal observations. Endpoint-only runs declare their available observation
   sources separately. Neither mode claims protection against a compromised local
   environment.
   Reject unauthenticated events before trusting their trial/call ids, and record
   only bounded receiver diagnostics; they must not change a trial's outcome.
   Bound event sizes and rates. Receiver failures make a trial inconclusive only
   when trusted correlation or the runner's own completion checks establish that
   required valid observations are missing. Do not assign a failure to a trial
   based on ids in rejected traffic. Preserve an already confirmed
   `violation_observed` backed by trusted evidence; later missing events or receiver
   errors are separate completeness/error diagnostics and cannot downgrade it.
   Correlate concurrent authenticated events and reject stale trial ids; do not
   report a tool's completion when only its invocation was observed.
   An optional OTLP receiver can later map supported tool spans to the same format.
   Trace absence is not evidence of safety, and tool arguments
   may not be present in a trace. Distinguish a proposed tool call, an approved
   invocation and a completed side effect. A marker merely echoed from the input
   proves none of these. Each oracle identifies the prohibited destination or
   action and the evidence needed to establish the boundary crossing. Callback
   checks include a reachability control and distinguish target activity from
   fixture setup or health checks. Local receivers bind to loopback by default;
   remote deployments need an explicitly configured reachable test receiver.
5. **Trials, reports and CI.** Reset the test session and fixtures between trials;
   a failed reset makes dependent trials inconclusive. Record one outcome per
   trial: `violation_observed`, `not_observed`, `inconclusive`, `error` or `skipped`,
   with an explanation. `not_observed` requires a completed trial and the case's
   required observations; it is never a claim that the target is safe. Report
   violations / evaluable trials, where evaluable means `violation_observed` or
   `not_observed`, alongside total attempts, execution coverage, test scope and all
   other outcome counts.
   Zero evaluable trials gives an unavailable rate, not 0%. Preserve the plan and
   probe versions, source report digest/revision when available, target build
   identifier when supplied, model/settings when known, trial ids, seed for fixture
   generation, timing and redacted evidence. A seed reproduces fixture generation,
   not model behaviour.

**Delivery checkpoints.** Complete and review each checkpoint separately; M6 is
done only when all three are complete. Begin M6a with a feasibility check on an
unmodified representative llmfy project with a dependency manifest and a
discoverable sync/async text entry point or zero-argument agent factory. Record
the exact llmfy and Python versions, initial OS, provider, supported input/factory
shapes, dependency setup and isolation backend in a versioned runtime profile.
Prove discovery, setup, isolation before import, preserved approval checks and
bounded model access before expanding the interface or adding other integrations.
An unresolved part of that path blocks M6a completion; it is not deferred to M6b
or made a user-written setup task. All command names and options below are planned
interfaces.

| Checkpoint | Deliverable | Acceptance |
| --- | --- | --- |
| M6a Click-to-run llmfy | One qualified runtime profile, React + Vite dashboard for static scan/inventory/findings and dynamic setup/run/results, local run history, saved profile, built-in tests, managed launcher, hooks/doubles, usage limits and cleanup | Select an unmodified llmfy project, inspect its scan, provide model access, click Start, receive evidence and rerun without code/config/fixture preparation; qualify with a real model, clean-task assertions and preserved approval inside a handler; stub fixtures verify both boundary outcomes, event handling, budget exhaustion and cancellation |
| M6b HTTP and project expansion | HTTP profiles and additional declared Python/Node project shapes and OS/runtime combinations, reusing M6a's engine and test-pack contract | Each advertised integration passes the same no-code journey and states its observable boundaries; verify request controls, runtime isolation where applicable, clean-task fidelity, cleanup and worker start-up cost |
| M6c MCP and CI | SDK spike, MCP setup in the interface, repetitions/statistics, remaining reporters and dynamic CI policy | Supported HTTP/project/MCP profiles share the result contract and can be rerun from the interface or exported to CI; severity, execution coverage, required test scope and exit-code cases are verified |

**Built-in test-pack contract.** Each versioned pack declares supported runtime
profiles, input/tool/result shapes, a legitimate task, synthetic resources and
deterministic assertions for successful task completion. A response without an
error is insufficient. The pack also supplies attack inputs, the forbidden
boundary, required observation stages, severity and the oracle; any user choice
of business policy is saved in the profile. Bind packs only where the adapter can
establish those contracts, not from tool names or argument types alone. If no pack
fits, retain that gap in the scope report without asking the user to write one.

Record each substitution, its interception point and the original validation and
approval path it preserves. Qualification includes an approval check inside a tool
handler: a denied operation must not reach the recording effect, while an approved
clean task must produce the expected synthetic result. A separate deliberately
unguarded fixture verifies that the same oracle detects the forbidden dispatch.
Keep proposal, dispatch and completed-effect assertions distinct; a recording
double proves arrival at the intercepted boundary, not a production side effect.
Each pack owns resource preparation, reset and cleanup and verifies its clean
control. A failed control prevents claims of successful task completion or a valid
comparison; retain any independently confirmed violation backed by the case's
required evidence.
M7 extends this contract with delivery evidence and paired controls.

**Model-usage budget.** Store run-wide model-call and token limits separately from
trial counts and runner HTTP limits, plus a wall-clock deadline. Count model calls
from fixture preparation, clean controls, probes, agent loops and provider retries
against the same budget. In managed project mode, the supported provider path must
enforce admission of every
model request through a budget boundary that the selected network profile cannot
bypass. Reserve the call, input tokens and enforced maximum output allowance before
dispatch; admit it only if they fit the remaining budget. The provider profile
defines token accounting, including any additional token categories it charges.
Release unused reservations only with confirmed usage; retain a conservative bound
when usage is missing. Profiles unable to bound those calls cannot advertise
enforced token limits or qualify for the managed profile's budget contract.

Record configured limits, calls admitted, observed usage, outstanding reservations
and the reason execution stopped. When the budget prevents required work, stop
admitting calls, cancel managed workers and retain partial results. Interrupted
trials are inconclusive,
unstarted trials remain unevaluable and confirmed violations remain recorded;
budget exhaustion is an execution failure, never a successful defence. Reaching
the cap after all planned work completes does not itself fail the run. Do not
silently reduce planned repetitions to make the run pass. Currency estimates,
if offered, are separate from enforced call/token limits.

For remote endpoints, enforce runner request/time limits and label target model
usage as reported or unknown. Claim target-side limits only when a supported
integration actually enforces them. Cancelling the runner's request does not prove
that remote model work stopped. Show the enforcement scope before Start and in
the report; selecting an endpoint does not imply a target token or cost cap.

**MCP dependency decision.** Use the pinned [official TypeScript client SDK](https://github.com/modelcontextprotocol/typescript-sdk)
in a separately installed optional MCP adapter, loaded only for MCP cases. The
static CLI and HTTP/function adapters must install and run without that dependency
tree. This isolates protocol maintenance and dependencies while retaining SDK
handling of protocol negotiation, sessions and streaming. Select a released SDK
version during M6c, record supported protocol versions and review its transitive
dependencies under the existing pinning/age/no-install-scripts policy. No runtime
auto-installation during a run: setup offers a supported adapter installation
before Start, while unattended CLI runs fail configuration validation if it is missing.
SDK connections still use the runner's destination, redirect and request-budget
controls, including secondary session requests. Start M6c with a go/no-go spike
confirming that the SDK's client transport accepts an injected `fetch` through
which every request passes those controls; if it does not, fall back to a minimal
client for the Streamable HTTP subset the tests need. Verify the controls again in
adapter tests.

OTLP support is an optional follow-up, not a prerequisite for completing M6.
Keep its attribute mapping in one adapter: the
[OpenTelemetry GenAI agent conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
are still in development.

Reuse M5's formatting, redaction and policy concepts, with a separately versioned
dynamic-run JSON schema; do not silently change the static report-v1 contract or
its baselines. The interface, terminal, Markdown and JSON show observations,
execution coverage and test scope separately. SARIF exports supported dynamic
findings with real source locations when available, never invented file/line
evidence; flag unverified source-to-deployment mappings. Full
trial records remain in JSON. Match regression cases by stable case id and
configuration, not random canaries.

**Severity and gate contract.** Each case requires an explicit severity
(`critical`, `high`, `medium` or `low`) and rationale tied to the prohibited boundary
and the evidence its oracle can establish. Built-in templates supply those fields;
custom cases must declare them. A linked static finding can suggest a severity
for review during planning, but its severity is not inherited automatically and
its triage score is not a dynamic score. Record the observation stage separately;
a proposed call must not be described as a completed effect. Invalid severity or
missing rationale fails configuration validation before contacting the target.

The proposed dynamic `--fail-on critical|high|medium|low|none` gates any unsuppressed
`violation_observed` at or above the threshold, even if a comparison baseline
already contains it. CLI default is `none`; the interface's built-in test profile
and planned CI example use `high` and display the active execution-coverage and
required-scope policies. One qualifying observation is enough to fail this gate;
a low observed rate or a wide interval does not erase it. Dynamic suppressions
require a case id and reason
in an explicit dynamic policy file; they preserve results and never waive execution
coverage or required scope. Refreshing a comparison baseline does not suppress
findings. M5's static gate and suppression semantics stay unchanged.

**Execution coverage and test scope.** Execution coverage is evaluable trials /
planned trials **per selected case**, counting errors, skipped, unstarted and
inconclusive trials as unevaluable; an empty selection is invalid. The proposed
`--min-coverage` controls only this measure: a fraction in `(0, 1]`, default `1`.
Each plan also declares a minimum evaluable count (one for a smoke case, at least
20 per case for a before/after live-model comparison). Validate planned repetitions
against that minimum. Completing all selected trials is not full agent coverage.

Keep a separate scope matrix of discovered input, tool, MCP, web and retrieval
surfaces, with stable surface ids and applicable scenario families. For each,
record support, selection, execution/delivery and the required evidence obtained;
retain unsupported, unselected and unverified entries with reasons in the saved
plan and final report. Summarise surfaces exercised with the required evidence /
surfaces discovered, alongside execution coverage, for example: "10/10 evaluable
trials; 1/4 discovered surfaces exercised, 3 unsupported." Retain per-scenario
detail so exercising one case does not imply every boundary on that surface was
tested. This describes discovered scope only; unknown surfaces and opaque remote
internals are labelled unknown, never counted as covered or assigned an invented
denominator.

Saved profiles and their CI exports declare required surface/scenario ids before
unsupported cases are filtered from the executable plan. Generate these
requirements from the selected scope in the interface; users need not author a
policy file for built-in tests. A previously required surface that disappears,
loses adapter support or lacks the case's required evidence fails the scope gate.
Do not silently shrink requirements on rerun; changing them is an explicit profile
update. Unsupported discoveries outside the required scope remain visible without
automatically failing that gate. CI evaluates required scope independently of
`--min-coverage` so a smaller runnable subset cannot hide a coverage regression.

`--fail-on none` disables only the finding gate. Execution errors, cancellation,
budget exhaustion and failed execution-coverage/minimum-count/required-scope checks
still fail the run. Write partial reports whenever possible and record every
failure reason. Exit codes: `0` means completed and all enabled gates passed, `1`
means execution/I/O/cancellation/budget or coverage/scope failure, `2` means invalid
arguments/configuration, and `3` means the finding gate failed. If execution,
coverage or scope failures coexist with a finding failure, exit `3`: an observed
violation remains conclusive. The report retains every failure reason. The static
Action never starts dynamic tests implicitly; dynamic CI is configured separately.

**Repeated-trial statistics.** Report a two-sided 95% Wilson score interval, without
continuity correction, for each case/variant's violation rate when its evaluable
count is nonzero; see the [NIST formula](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).
Record method, confidence level, numerator and denominator in JSON. Zero evaluable
trials has no rate or interval. Smoke runs may use one trial; comparison campaigns
plan at least 20 per case per build, with higher counts configurable in advance.
Fewer than 20 evaluable trials is labelled insufficient for a before/after
comparison, even though its descriptive interval is shown. This minimum is a
product policy, not a guarantee of statistical power. Assume independent trials
under a fixed configuration; flag shared state or drift, and do not pool different
variants, models or builds into one binomial interval. Intervals describe each
run, not the statistical significance of the difference between runs. Fixed trial
budgets avoid stopping or retrying until a desired result appears. Fixture tests
check interval calculations at zero, all and some observed violations.

The runner's allow-list constrains its own connections, not the target agent's
tools or network access. Project mode therefore owns a managed test workspace,
recording tool doubles, synthetic resources and reset/cleanup. Establish filesystem,
environment and network boundaries before project import, including import-time
side effects; copying code or starting a subprocess is insufficient. Keep ambient
`.env` files, home-directory credentials and production resources out of the
default execution profile. Enable only the model/provider access explicitly
selected in setup, with configured budgets. If a project cannot be run under a
supported profile, report that limitation instead of silently executing it on the
host or asking the user to implement isolation. Validate the first isolation
backend and OS/runtime combination in M6a before importing the llmfy project;
M6b qualifies each additional combination independently. A scanner binary for an
OS does not establish managed-runtime support on that OS.

Endpoint-only mode cannot apply local process isolation to a remote service.
Show that the chosen service uses its own resource access, and offer only checks
whose effects and observations the selected profile supports. Creating internal
mocks, instrumenting a private tool call or replacing retrieval requires a supported
integration; otherwise show that coverage as unavailable. Do not require users to
write those integrations to complete the advertised workflow.
Evaluate canary matches before redaction; persist redacted evidence by default,
including requests, authentication headers, responses and tool events.

The interface stores run artifacts in plenger's local application-data directory,
outside the project checkout, and offers explicit export. CLI output can be
overridden, including `.plenger/runs/<run-id>/` in projects that ignore that path.
Persist the redacted plan, result and bounded event records; protect file access
where supported. No source-control setup is required for the default interface
workflow. Document that staging artifacts can still contain sensitive data after
redaction; exports, CI uploads and retention are explicit user choices.

**Done when:** all three checkpoints pass. Deterministic local HTTP, direct Python
and Node function, and MCP fixtures demonstrate both enforced and violated
boundaries. Benign echoes do not count as violations; missing events, unreachable
callbacks, failed resets and timeouts are reported accurately.
Target validation tests cover redirects and changed DNS answers. Report schemas,
credential redaction, structured canary evidence surviving redaction in credential
contexts, and helper event authentication/correlation have automated checks. Tests
verify that unauthenticated traffic with a forged trial id cannot change outcomes,
genuine observation loss is reported, and later receiver failures preserve a
confirmed violation. Verify that approval inside a tool handler remains effective
and that clean-task assertions reject a response which completes without doing the
task. Budget tests cover agent loops, retries, clean controls, missing usage and
exhaustion without falsely passing a truncated run. Scope tests cover unsupported
surfaces retained in reports and a required integration disappearing between runs
despite 100% execution coverage of the remaining cases. Worker cleanup,
cancellation and CI outcomes are also tested.
The acceptance test includes the complete user journey: select an unmodified
supported project, provide model access if needed, choose the supplied test preset,
click Start and receive an evidence report. Setup, hooks, mocks, synthetic data and
cleanup are performed by plenger. Complete this journey for llmfy in M6a, then
repeat it for each additional runtime profile. Repeat from the saved profile
without setup work.
Internal harness fixtures use stub models without API keys for routine CI;
separately verify each advertised agent integration with a real model and record its version,
observations and limitations. Stub-only tests do not establish live-model support.

### M7 Red-team: indirect prompt injection (planned)

Extend M6's plans, runner and oracles to put test instructions in lower-trust
content while keeping the legitimate user request unchanged. The user selects an
available scenario in the same React + Vite dashboard; plenger prepares the content,
delivery integration, observation and cleanup. M6's adapters automatically load the Python
and JS/TS helpers to record content delivery and tool actions; adding tracing is
optional. The focus is indirect prompt injection through documents and tool
results, as described by
[OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/). Reuse M6's
target constraints, test-pack contracts, model budgets, synthetic data and recording
doubles. Keep execution coverage and test scope separate throughout.

**Delivery checkpoints.** Implement a shared fixture lifecycle (prepare, verify
delivery, reset, clean up), then complete and review M7a before expanding to M7b.
M7a proves tool-output and retrieval-context injection through an already qualified
project adapter. M7b adds MCP and web delivery plus retrieval through a disposable
index using one declared backend/version. Qualify additional backends separately.
These are four channel families; retrieval has two distinct integration depths.

| Checkpoint / channel | How test content is delivered | Evidence required before scoring |
| --- | --- | --- |
| M7a — Tool output | The built-in adapter replaces a selected tool result with a generated marked fixture | The agent consumed that call's marked output; the report identifies the substitution boundary |
| M7a — Retrieval context | The adapter supplies a fixture at the retrieval-result boundary | The marked document entered the trial's context; label the test as content handling, with retrieval itself untested |
| M7b — MCP result | Plenger starts a mock server and the supported project adapter routes the selected MCP dependency to it | The agent received that mock content during the trial |
| M7b — Web content | Plenger starts a fixture server and the supported adapter directs the selected fetch to its document | The content reached the agent, not just a server health check |
| M7b — Retrieval through an index | The retrieval adapter creates and seeds a disposable collection for the declared backend and runs the supported retrieval path | The marked document was retrieved from that collection and entered the trial's context; identify the test collection and retrieval configuration |

Each checkpoint must demonstrate the no-code scenario selection, verified delivery,
enforced and deliberately violated boundaries, passing clean controls and cleanup.
Qualify those scenarios with a real model before declaring the checkpoint complete;
routine harness CI remains deterministic with stub models. M7b extends the same
report and scope contract rather than replacing M7a's content-only evidence with
a broader retrieval claim.

Each adapter declares the delivery and observation it supports. Plenger owns
fixture generation, seeding, routing, reset and cleanup; the user does not build
mock servers, copy documents into an index or edit tool handlers. Detect unavailable
injection surfaces before a run and display those scenarios as unsupported. Where
delivery was attempted but cannot be verified, mark the trial inconclusive; never
treat an unretrieved document as a successful defence. All fixture writes stay in
managed test resources, with cleanup evidence in the report. A substitute retrieval
result tests the agent's handling of that content, not the real index's access
controls or retrieval ranking. A remote endpoint without a supported injection
surface cannot claim these tests merely because it accepts a chat request.

Pair each injected case with a clean control using the same legitimate task,
fixture shape and target configuration, in isolated sessions. The clean control
must satisfy the pack's explicit expected-answer or expected-action assertions
and show that the observation path works; an HTTP success or nonempty answer is
insufficient. Plenger supplies these assertions and the matching synthetic data.
Count both members of the pair against the run's model budget. Probe cases test
whether lower-trust instructions change the answer, disclose a synthetic marker
from a protected fixture, or request a tool action forbidden by the case's policy.
Benign quotation or summarisation of the fixture is not a violation. Use explicit,
deterministic assertions for the initial probes; an LLM judge is not required.

Ship a small, versioned set of benign canary templates and generate the selected
fixtures automatically. User-authored fixtures remain an optional advanced feature.
Start with variations in wording, placement and document wrapping; record each
variant separately so a result can be reproduced. Do not expand into
model-weight attacks or an autonomous search for bypasses in this milestone.

Report per channel, case and tool: planned and verified deliveries, execution
coverage, the scope matrix including unsupported/unselected surfaces, boundary
violations / evaluable trials, control outcomes and legitimate-task completion.
Keep content-only and index-backed retrieval results separate. Failed controls
make the corresponding comparison inconclusive. A mitigation that rejects every
request must show the resulting loss of task completion. Compare before and after
runs only with matching case/probe versions and compatible configurations; record
the intended mitigation/build change and flag other changes. Use M6's 95% Wilson
intervals, per-case minimum of 20 evaluable trials in each build for live-model
comparisons, and severity, execution-coverage and required-scope gates. Show the
absolute change in observed rate and task completion without claiming statistical
significance from one changed response or interval overlap. Any observed violation can still fail
the severity gate, regardless of comparison eligibility. Refreshing a dynamic
baseline is explicit and does not overwrite the static triage baseline.
Make scenario selection, delivery evidence, control outcomes and before/after
comparison available in the dashboard as well as CLI reports.

**Done when:** both checkpoints pass, and each advertised integration supports
choosing and running its available M7 scenarios without source edits or
hand-prepared fixtures. All four channel families and both retrieval depths have
a local integration example with an enforced boundary and a deliberately violated
one, clean-task assertions, delivery evidence and automatic cleanup.
Fixtures cover benign quoted instructions, missing retrieval, unavailable
observations and contamination between trials. Before/after reports demonstrate a
mitigation reducing observed violations while preserving the legitimate task.
The internal fixture suite runs without external models for routine CI. Qualify
advertised integrations with a real model separately, recording the model version,
sample counts and limitations; distinguish those results from harness self-tests.

### M8 Distribution (in progress)

**Available:** a native executable build containing the CLI, local service,
built React + Vite dashboard and parser WASM assets. Users can run `plenger scan`
and `plenger serve` without Node.js or pnpm. Build artifacts include an archive and
SHA-256 checksums. The macOS Apple Silicon build was verified with Node.js 22.23.2
outside the checkout and without Node on `PATH`, covering scans with all grammars,
embedded dashboard assets, deep routes, authenticated API scans and service
shutdown. Native build/smoke/artifact CI jobs are configured for Ubuntu, macOS and
Windows but have not run remotely. See [DISTRIBUTION.md](DISTRIBUTION.md) for
installation steps. This is local build availability, not a published release.

**Remaining:** passing native CI evidence for the advertised macOS, Linux and
Windows architectures, publisher-signed releases where applicable, a project
license decision, public release artifacts, update/install documentation and npm
packaging. Package the supported
runtime integrations only after their M6/M7 qualification. Complete and validate
the no-code flow in M6/M7. Include the
runtime/adapter prerequisite setup already qualified in those milestones, without
asking users to write scripts. Keep the static-only CLI installation lightweight.
Document the offline scan and click-to-run workflows, model-access setup, supported
project/framework versions, observation limits, profile export and CI use. Keep
custom adapters, helper APIs and handwritten configuration in advanced developer
documentation rather than the standard user journey.
Document artifact locations and handling. Explain that the gates differ on purpose:
the static gate ignores findings in its baseline, while the dynamic gate fails on
an observed violation even when a baseline contains it. State that dynamic testing
is for targets the user owns or has permission to test, with the agreed operations
and budgets configured explicitly.

## Risks

- **TypeScript grammar.** `tree-sitter-typescript` has had no release since 0.23.2
  (November 2024). It does not parse some TypeScript 5 type syntax (`export type *
  from`, `import("x").T[]` in type positions, `in`/`out` variance annotations).
  tree-sitter recovers around these, so runtime facts are unaffected in the files
  seen so far, but the gap will grow. Options when it matters: oxc-parser for JS/TS,
  or building the grammar from a maintained fork.
- **Dynamic observation gaps.** Responses alone cannot establish whether a tool
  ran or a protected document was read. Trace sampling, missing tool arguments and
  failed fixture delivery must reduce coverage rather than create passing tests.
- **Variable model behaviour.** Changes in models, prompts, tools or retrieval can
  change results. Pin what can be pinned, record what cannot, and compare repeated
  trials with their controls and sample counts.
- **Harness code execution.** Project import itself can have side effects. The
  launcher must establish the supported isolation profile before import and attach
  the appropriate tool doubles; a subprocess is not a sandbox. Missing isolation
  support blocks that integration's run, rather than falling back to ambient host
  credentials or transferring isolation work to the user.
- **Automatic integration fidelity.** Static detection is broader than runtime
  integration support. Versioned adapters need evidence that discovery, hooks and
  synthetic resources preserve the task and the boundary being tested. Unsupported
  project shapes are a compatibility gap, not a reason to require user-written code
  or silently reduce the coverage advertised by a test.
- **Exposed receivers.** A receiver reachable from staging can also receive traffic
  from elsewhere. Bind to loopback by default, require explicit configuration for
  anything else, authenticate events, bound their size and rate, and never treat
  unauthenticated input or its claimed trial id as an observation or a reason to
  change a trial's outcome. Event authenticity assumes trusted instrumentation and
  a token inaccessible to the tested tools; it does not follow from subprocess
  separation alone.

## Beyond the MVP

The next capability priorities pursue the product direction above. They are
planned work, not current features or a claim of parity, and do not change M0–M8's
completion status. Detailed sequencing will be defined after scoping these gaps:

- **Broader test catalogue and target support:** direct model targets, additional
  application integrations and versioned packs for data leakage, unauthorised tool
  use, access controls and application policy, alongside prompt injection.
- **Generated and adaptive attacks:** an attacker LLM creates context-specific
  cases and refines attempts from target feedback within explicit budgets.
- **Multi-turn campaigns:** session-aware conversations, reset and replay, with
  bounded adaptive strategies and retained evidence across turns.
- **Hybrid grading:** deterministic assertions and tool evidence complemented by
  LLM judges for semantic outcomes; record judge configuration, uncertainty and
  calibration against labelled examples. Keep model judgments distinct from
  observed actions.
- **Security regression suites:** save observed failures as reusable cases and
  import security cases, then compare the same attacks and policies across fixes,
  prompts, models or builds through the dashboard and CI. Preserve case/strategy
  versions and scope so comparisons do not imply equivalent coverage when the
  setup changed. Track target, attacker and judge usage within the campaign budget.
- **Expanded dashboard:** team collaboration and cross-project views. The React +
  Vite dashboard, local run history and setup/run/results flow already belong to
  M6; indirect-injection scenarios and before/after reports belong to M7.
- **Additional dynamic adapters:** local MCP stdio processes explicitly configured
  by the user, more framework-specific observation adapters and broader probe
  coverage, driven by measured gaps in M6/M7.
- **Model-level adversarial research** requiring weights and PyTorch, in a separate
  Python worker if pursued; it is outside the agent-level M6/M7 scope.
