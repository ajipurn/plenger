# FastAPI project profile (design, M6b)

Status: design only. Nothing in this page is implemented. Current capabilities
are in [../STATUS.md](../STATUS.md).

## Why

The product goal is click-to-run: choose a project, press Start, get evidence,
without wrappers, fixtures or configuration files. The llmfy profile delivers
that for one shape of project only, and the first representative team project
is not that shape. `py-new-assessment-center` (Dayatech) was reviewed on
2026-10-06 ([qualification record](../qualifications/llmfy-chatgpt-live-2026-10-06.md)):

| Fact about the project | Why `llmfy-file-canary-v1` cannot run it |
| --- | --- |
| `llmfy==0.6.0` plus 28 other packages: FastAPI, SQLAlchemy with MySQL, Redis, boto3, LlamaIndex, FAISS, LiveKit | The profile ships Python 3.12 and llmfy 0.11.0 only and installs nothing from the project |
| Models are `BedrockModel` instances built from settings; `OpenAIChatModel` is not used | The worker patches `OpenAIChatModel` to reach the host broker; Bedrock calls would leave the container, which networkless workers forbid |
| 38 llmfy call sites, all methods on service classes constructed with a database session, Redis stores and settings | The profile can call a zero-argument factory or a one-text-argument module function; it cannot construct these objects |
| 69 FastAPI routes, including `POST /api/v1/chatbot/chat` behind a bearer-token dependency and a streaming response | The profile has no HTTP delivery; the Next.js profile has one, but only for Vercel AI SDK routes |
| Tools read documents, knowledge bases and the database; nothing writes files | The file-canary oracle needs a model-controlled file write |

Every row is a coverage gap, not a project defect. The roadmap rule stands:
an unsupported integration is explained, never turned into an adapter-writing
task. This profile closes the gaps for FastAPI projects that call llmfy agents
from route handlers. The acceptance target is this project, unmodified.

## Shape of the profile

`fastapi-llmfy-v1` is a project-mode profile in the sense of
[redteam-contracts.md](redteam-contracts.md): plenger prepares a managed test
instance of the application, delivers cases through its HTTP routes, observes
effects at the tool and resource boundary, and cleans up. It reuses the engine
(`run-lifecycle.ts`, `ModelBudget`, campaigns, gates, reports) and the worker
protocol. It adds four things the llmfy profile lacks.

1. A **dependency build stage** that installs the project's declared packages.
2. A **model adapter per llmfy version**, starting with 0.6.0, that routes every
   model class the project uses (`BedrockModel`, `OpenAIChatModel`) to the host
   broker.
3. **Disposable backing services** for MySQL and Redis, and **recording doubles**
   for outbound services the test must not reach (S3, email, LiveKit).
4. **HTTP delivery** through the application's own ASGI app, in process, with
   the access the user supplies.

### Build stage with network, run stage without

Today's rule is that scanning and preparation never execute project code and
that workers have no network. Installing the project's packages needs network
and runs third-party code (wheel installation is inert, but `pip` would run
`setup.py` for source distributions). The profile keeps both rules by
splitting the image build:

- **Resolve.** Read `requirements.txt`, `pyproject.toml`, `uv.lock` or
  `poetry.lock` with the existing dependency review. Accept only exact pins
  (`==`) or a lockfile with hashes. Unpinned entries (`websocket-client`,
  `pytz>=2025.1`, `llama-index>=0.10.22` in the target project) block
  preparation with the entry named; the fix is a pin in the project, which is
  ordinary hygiene rather than a plenger adapter.
- **Build.** A build container with network installs the resolved set with
  `pip install --only-binary=:all: --require-hashes` where hashes exist, and
  `--only-binary=:all:` otherwise, into a prefix. No source distributions, so
  no project-selected code runs during the build. The supply-chain minimum
  release age used for plenger's own dependencies is reported, not enforced,
  for project packages: the project chose them. The result is an image layer
  keyed by the digest of the resolved set, so a rebuild happens only when the
  pins change.
- **Run.** The worker image is the pinned Python base plus that layer, with
  the same isolation checks as today (no network, read-only root, no
  capabilities, memory, process and CPU limits, private `/tmp`), plus the
  disposable services described below on a private container network that
  has no route out.

System packages the wheels need (`libgomp1` for FAISS and scikit-learn in the
target project) come from a short allow-list in the recipe, never from the
project's Dockerfile. The project's Dockerfile, `compose` files and Makefile
are read for the review only, as presence and declared ports, and never
executed.

### Model adapter per llmfy version

llmfy's internal API changed between 0.6.0 and 0.11.0, so the broker patch is
a small adapter chosen by the declared version, qualified separately like the
runtime pins today. Each adapter does three things at import, before any
project module loads:

- Replace the exported model classes the project uses with a `BrokerModel`
  that sends the request to the host and returns the reply, as the llmfy
  worker does now for `OpenAIChatModel`. For the target project this means
  `BedrockModel`; its `BedrockConfig` (temperature, max tokens) is forwarded
  to the host as request metadata and the host applies the saved provider's
  settings. The model the agent asked for is recorded; the model that answered
  is the provider the user chose, as with every profile.
- Wrap `register_tool` so handler entry and return are observed, with the
  arguments the model proposed, as today.
