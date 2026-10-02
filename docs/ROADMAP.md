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

The MVP combines static triage, red-teaming and adversarial testing. Triage comes
first; [M6](#m6-red-team-harness-planned) tests explicit hypotheses against a running
target, and [M7](#m7-adversarial-testing-planned) tests indirect prompt injection.
Distribution follows in M8. M0–M5 are implemented; M6 onward is planned.

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
7. **Dynamic testing is explicit.** Only a separate run command contacts configured
   targets owned by the user or authorised for testing, and it imports and executes
   only the explicitly configured wrapper, in the environment the configuration
   declares. Static scans and planning stay offline and never execute project code.
   Built-in probes use synthetic data, canaries and test doubles for side effects.

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

### M6 Red-team harness (planned)

Turn the inventory into reviewable test hypotheses, then run them against a test
deployment. Support both HTTP APIs and direct agent functions in Python or
Node.js, including library-only llmfy projects; add MCP endpoints after those two
paths. Existing tracing is optional. Start with a small set of benign canary
probes, plus user-authored cases. An automatically generated attack corpus or
adaptive attack optimiser is outside this milestone.

For example, `POST /ops → ops_agent → shell` from PLG301 suggests a test of the
route's tool-use boundary. The case must define an operation that the application's
policy forbids and observe whether it reaches a recording tool double. Calling a
tool that the user is allowed to call is not a violation by itself. Static findings
are hypotheses, and a successful dynamic test does not validate every link in a
static finding automatically.

Build in this order:

1. **Offline plans and explicit target configuration.** Proposed commands are
   `plenger redteam plan` and `plenger redteam run`; these do not exist yet. Planning
   consumes an M5 JSON report and an explicit configuration, without contacting
   targets or importing the project. Each case records a stable id, source finding
   fingerprint when available, target, input, expected boundary, oracle, required
   observations and repetition budget. Unsupported findings remain listed with a
   reason; users can also define cases with no source scan. Routes, request fields,
   authentication references, function entry points and MCP tool mappings must be
   supplied or confirmed in configuration, not guessed from code. Credentials come
   from environment references and are never embedded in a plan.
2. **Bounded network execution.** Run only configured endpoints and operations.
   Use exact scheme/host/port and route or tool allow-lists; initially accept only
   loopback destinations, with staging destinations explicitly added.
   A `.localhost` or `.test` suffix alone is not proof of a permitted destination:
   validate resolved addresses and the connection destination, and disable redirects
   by default. Configure deadlines, maximum requests, response sizes and concurrency
   (one by default); stop on cancellation and retain partial results. Do not retry
   a potentially state-changing request automatically. The MCP adapter starts with
   Streamable HTTP to a server the user already runs; it never launches commands
   discovered by the scanner. Direct MCP tests cover that server's exposed contract,
   not an agent's response to injected MCP content (M7). Dynamic dependencies load
   only for the dynamic commands.
3. **Opt-in direct function adapter.** The run command can start a small Python or
   Node harness in the project's existing environment and invoke a user-written
   wrapper, including async functions. Configuration declares the interpreter,
   working directory, wrapper module/export, input/output mapping and allowed
   environment variables. Launch with an argument array, never a shell string.
   Only this explicit run step imports and executes the wrapper and its project;
   planning and scanning never do. Do not install dependencies, discover functions
   to execute, or reuse scanned MCP startup commands. Use a versioned JSON message
   protocol for trial input, result and events, on a channel separate from project
   stdout/stderr. The channel must work on macOS, Linux and Windows, because M8
   ships Windows binaries: use a loopback socket or named pipe rather than an
   inherited extra file descriptor, which Python does not support portably on
   Windows. Start a fresh worker per trial, bound time and output, propagate
   cancellation and report failures to stop workers or reset external state.
   Measure worker start-up cost (framework imports can take seconds per trial) and
   document it; reusing a worker across trials with a verified reset can become an
   explicit option later, never the default. The
   subprocess is not a sandbox; the configured environment still needs test doubles
   or isolated resources. Provide Python, Node and llmfy wrapper examples so users
   do not need to expose an HTTP route just to test a library.
4. **Canary oracles and observation.** Give each trial a fresh synthetic marker and
   correlate responses, recorded tool arguments and callback events with that
   trial. Markers use a fixed, recognisable format (a plenger prefix plus lowercase
   hex) that M5 redaction does not take for a secret, so persisted evidence still
   shows them; redaction tests cover the format. Start with response assertions, a
   local callback receiver and a small
   documented event format with ready-to-use Python and JS/TS helpers for
   instrumented test tools; no observability service is required. The helpers are
   single files that depend only on each language's standard library, copied into
   the user's test code from the release and carrying the event protocol version;
   the runner rejects an unsupported protocol version. Publishing them as PyPI and
   npm packages is an M8 option, not a prerequisite. Helpers emit
   trial/call ids, tool names, lifecycle stages, fixture/document ids and selected
   arguments/results, with a trial-completion marker to detect incomplete streams.
   Include sync/async tool wrappers and a context-delivery hook, plus an llmfy
   example using recording tools. Emit retrieval delivery at the point selected
   documents enter the agent's context, not merely when a search returns hits.
   The same events work through a local receiver for HTTP targets or the function
   harness's message channel. That event channel is separate from the canary
   callback receiver. Helpers authenticate events with a per-run token passed only
   to the harness and instrumented test tools, never placed in model-visible input,
   so the agent under test or another local process cannot forge observations such
   as a completion marker. Unauthenticated, oversized or excessive events are
   rejected and recorded, and make the affected trial inconclusive rather than
   `not_observed`. Correlate concurrent events and reject stale trial
   ids; do not report a tool's completion when only its invocation was observed.
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
   `not_observed`, alongside total attempts, coverage and all other outcome counts.
   Zero evaluable trials gives an unavailable rate, not 0%. Preserve the plan and
   probe versions, source report digest/revision when available, target build
   identifier when supplied, model/settings when known, trial ids, seed for fixture
   generation, timing and redacted evidence. A seed reproduces fixture generation,
   not model behaviour.

**Delivery checkpoints.** Complete and review each checkpoint separately; M6 is
done only when all three are complete. All command names and options below are
planned interfaces.

| Checkpoint | Deliverable | Acceptance |
| --- | --- | --- |
| M6a HTTP and observation | Offline plan, bounded HTTP runner, Python/JS event helpers, canary oracle and JSON result | One enforced and one violated boundary, echo negative control, rejected unauthenticated events, incomplete-event handling and cancellation, without a model API key |
| M6b Direct functions | Python/Node harnesses, sync/async wrappers, llmfy example and fixture reset | HTTP-free runs produce the same event/result contract on macOS, Linux and Windows; imports occur only during an explicit run; timeout, worker cleanup and reset failures are exercised; worker start-up cost is measured |
| M6c MCP and CI | SDK spike, MCP adapter, repetitions/statistics, remaining reporters, dynamic policy and CI gate | HTTP/function/MCP fixtures pass the shared contract suite; severity, coverage and exit-code cases are verified |

**MCP dependency decision.** Use the pinned [official TypeScript client SDK](https://github.com/modelcontextprotocol/typescript-sdk)
in a separately installed optional MCP adapter, loaded only for MCP cases. The
static CLI and HTTP/function adapters must install and run without that dependency
tree. This isolates protocol maintenance and dependencies while retaining SDK
handling of protocol negotiation, sessions and streaming. Select a released SDK
version during M6c, record supported protocol versions and review its transitive
dependencies under the existing pinning/age/no-install-scripts policy. No runtime
auto-installation: a missing adapter is a configuration error before execution.
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
its baselines. Terminal and Markdown show observations and coverage. SARIF exports
supported dynamic findings with real source locations when available, never
invented file/line evidence; flag unverified source-to-deployment mappings. Full
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
already contains it. CLI default is `none`; the planned CI example uses `high`.
One qualifying observation is enough to fail this gate; a low observed rate or a
wide interval does not erase it. Dynamic suppressions require a case id and reason
in an explicit dynamic policy file; they preserve results and never waive coverage.
Refreshing a comparison baseline does not suppress findings. M5's static gate and
suppression semantics stay unchanged.

Coverage is evaluable trials / planned trials **per selected case**, counting
skipped, unstarted and inconclusive trials as unevaluable; an empty selection is
invalid. `--min-coverage` is a fraction in `(0, 1]`, default `1`, and each plan also
declares a minimum evaluable count (one for a smoke case, at least 20 per case for
a before/after live-model comparison). Validate planned repetitions against that
minimum. `--fail-on none` disables only the finding gate. Execution errors,
cancellation and failed coverage/minimum counts still fail the run. Write partial
reports whenever possible and record every failure reason. Exit codes: `0` means
completed and all enabled gates passed, `1` means execution/I/O/cancellation or
coverage failure, `2` means invalid arguments/configuration, and `3` means the
finding gate failed. If execution/coverage and finding failures coexist, exit `3`:
an observed violation is conclusive whatever the coverage, and exit `1` would hide
it. The report retains every failure reason. The static Action never starts
dynamic tests implicitly; dynamic CI is configured separately.

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
tools or network access. Test deployments must replace high-impact tools with
recording doubles or isolate them with synthetic resources. This is an explicit
fixture prerequisite, not something the harness claims to enforce remotely.
Evaluate canary matches before redaction; persist redacted evidence by default,
including requests, authentication headers, responses and tool events.

Run artifacts default to `.plenger/runs/<run-id>/` under the chosen working
directory, with an explicit output override and no automatic upload or retention
service. Persist the redacted plan, result and bounded event records; protect file
access where supported. The repository already ignores `.plenger/`; examples for
other projects must include that ignore rule and state that staging artifacts can
still contain sensitive data after redaction and should not be committed. A local
ignore file does not make an external CI artifact upload private; document that
upload and retention are explicit user choices.

**Done when:** all three checkpoints pass. Deterministic local HTTP, direct Python
and Node function, and MCP fixtures demonstrate both enforced and violated
boundaries. Benign echoes do not count as violations; missing events, unreachable
callbacks, failed resets and timeouts are reported accurately.
Target validation tests cover redirects and changed DNS answers. Report schemas,
credential redaction, canary visibility after redaction, helper event
authentication and correlation, worker cleanup, cancellation and CI outcomes have
automated checks. A user can run the documented llmfy integration
with a stub model and recording tools, without an API key or tracing stack.
Optional live model trials are reported separately and are not required for routine CI.

### M7 Adversarial testing (planned)

Extend M6's plans, runner and oracles to put test instructions in lower-trust
content while keeping the legitimate user request unchanged. Use M6's Python and
JS/TS helpers to record content delivery and tool actions across HTTP and direct
function targets; adding tracing is optional. The focus is indirect prompt
injection through documents and tool results, as described by
[OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/). Reuse M6's
target constraints, synthetic data and recording doubles.

Implement a fixture lifecycle (prepare, verify delivery, reset, clean up), then add
channels in this order:

| Channel | How test content is delivered | Evidence required before scoring |
| --- | --- | --- |
| Tool output | A test wrapper returns a marked fixture at a selected tool call | The agent consumed that call's marked output |
| MCP result | An explicitly configured mock server supplies a selected result or resource | The agent received that mock content during the trial |
| Web content | A local fixture server serves the selected document to the agent's fetch tool | The content reached the agent, not just a server health check |
| Retrieved document | The user loads a fixture into a disposable retrieval collection | The marked document was retrieved into the trial's context, not merely indexed |

Each adapter declares the delivery and observation it supports. Where automatic
delivery cannot be verified, record that gap and mark the trial inconclusive;
never treat an unretrieved document as a successful defence. Keep indexing and
cleanup explicit so the runner cannot silently alter a production data store.

Pair each injected case with a clean control using the same legitimate task,
fixture shape and target configuration, in isolated sessions. The clean control
must show that the intended task and observation path work. Probe cases test
whether lower-trust instructions change the answer, disclose a synthetic marker
from a protected fixture, or request a tool action forbidden by the case's policy.
Benign quotation or summarisation of the fixture is not a violation. Use explicit,
deterministic assertions for the initial probes; an LLM judge is not required.

Ship a small, versioned set of benign canary templates and support user-authored
fixtures. Start with variations in wording, placement and document wrapping;
record each variant separately so a result can be reproduced. Do not expand into
model-weight attacks or an autonomous search for bypasses in this milestone.

Report per channel, case and tool: delivery coverage, boundary violations /
evaluable trials, control outcomes and legitimate-task completion. Failed controls
make the corresponding comparison inconclusive. A mitigation that rejects every
request must show the resulting loss of task completion. Compare before and after
runs only with matching case/probe versions and compatible configurations; record
the intended mitigation/build change and flag other changes. Use M6's 95% Wilson
intervals, per-case minimum of 20 evaluable trials in each build for live-model
comparisons, and severity/coverage gate contract. Show the absolute change in
observed rate and task completion without claiming statistical significance from
one changed response or interval overlap. Any observed violation can still fail
the severity gate, regardless of comparison eligibility. Refreshing a dynamic
baseline is explicit and does not overwrite the static triage baseline.

**Done when:** all four channels have a local example with an enforced boundary
and a deliberately violated one, clean controls, delivery evidence and cleanup.
Fixtures cover benign quoted instructions, missing retrieval, unavailable
observations and contamination between trials. Before/after reports demonstrate a
mitigation reducing observed violations while preserving the legitimate task.
The fixture suite runs without external models; live trials remain optional and
retain their sample counts and limitations.

### M8 Distribution (planned)

npm package, single binaries for macOS, Linux and Windows, user documentation.
Document the offline scan and explicit dynamic-test workflows separately, with
working HTTP, Python/Node function, llmfy and MCP examples, optional adapter
installation, fixture setup, event helpers, observation limits and CI configuration.
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
- **Harness code execution.** The direct function adapter runs project code with
  the user's privileges, and a subprocess is not a sandbox. Keep execution limited
  to the configured wrapper and environment, pass only allowed environment
  variables, and document that high-impact tools need test doubles or isolated
  resources.
- **Exposed receivers.** A receiver reachable from staging can also receive traffic
  from elsewhere. Bind to loopback by default, require explicit configuration for
  anything else, authenticate events, bound their size and rate, and never treat
  unauthenticated input as an observation.

## Beyond the MVP

- **Dashboard** sharing types with the CLI.
- **Additional dynamic adapters:** local MCP stdio processes explicitly configured
  by the user, more framework-specific observation adapters and broader probe
  coverage, driven by measured gaps in M6/M7.
- **Model-level adversarial research** requiring weights and PyTorch, in a separate
  Python worker if pursued; it is outside the agent-level M6/M7 scope.
