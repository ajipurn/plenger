# Scanning

`plenger scan [path]` reads Python, JavaScript and TypeScript source and reports
the agent inventory, tool capabilities and risk findings. It never runs,
imports or installs the project and needs no network access. The path defaults
to the current directory and can also be a single file.

```sh
plenger scan path/to/project
plenger scan path/to/project --all
plenger scan path/to/project --json
plenger scan path/to/project --no-gitignore
```

`plenger scan --help` lists the options. See [reports-ci.md](reports-ci.md) for
`--format`, `--output`, baselines, suppressions and the CI gate.

## Coverage

The scan reports the files it parsed per language, files with syntax errors
(results for those may be partial), files it skipped and why, and directories
it excluded: dependencies, build output, virtualenvs (detected by `pyvenv.cfg`),
and whatever the project's `.gitignore` files ignore. `--no-gitignore` turns the
last rule off. The walker never follows symlinks and applies size and
file-count limits. Type declarations and minified bundles are skipped with a
reason.

A completed scan is not proof of safety. Syntax errors, truncation and skipped
files leave gaps, and the report shows them. A rule that finds nothing proves
nothing: plenger reports what it can see in the code.

## Agent inventory

```text
  Agent inventory
    Frameworks           llmfy (26 files), OpenAI SDK
    Models           37  gemini-2.5-flash-lite ×10, ${OLLAMA_MODEL:-gemma4:e4b} ×4, …
    LLM calls        39  llmfy invoke ×18, llmfy chat ×13, …
    Agents           47  LLMfy ×36, FlowEngine ×11
    Tools            12  get_current_weather, get_current_time
    Prompts          31  0 with dynamic parts, 5 with template variables
    Data stores      14  checkpointer ×8, embeddings ×6
    Not understood yet: google.genai (1 file)
```

Per project the inventory lists:

- frameworks, with the number of files that use each
- models and clients: model name, base URL and where the API key comes from,
  never its value
- LLM calls: model, client, system prompts, tools and the non-constant parts of
  their input
- agents: model, tools, prompts, graph nodes, delegates (handoffs, crew or team
  members), MCP clients and the calls that run them
- tools: name, description, handler, parameters and how they are declared
  (decorator, class, factory, plain function, built-in, agent-as-tool, MCP or
  JSON schema)
- MCP servers (tools, resources, prompts, transport) and clients (command or URL)
- prompts: fixed text, dynamic parts, template variables and users
- data stores: vector stores, embeddings, retrievers, checkpointers
- HTTP entry points

Libraries that plenger recognises as AI-related but does not model yet are
reported as "not understood yet", not dropped.

Detection is data: patterns over canonical call, decorator and base-class names
in [src/inventory/detectors/](../../src/inventory/detectors/). Imports of the
project's own modules are resolved across files, so a tool declared in one file
attaches to the server or agent created in another. The supported frameworks are
listed in [history/m0-m5.md](../history/m0-m5.md#m2-agent-inventory-done).

## Capabilities

After the inventory, a capabilities section lists the tools that can run
commands, execute code, write or delete files, reach the network, databases,
messages or payments, read secrets or environment variables, deserialise
untrusted data or drive a browser. For every tool handler and HTTP entry point,
plenger follows calls into project functions, methods and constructors (across
files, six levels deep) down to a call with an outside effect. Each capability
carries the call chain and the non-constant inputs of the effect, with caller
arguments bound to callee parameters at every step. Agents roll up their tools'
capabilities, their MCP servers, delegates and their own code execution. Entry
points report the models and agents they reach and with what input. Framework
built-in tools map to known capabilities, marked `hosted` when they run at the
provider.

Data flow is name-based, not field- or path-sensitive. Dynamic dispatch,
callbacks passed in from other files and framework-internal effects are not
followed.

## Findings

```text
  Findings  10 critical · 19 high · 7 medium · 4 low

    CRITICAL 100  Tool `run` runs a shell command built from model input
                  mcp_servers.py:13  PLG101 · high confidence · exposed
                  │ return subprocess.run(command, shell=True, capture_output=True, text=True).stdout
```

Findings come last, most urgent first. Terminal output shows the first 20
active findings; `--all` shows every one. Each finding has:

- a title that names the subject
- a severity and a confidence
- a triage score from 0 to 100: severity scaled by confidence, plus 10 when the
  code is reachable from an HTTP route or a network MCP server (`exposed`)
- the evidence chain from where input enters to where it is used, with the
  source line of each step
- notes on what lowered the rating, such as an input check, an approval step or
  test code
- the rule id and its OWASP and CWE mapping
- a fingerprint built from the rule, file and subject rather than line numbers,
  used by baselines

`plenger rules` lists the 26 rules; [RULES.md](../RULES.md) describes each one
with its remediation. An approval or input check done by a proxy, middleware or
configuration outside the code is not seen and leaves a finding at medium
confidence. Checks are recognised by name, not verified.

## JSON output and redaction

`scan --json` includes every inventory item with its location, every capability
with its call chain and the non-constant inputs of the effect, and every finding
with its evidence chain, source lines and fingerprint. The report has
`schemaVersion: 1`; [schemas/report-v1.schema.json](../../schemas/report-v1.schema.json)
defines the contract.

Recognised secrets are redacted throughout the output after analysis: known key
formats, private key blocks, credentials written out and every literal API key
passed to a model client. plenger reports their kind and location and shows
`<redacted>` in their place. Quoted random-looking strings are hidden only in
text copied from source; identifiers, model names and environment variable
names stay readable. Redaction is not exhaustive.

## Code facts

`plenger facts [path]` prints, per file, the imports, definitions (with
decorators, base classes and docstrings), assignments and calls as JSON. Call
targets are resolved through imports, variables, `self`/`this` attributes and
destructuring into canonical names such as `openai.OpenAI().chat.completions.create`
(Python) or `openai#default().chat.completions.create` (JS/TS). The fact model
is [src/facts/model.ts](../../src/facts/model.ts). `facts` uses the same report
contract as `scan` with code facts in each parsed file; it supports `--output`
and `--no-gitignore` and JSON only.