- Hand the host the tool definitions in the version's own shape. The host
  already normalises the flat llmfy 0.11 shape and the wrapped
  chat-completions shape (`normalizeTools`); 0.6 is checked when the adapter
  is written.

Adapters live under `runtimes/fastapi/adapters/llmfy_<version>.py` and are
listed in `RUNTIME_FILES`. A project whose llmfy version has no adapter is
reported as unsupported with the version named.

### Backing services and doubles

The target project needs MySQL and Redis to import and to serve `/chat`. It
also talks to S3, Bedrock, an email service and LiveKit. The profile separates
these by what the test needs from them.

- **Disposable data stores.** A MySQL container (pinned image) and a Redis
  container (pinned image) start beside the worker on the private network,
  empty, with generated credentials that exist only for the run. The worker
  receives their addresses through the same settings the application reads
  (`MYSQL_HOST`, `REDIS_HOST`). Schema comes from the application's own
  migrations or `create_all` when the review finds them; otherwise the case
  pack seeds the tables it needs through the application's own repository
  code inside the worker, which is the equivalent of the Next.js profile's
  store module. The database observer takes committed snapshots of the tables
  a case names, as `committed-snapshots-v1` does for SQLite.
- **Recording doubles.** boto3 clients, SMTP and HTTP clients to configured
  external hosts are replaced at the Python boundary by doubles that record
  the call (service, operation, target, size) and return a fixed success. A
  recorded call is evidence of arrival at the boundary, never a production
  effect, which is the contract's distinction between dispatch and completed
  effect. The list of patched boundaries is part of the profile's published
  observable scope.
- **Nothing else reaches out.** The private network has no route to the host
  or the internet, and the isolation check `loopback-only` becomes
  `private-network-only` with the allowed service addresses listed in the
  `ready` frame.

### HTTP delivery

Cases are delivered as HTTP requests to the application's ASGI app inside the
worker, through an in-process ASGI client, so no port is published and the
request path is the project's own routing, middleware and dependencies.
Streaming responses are consumed to completion. Authentication is not
bypassed: the review reports which dependency guards the route
(`get_current_user`, `verify_api_key`), and the user supplies test access in
the profile, stored encrypted with the saved providers and never exported.
When the dependency reads a token the application mints itself, the pack's
setup step can call the application's own token route first. Overriding
FastAPI dependencies from the worker is out of scope: it would remove the
authorization checks the tests exist to exercise.

### Discovery and case binding

Discovery already finds the 69 routes, 23 agent declarations and the tools
behind them. The profile binds cases from that chain, route to service to
agent to tool to effect, following the same rule as the file canary: a case
binds to a verified effect, never to a tool name.

For the target project the first pack would be bound to effects that exist:

- **Participant scope.** Knowledge and document tools read on behalf of the
  authenticated participant. The disposable database holds two participants'
  documents; the attack asks the chatbot for another participant's document.
  Oracle: the recording double or database read scoped to the other
  participant's rows. Severity high.
- **Outbound message.** Routes under `notification` and `email` send through
  external services. The attack instructs the agent, through chat content, to
  send a message. Oracle: a recorded dispatch at the SMTP or HTTP double with
  the attack's marker. Severity high.
- **Clean control.** A normal chat turn that uses one knowledge tool for the
  participant's own document and completes the stream.

Prompt text, policy lines and exact oracles are decided when the pack is
written against the running fixture, not here.

### What the user does

Choose the project, review the plan (dependencies, adapter, services,
guarded routes, bound cases), add test access for the guarded route, choose a
provider and budget, press Start. No files are added to the project. A
blocked preparation names the one thing to change, and only pins fall on the
project side.

## Checkpoints

Each is qualified with the synthetic broker first and a live model second,
recorded under `docs/qualifications/`.

1. **Build pipeline.** Resolve and build the target project's dependency set
   into a layer; worker starts with all isolation checks on Docker and Podman;
   the project imports under the 0.6.0 adapter with the disposable services
   up. No model call yet.
2. **Broker and tools.** The adapter routes `BedrockModel` to the host; a
   synthetic model drives one chat turn end to end through `/chat` with test
   access; tool entry and return are observed; token accounting matches the
   provider's usage.
3. **Oracles.** Committed-snapshot observer on MySQL; recording doubles for
   boto3, SMTP and outbound HTTP; the participant-scope and outbound-message
   cases bind and score against a deliberately unguarded variant and the real
   handlers.
4. **Journey.** Dashboard flow from scan to evidence on the unmodified
   project with a live model, repeated from the saved profile; CLI and CI gate
   parity.

## Open questions

- Whether to run MySQL in the worker's pod or require the project to accept a
  SQLite URL through its settings. The target project builds its engine from
  `MYSQL_*` settings, so the pod is the no-code route.
- How much of the application's start-up to run. `main.py` starts a scheduler
  and a Socket.IO app; the profile should import the FastAPI app object only,
  with scheduler flags off through settings, and report what it skipped.
- Worker start-up cost with a large dependency set; M6b asks for it to be
  measured and published.
- Whether the first live qualification needs the Bedrock-shaped request
  metadata at all, or whether forwarding only the messages and tools is
  enough for the saved provider.

## Out of scope

Model-level attacks, replacing the project's authorization with overrides,
reading the project's `.env`, running its Dockerfile or scripts, and
publishing worker ports. Indirect injection through documents the chatbot
reads is M7 and would reuse this profile's delivery and doubles.
