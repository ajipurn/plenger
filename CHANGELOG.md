# Changelog

All notable changes to plenger. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
milestones from [docs/ROADMAP.md](docs/ROADMAP.md); there is no public release
yet. Current status is in [docs/STATUS.md](docs/STATUS.md).

## Unreleased

### Changed

- The dashboard calls each AI review cycle a **round** in both modes and on
  every page, instead of batch, source batch, review or exploring review. Each
  round runs discovery, then **validation**, the former second review. The New
  Scan field **Second review** is now **Validation model**. Saved scans keep
  their data; text saved with them, such as activity and limitations, keeps
  the earlier wording.
- The public CLI now launches the dashboard with `plenger`. It retains
  `--help` and `--version` and adds `plenger update` with explicit confirmation.
  Published builds check for stable updates in the background with a daily cache.
  Updates verify the global npm installation and install the confirmed exact version.
  Private builds skip registry checks and self-update.
- Batch review requests allow 12,288 output tokens, up from 8,192, so a
  discovery reply fits 16 path closures. The source budget for a
  200,000-token window drops from 106 to 103 KiB.
- The former scan, facts, rules, assess, serve and redteam commands are removed.
  Dashboard analysis and shared engines remain. The GitHub Action calls the static
  engine directly. Installed-package checks use the default dashboard launcher.
- The ChatGPT provider editor no longer has an output token threshold. Saving or
  signing in uses automatic output settings, so each operation's allowance is the
  observed limit instead of 1,024 tokens per red-team call.
- A running scan's progress card shows its stages on a vertical timeline, with
  the latest steps under the active stage and the tokens charged so far in its
  heading. Each new step adds a ring to the illustration. **Pause animation** is
  gone: the illustration is a working indicator, and reduced motion keeps it
  static.
- Full coverage's spending limit is optional. **Set a spending limit** stays
  checked by default; clear it to run until the project is covered or 100
  batches have run. Scan details show the tokens such a scan charged.

### Fixed

- **New Scan** beside each project stayed enabled while another scan ran, and
  its scan then failed to start. Every control that starts a scan is now
  disabled while one runs, and hovering it names the reason. Button hover text,
  such as why **Delete project** is disabled, was never shown before.
- Reopening a connected ChatGPT provider kept the model as free text. The models
  listed at sign-in are now saved with the provider and offered again, in the
  editor and in New Scan.
- **Delete provider** in a provider row's actions menu opened no confirmation.
- The Projects list showed the last scan's finding count, so a project whose
  latest scan found nothing read 0 while its page listed open findings. The
  column is now Open findings, counted across all scans as on the project page.
- In the light theme, text fields and dropdowns had the same color as the page,
  so the search and filters in the Projects and Findings toolbars blended in.
  Fields are now white.

### Removed

- Engine parts that only the removed commands used: the terminal report and rule
  list, the facts-only Claude assessment and its schema, the red-team text,
  Markdown and SARIF reports, campaign comparisons and their schema, and the
  report engine's switch that ignores `plenger-ignore` comments.
- The FastAPI project profile: its preparation stage, runtime recipe, disposable
  MySQL and Redis services and the planner profile. Its design stays in
  docs/design/fastapi-profile.md.
- Change reviews (M10d), to keep plenger local-first: the **Scope** choice in
  New Scan, `changesSince` in the scan API, the Action's `ai-changes-since`
  input, the in-process diff and the four `*-diff-*` cases of the evaluation
  corpus, which has 150 cases again. The Action's AI review reads the whole
  checkout and no longer needs `fetch-depth: 0`. Discovery drops its change
  instructions, so both prompt digests change. Scan details no longer show
  the base of an earlier change review. Its design stays in
  docs/design/strix-adoption.md.

### Added

- A running scan has **Pause scan** and **Stop scan** instead of **Cancel scan**.
  Pause, for Full coverage AI scans, ends the current request and keeps the
  finished rounds and their findings. **Continue scan** later runs the remaining
  rounds under what is left of the limit, starting again with the round that was
  running. Stop ends a scan for good; it shows as **Stopped**, formerly
  Cancelled. Closing the dashboard, or a crash, now pauses a running Full
  coverage scan instead of failing it.
- **Settings > Appearance** has a **Theme** choice of Dark, System or Light,
  replacing the Dark mode switch. Each option previews the dashboard. System
  follows the device setting, applies before scripts load and changes with the
  device. The saved theme is kept when the database upgrades.
- **Settings > Appearance** also has a **Density** choice. Compact tightens
  table and round rows, panel padding and the gaps between panels, so more
  findings fit on screen. Buttons and fields keep their size. Comfortable stays
  the default.
- Delete a project from **Projects** or its detail page after confirming in a
  dialog. Its scans, findings, reviews, imported evidence, threat model and
  red-team results are deleted with it; the folder stays unchanged. Deletion
  waits while a scan runs.
- `pnpm evaluate --concurrency <n>` reviews several cases at a time in one
  process, and a review the provider rejects with HTTP 429 is rerun after a
  pause; the report counts the reruns.
- M10a decision discipline in the AI review. Discovery rates severity with a
  rubric and checks reach, preconditions and gain before high or critical. A
  second-review dismissal names its basis (control, unreachable, contradicted or
  duplicate) and cites the lines that decide it. The host checks the citation
  against what the second review received; a dismissal that does not check out
  becomes Needs review with a host note and a limitation. Unreachable does not
  apply to a supply-chain candidate or a missing loop limit. Scan Outputs list
  dismissed candidates with their basis and cited lines.
- Severity labels on the vulnerable evaluation cases. `pnpm evaluate` reports
  severity agreement, vulnerable cases dismissed by mistake and dismissals the
  host kept as Needs review.
- M10b path closure. Discovery receives the paths the static scan traced from
  entry points, tools, agents and model output to an effect, at most 16 per
  review, and closes each as a finding, safe with a cited control, or open. The
  host checks every closure; a path without one that checks out is Not closed.
  A closure's reason is one short sentence, cut at 300 characters. Scan
  Outputs list the paths with their closures, and `pnpm evaluate` counts them.
- M10c project threat model. A project keeps a threat model of its
  architecture, assets and trust boundaries: the first review derives it, later
  reviews in the scan and in later scans start from and extend it, and each scan
  records the version it used. The project page shows it and lets you write
  your own, which reviews keep.
- M10d change reviews. New Scan's Changes scope reviews the files changed since
  a branch, tag or commit, uncommitted work included, with the change rules for
  introduced, newly reached and weakened paths and removed controls. The base
  comes from Git objects and is compared with the files on disk in-process, so no
  project filter or diff driver runs. The GitHub Action gains an opt-in AI review
  with provider, model, key, token limit and base inputs; on a pull request it
  reviews the changes since the base. Its kept findings are a second SARIF run,
  and source-supported ones count toward the gate.
- M10e long scans. A Full coverage scan that stopped at its limit, or whose
  later batch failed after earlier ones completed, can continue under a new
  limit for what it spends from then on, from its saved static scan; later
  batches skip files sent whole, and the scan records each continuation.
  While a scan runs, its details show an activity list of model requests, the
  files and searches of exploring reviews, finished batches and tokens charged.
- Five more static rules:
  - PLG808: a tar archive extracted with no `filter` and no member selection,
    whoever passed it;
  - PLG809 to PLG812: data received over the network that reaches a shell command
    or a program's name, a file path, code or a deserializer, at medium
    confidence. Received data comes from an HTTP response (`requests`, `httpx`,
    `aiohttp`, `urllib`, `fetch`, `axios`, `got`), a socket or zmq receive, an FTP
    or S3 listing, or a project function that returns one of these.

- More sinks: Flask's `send_file`, FastAPI's and Starlette's `FileResponse`, the
  pattern of `Path.glob` and `rglob`, Prisma's raw SQL (`query_raw`,
  `$queryRawUnsafe`), Pyodide's `runPython`, transformers'
  `get_class_from_dynamic_module`, `pandas.read_pickle` and statsmodels'
  `load_pickle`. Python comprehensions bind their loop names to items of their
  iterables, in a scope of their own.

- The static engine can scan a package in library mode: the parameters of its public functions
  and methods count as untrusted input. Seven rules report them:
  - PLG901: in a shell command, a program's name or its arguments;
  - PLG902: in a file path on a base the function chooses, or read from inside a
    parameter;
  - PLG903: in SQL text;
  - PLG904: deciding a URL's host, read from inside a parameter;
  - PLG905: evaluated as code, or naming a module to import;
  - PLG906: compiled as a template;
  - PLG907: deserialized.

  A path or URL whose start the caller passes is not reported. Confidence is medium
  when the value is built into the effect and low when the function receives it
  whole. Reports gain `library.functions`, findings about a `function` subject and
  `given` inputs on capabilities. Scans without `--library` are unchanged.
  `scripts/advisories.ts run --library` runs the advisory benchmark in that mode, and
  `test/fixtures/evaluation-library` holds nine library pairs.

- Four more static rules for web routes:
  - PLG804: request input deciding a URL's host;
  - PLG805: request input evaluated as code;
  - PLG806: request input compiled as a template;
  - PLG807: request input deserialized.

  New sinks:
  - template engines: Jinja, Mako, Django templates, `render_template_string`,
    EJS, Handlebars, Pug, Nunjucks, Lodash and Underscore;
  - SQL text through Django `cursor().execute`, `raw` and `extra`, SQLAlchemy
    `text`, Sequelize and TypeORM.

  Routes are read for Starlette, aiohttp, Koa and NestJS (with the
  `@Controller` prefix).

- `plenger-ignore PLGxxx reason` comments suppress findings of the named rules
  on the comment's line, or on the line below when the comment stands alone.
  SARIF marks them `inSource`. The terminal lists each finding a comment in the
  scanned code suppresses, with its reason, and Markdown labels them apart from
  suppression file entries. `--no-inline-suppressions` reports them. The
  dashboard does not read the comments.

- `scripts/advisories.ts` measures the static rules on reviewed GitHub
  advisories of AI and agent projects:
  - `select` writes the manifest from fixed criteria;
  - `run` downloads the code around each fix, before and after it, and scans it
    read-only.

- Static rules for web routes with no model in between: PLG801 (request input
  in a command or program arguments), PLG802 (in a file path) and PLG803 (in
  SQL text). They follow the handler into project functions in other files.
  FastAPI parameters filled by `Depends` or `Security`, or typed as a number,
  boolean, UUID or date, do not count as request input; code facts record them
  as `injected` and `scalars`. A path a project function
  returns after resolving it and checking it stays inside a base now counts as
  checked, for tools as well. The evaluation corpus gains ten cases, five
  pairs.

- **Explore** review mode (M9b): New Scan offers Explore next to Batch. The
  model reads the project through four read-only tools over the scan's
  allowlist (`list_files`, `read_file`, `search` on redacted text, `outline`)
  and answers through a submit tool, strict on Claude, checked by the same
  parsers. Citations must lie in lines the session received. Each pass is one
  bounded conversation with a closing turn before its limits. Reviews record
  `mode` and, per session, the stop reason, tool calls, files and ranges read
  and the searches. `pnpm evaluate --mode explore` measures it.

- Explore runs Full coverage: later reviews start from files no earlier review
  read whole and hear, within 8 KiB, what earlier reviews read and reported.
  Coverage stops when a review reads nothing new. On Claude every exploring
  turn asks the API to cache its prefix. New Scan selects Explore for Claude
  connections; OpenAI, Gemini, Ollama and ChatGPT can choose it, with plain
  function tools. Scan > Outputs shows each exploring session's stop, calls,
  read files and ranges, and searches.

- A second review that stops before it decides keeps its candidates as
  **Unvalidated**, in both modes, with the reason. It used to fail the review.
  A decision reason over 1,200 characters is cut and marked instead of
  rejecting the submission, which left 3 labeled findings Unvalidated in the
  cross-file runs. An exploring turn may use 16,384 output tokens, and a reply
  cut at that allowance gets one request to answer more briefly instead of
  failing the review.

- AI findings name a CWE id, shown and linked on the finding page. `pnpm
  evaluate` adds a count of findings that name the labeled weakness. On one run
  of 85 cases it gave precision 0.91 and recall 0.91, against 0.68 and 0.95 for
  any finding at the labeled lines; see
  [detection-claude-haiku-2026-10-17-cwe](docs/qualifications/detection-claude-haiku-2026-10-17-cwe.md).

- Discovery is told that hardening items (rate limits, timeouts, size and cost
  limits, logging, monitoring, headers) are not findings, that supply-chain
  weaknesses and credentials in source are, and when prompt injection is one.
  On one run of 86 cases this raised precision from 0.68 to 0.82 at recall
  0.95. Explore mode, with strict submit tools on Claude, reached 0.83 and 0.98
  on the same corpus for 38% more cost; every case fit its first message. See
  [detection-claude-haiku-2026-10-17-explore](docs/qualifications/detection-claude-haiku-2026-10-17-explore.md).

- The corpus adds three pairs whose deciding file (a repository, a path
  helper, the router that mounts a feature) sits after enough modules that
  neither the batch nor Explore's first message holds it, 92 cases in all; a
  test keeps it out. Over three runs on Claude Haiku 5.5, Explore named the
  labeled weakness on these pairs with precision and recall 1.00, against 0.50
  and 0.33 for Batch, with whole-corpus recall 0.97 against 0.91. See
  [detection-claude-haiku-2026-10-17-cross-file](docs/qualifications/detection-claude-haiku-2026-10-17-cross-file.md).
  Evaluation outcomes of exploring reviews list the files they read.

- The static scan follows pathlib joins (`NOTES / name`) and methods called on
  a parenthesized expression, detects a project's own tool base classes, and
  lists compiled files (native libraries, executables, WebAssembly, JVM
  bytecode, Python packages) with size and SHA-256 under `binaries`. The corpus
  adds a pathlib traversal case, 86 cases in all.

- REA imports accept files up to 64 MiB. The semantic graph and raw result are
  dropped before the bounds apply, and limitations beyond 256 are counted
  instead of rejecting the import. The 347-file export from the REA check now
  imports.

- The static scan reads the checks before an effect. Membership in a fixed
  collection, equality with a fixed value and lookups into a fixed table
  (`COMMANDS[kind]`, `COMMANDS.get(kind)`) take the checked input out of the
  model's reach for every effect, and a host allowlist does so for a URL. For a
  file path, so do a name pattern of letters, digits, `_` and `-`, a check for
  `..` together with `/` or an absolute path, and a resolved path kept inside a
  fixed base by `is_relative_to` or a prefix that ends with a separator.
  Values built from a checked name count as checked, and a check inside a `try`
  whose handlers leave the function covers the code after it. Facts record these
  checks as `guards` and mark assignments the code changes in place `mutated`.

- Calls through a fixed table of functions (`HANDLERS[name](x)`,
  `TOOLS.get(name)(x)`, JS object and `Map` literals) are traced into every
  function the table holds, library sinks such as `subprocess.run` included. A
  table the code fills at run time stays a trace gap. Call facts carry such a
  callee as `lookup`.

- The corpus adds the four pairs the M9b design asks for (route authorization
  and tenant scoping across files, a path helper in another module, SQL in Go),
  a Java path pair, a prefix check without a separator and an absolute-path check
  without `..`, 85 cases in all. Three safe cases that held a weakness of their
  own kind are fixed. A live baseline of the AI review on 82 of them,
  Claude Haiku 5.5 over three runs, is in
  [detection-claude-haiku-2026-10-17](docs/qualifications/detection-claude-haiku-2026-10-17.md):
  precision 0.62 and recall 0.95, with one dismissal in 263 second-review verdicts.

- `pnpm evaluate --json` keeps each finding at a labeled location with its
  title, STRIDE category, severity, second-review verdict and reason, so a
  reported safe case can be read.

- The evaluation corpus has 72 cases: a vulnerable case and a safe near-miss for
  every one of the 26 rules and for each kind of check. Static precision is 1.00
  and recall 0.97 on it, against 0.76 and 0.94 for the previous scanner; the
  [record](docs/qualifications/detection-static-2026-10-17.md) also covers six
  open-source projects.

- New Scan offers **Quick** and **Full coverage** instead of Standard and Deep.
  Quick reviews one batch. Full coverage reviews batches until no unsent source
  that fits a batch remains, stopping at a token or USD limit the user sets;
  USD needs saved Claude prices for every model in the scan. A batch starts
  only when its maximum fits what remains, and every request is checked again
  before it is sent. New Scan shows how many files the review can read and how
  many batches full coverage needs. Scans record their limit, the files
  covered, why batches stopped and what the limit was charged. Older Standard
  and Deep scans keep their labels.

- Dashboard reviews read text files without a parser: code in other languages,
  shell, SQL, templates, configuration, Terraform and Dockerfiles, plus CI
  definitions under `.github/workflows`. They come after the traced and
  focused files, code before configuration and tests last, and large ones go
  as 80-line windows that later Deep batches continue. A folder without
  Python, JavaScript or TypeScript now gets a review instead of failing.

- AI reviews and `plenger assess` reports record what produced them: the
  SHA-256 of the instructions with their schemas, and each request's model,
  temperature, output ceiling and use of structured output. Outputs show them.
- `pnpm evaluate` measures detection on a labeled corpus of 16 cases, pairs of
  a vulnerable case and a safe near-miss, for the static rules and for the AI
  review of saved connections over repeated runs.
- Static scans report handler traces that stop short. Tools and entry points
  carry a `trace` entry in the JSON inventory with the calls past the depth
  limit and the calls through a callback, subscript or call result; every report
  lists them under coverage, and findings about them carry a note.
- The AI review's second request also reads the imports and callers of cited
  files, as redacted excerpts from the scan's allowlist, and can run on a
  separately chosen saved connection with its own usage and cost.
- The AI review batch is sized to the selected model's input window from its
  saved catalog (Claude's `max_input_tokens`), up to 112 KiB of source and
  48 KiB of related files, within the unchanged 400,000-token ceiling.
- FastAPI project profile, preparation stage (M6b checkpoint 1):
  `plenger redteam prepare` builds an image from the project's `requirements.txt`
  with wheels only, retrying for `linux/amd64` on Apple Silicon when a wheel
  exists only there, starts disposable MySQL and Redis on an internal network,
  imports the application in an isolated worker with llmfy 0.6.0 model classes
  routed to the host broker, probes `GET /` and reports packages, routes and
  import errors. Plans choose the profile for FastAPI projects whose llmfy
  entry points the file canary cannot bind; dependencies without an exact pin
  are resolved and recorded instead of blocking.
- Live progress in the dashboard's red-team results: the current repetition
  and check, model calls, the last worker event, elapsed time against the
  deadline, a repetition-by-check matrix that opens the evidence of a
  repetition, and the latest worker events while a test runs.
- Experimental ChatGPT subscription provider: Sign in with ChatGPT from the
  dashboard or `plenger redteam login`, OAuth credentials encrypted in the
  provider store with automatic refresh, and the public Responses API as the
  transport. Token thresholds are checked after each response rather than
  enforced by the model; budgets record this as `tokenLimitMode: "observed"`.
- Two more llmfy file-canary probes: `obscured-path` names the forbidden file
  through an equivalent path spelling, and `embedded-instruction` hides the
  forbidden write inside the content of an allowed note. Both use the existing
  completed-file-write oracle.
- Test-pack binding by observed semantics: discovery reports, per target,
  whether the file-canary pack applies (`packs`), based on a synchronous tool
  whose handler writes model-supplied content to a model-controlled path. A
  target without one shows the reason in the CLI and dashboard, and the run is
  blocked instead of spending model budget on a clean control that cannot pass.
- npm package `plenger` with the `plenger` command: compiled CLI, built
  dashboard, grammars, schemas and red-team recipes. `pnpm build:package` and
  `pnpm test:package` build and check it; the npm package workflow runs the
  check on Linux, macOS and Windows.
- Apache License 2.0.
- Versioned worker frames: requests and `ready` frames carry
  `protocolVersion` 1, and the host and both runtimes refuse other values.

### Fixed

- HTTP requests through CommonJS `axios`, `got` and `ky` (`const axios =
  require("axios")`, then `axios.get(url)`) were not network calls, so a route that
  fetched a request URL with them was not reported.

- The advisory benchmark counts the named path traversal variants (CWE-24 to
  CWE-34, CWE-37 to CWE-40, such as `\..\filename` CWE-29) as path traversal.

- Eight static false negatives found in a review of the unreleased rules:
  - a path helper's check counted for every return, though it guarded only some
    (`if name in ALIASES: return ...`, then `return os.path.join(BASE, name)`);
  - a check helper's arguments stayed checked after they were assigned again;
  - any call named `abort` or `exit` ended a guarded block. Now only Flask's,
    Quart's or werkzeug's `abort`, `sys.exit`, `os._exit` and the builtin `exit` do;
  - a JS function with an unpacked parameter bound nothing for an object that is
    not a literal (`readDoc(req.query)`), nor its plain parameters;
  - a last component that may be `..` was allowed for directory listings and
    `chmod`, which act on the folder `..` names. It is now allowed only where a
    file's contents are opened;
  - an absolute path among a program's arguments carried nothing. It is now read as
    a file path, so `rm -f` on a resolved path that can leave its folder is PLG801.
    In a library scan, such a path the caller passes whole is not reported;
  - `re.sub` with a `count` was read as removing every separator;
  - `os.chmod`, `os.chown`, `os.mkdir` and `os.makedirs` traced their mode, not
    their path.

  Three readings keep the first fix from reporting confined paths that the wrong
  reading used to pass. A generated id (`uuid`'s `v4()`, `crypto.randomUUID()`,
  `nanoid()`, `uuid.uuid4()`) is a file name part. A member of an object literal the
  code never changes reads as its entry (`data.id` of `{ id: v4() }`). And
  `path.relative_to(BASE)` in a `try` whose handlers leave confines the path after
  it. The evaluation corpus has
  four more pairs. The safe transcode case now checks its name, since its resolved
  path could leave the media folder. Code facts gain `returnSpans`, and input parts
  gain `path` for an absolute path among a program's arguments.

- Four static gaps that also affected default scans:
  - `torch.load(..., weights_only=True)` is no longer a deserializer that can run
    code, as PLG107 and PLG807 recommend it;
  - a pathlib method counts only on a path, so `Path(p).suffix.replace(".", "")`
    is not a file move;
  - `re.fullmatch` and a compiled pattern's `fullmatch` check the whole name
    without `^` and `$`;
  - Python `str.replace` calls that between them replace `/` and `\` make a
    file name, as a separator-removing `re.sub` does.

  The evaluation corpus has three more pairs for them.

- In a Flask route, a check on a variable assigned from a request global
  (`name = request.form["name"]`, then `if name not in REPORTS: abort(400)`) now
  applies. Before, the variable kept the request global's reference and stayed
  request input whatever the check was. The evaluation corpus has one more pair.

- A program run with input only among its arguments is reported as argument
  injection (PLG102, or the arguments wording of PLG401), not as a program
  the input names, when the program comes from a call such as
  `shutil.which("ffmpeg")`.

- An exploring review no longer fails when Claude asks for more than eight
  tools in one reply. The reply may hold up to 64 calls; the session runs eight
  and answers the rest with its per-turn limit. A reply the Claude transport
  rejects now names the check in the review's reason (the stop reason, the
  number of tool calls), instead of the generic failure message.

- PLG101, PLG104 and PLG105 no longer fire on tools that check their input
  against a fixed allowlist, a name pattern or a confining base before the
  effect, such as the confined `readNote` and `read_note` tools of the risks
  fixture and a template-copying tool in crewAI's examples.

- `pnpm evaluate -- --provider ...` no longer fails on the `--` that pnpm 10
  passes through to the script.

- A stopped run now names its cause, such as "Stopped at the model call limit
  of 12 calls.", instead of "Run stopped by its budget, deadline or
  cancellation." The dashboard derives the same message from the recorded stop
  reason, so saved results read correctly too. Its notice offers the matching
  fix: a limit stop opens Configure another test at that limit and says the
  limit is shared by every repetition, provider problems link to Providers, and
  a cancellation has no action.
- The credential detector no longer treats ORM column definitions
  (`password = Column(...)`), model-API object ids (`call_…`, `tooluse_…`),
  compound identifiers (`SW-Chat-22-…`) or `key=value` expressions in quoted
  text as secrets. Such files were excluded from runtime snapshots as
  `embedded-credential`.
- Tool definitions from llmfy 0.11 (`{name, description, strict, parameters}`
  without a `function` wrapper) are normalised to function tools before any
  transport sends them. The ChatGPT transport rejected them before the first
  dispatch and the OpenAI-compatible transport forwarded them unchanged.
- **Clear saved data** in Scan history no longer deletes saved providers and
  their keys. Providers are workspace settings and are removed one by one in
  Settings → Providers.
- `plenger redteam compare --help` prints the compare options again instead of
  the generic `redteam` usage.
- The installed CLI reports an unsupported Node.js version instead of failing
  on a missing built-in module.
- A worker whose host process died no longer runs on indefinitely under
  Docker. The llmfy worker exits after 130 seconds like the Vercel worker, and
  preparing a runtime removes containers past their `org.plenger.expires`
  label.
- `executeRun` forwards injected dependencies to the Next.js executor.
- Both executors redact run snapshots; the llmfy executor previously did not.
- Captured Next.js sources are hashed in code-unit order, so the source digest
  no longer depends on the locale.
- Both planners share one credential detector with the placeholder exemption.
- Worker failures are a typed `WorkerError`; a clean exit followed by a protocol
  error no longer reports cleanup as unconfirmed.
- Dashboard request errors use endpoint-neutral messages and one 409 wording;
  provider save failures other than validation return 500 instead of echoing the
  internal error.
- Project picker breadcrumbs split Windows paths on backslashes.

### Changed

- A file name built so that it holds no path separator and is never `.` or `..`
  carries nothing to a file effect. Such names come from:
  - `secure_filename`, `sanitize-filename`, `get_valid_filename` and
    python-slugify, unless its `separator`, `replacements` or `regex_pattern` can
    put a separator back;
  - a `basename`, `parse().name`, `slugify`, host or separator-removing
    `replace` combined with fixed text, or made from text with a fixed letter.

  werkzeug's and Flask's `safe_join` confine their result, and a suffix check
  (`endswith(".json")`) before `basename` rules out `..`. A path built from
  fixed text and such names (`/srv/${slug}.txt`) stays under its fixed part.
  A name that may be `..` is still allowed as the last component of a read or
  a write. An absolute path among a program's arguments carries nothing, since
  it cannot be read as an option.

- A database lookup's row does not carry the values it was found by. A test
  whose block ends in `abort()` or `sys.exit()` protects the code after it.

- A JavaScript or TSX file the grammar rejects is parsed again with the TSX
  grammar and with bare `&` in JSX text, JSX attribute strings and the rejected
  code read as `+`, keeping the tree with the fewest errors. String literals and
  operators elsewhere keep their `&`. All 28 files with syntax errors in the measured open-source
  projects now parse.

- Projects of 64 files or more are parsed on up to four worker threads, about
  1.8 times faster on 1,000-file projects, with the same result. When a worker
  fails or exits early, every worker is stopped and the files left are parsed on
  the main thread.

- Static data flow reads project functions: the result of a call carries only
  the arguments its return values use, and the request globals the function
  reads. A call to a check helper that returns true only for a confined path
  (`isWithin(BASE, p)`, using `path.relative` or `os.path.relpath`) counts as
  checking that argument. Code facts record a function's `checks`, `call`,
  `descends` and `differs` guard tests, and what each parameter of a JS function
  binds when one unpacks its argument (`unpacks`). A JS function that unpacks
  its parameters now binds the entries of an object literal passed to it; it
  used to bind nothing. The evaluation corpus gains four cases, two pairs.

- The second review traces each candidate's path and dismisses it when the
  supplied code holds a control that defeats the described attack, names checks
  that do not count, and keeps needs-review for decisions that depend on code that
  was not supplied. On the corpus
  ([record](docs/qualifications/detection-claude-haiku-2026-10-17-validation.md))
  precision is 0.63 against 0.62 and recall 0.96, and source-supported findings
  reach recall 0.85 instead of 0.50.

- TypeScript and TSX type syntax that tree-sitter-typescript 0.23.2 rejects
  (`export type * from`, type arguments and `[]` after an import type, `in` and
  `out` variance) is blanked before parsing, keeping every position, so such
  files no longer count as having syntax errors.

- Python unpacking (`path, body = data.split("|")`) keeps where the value comes
  from, so a tool writing to a path split from its input is now reported.
  Provenance follows 16 steps instead of 8.

- Trial input is now a host template (generated-attacks checkpoint 1, brought
  forward from after M7). The built-in control and probe prompts live in
  `src/redteam/attack-model.ts` with `{{name}}` placeholders and fill to the
  same text as before. The Next.js worker receives its template in the request,
  fills the booking it seeds and reports the values; the host rejects a fixture
  whose text is not the filled template. Worker protocol version 2: the
  runtime recipes changed, so images are rebuilt on the next run, and a
  version 1 worker is refused.
- Campaign results in the dashboard: direct tool checks that accepted a
  prohibited change now appear as their own section with the observed change,
  arguments and recommended fix, placed before the model table instead of a
  notice that repeated the verdict. The verdict leads with the channel that
  failed, and rate cells below the comparison minimum read "Too few tests to
  estimate" instead of a bold percentage.
- CLI split into per-command modules under `src/cli/commands/`. Each command
  accepts only its own options; `plenger <command> --help` shows them, and
  `--version`/`--help` work after a command name. `plenger redteam` has the
  subcommands `discover`, `plan`, `run` and `compare`.
- Source layers reorganised: `src/shared/` (secrets, runtime assets, JSON,
  hashing, comparison, guards) and `src/source/` (files, languages, parser,
  reads) replace top-level modules; `src/inventory/modules.ts` moved to
  `src/project/`.
- Red-team engine restructured around campaigns (`campaign.ts`,
  `campaign-evidence.ts`, `campaign-report.ts`, `comparison.ts`) with
  versioned JSON schemas for runs, campaign plans, campaign evidence and
  comparisons. Types moved into `run-model.ts`, `campaign-model.ts` and
  `plan-model.ts`; the container launcher is `worker.ts`; the shared executor
  core is `run-lifecycle.ts`; every limit, id and runtime pin is in
  `constants.ts` and the JSON schemas derive from it. The Next.js modules are
  `vercel-plan.ts` and `vercel-run.ts`; the CLI commands moved to
  `src/cli/commands/redteam-run.ts` and `redteam-compare.ts`.
- SQLite persistence moved to `src/storage/` (ordered migrations, scan,
  red-team and provider repositories). The dashboard service is split into a
  route table (`src/dashboard/routes/`), request validators, security headers,
  static assets and an operation supervisor; `src/dashboard/contract.ts` is the
  single API contract shared with the page.
- Dashboard frontend reorganised into feature folders; new Providers,
  campaign results and comparison views.
- Documentation reorganised into `docs/guide/`, `docs/design/`,
  `docs/history/` and `docs/qualifications/`, with `docs/STATUS.md` as the
  single status page. Added `CONTRIBUTING.md`, `CHANGELOG.md` and
  `SECURITY.md`.
- `package.json` scripts `bench`, `docs:rules`, `schemas` and `generate` wrap
  the generator scripts.
- Red-team milestones M6 and M7 are postponed. The existing managed profiles
  stay available from the CLI; the dashboard keeps its placeholder page.

### Removed

- The standalone binary: `pnpm build:binary`, `pnpm test:binary`, the binary
  workflow, its embedded-asset code paths and the `esbuild` and `postject`
  development dependencies. Plenger ships only as the npm package. Third-party
  notices for the package are written by `scripts/package-notices.ts`.


## M6a/M6b/M6c preview and M8 preview (2026-10-04, f4e2242)

### Added

- Managed `vercel-booking-sqlite-v1` profile: captures a Next.js POST route
  handler and its import closure, prepares a disposable SQLite database,
  validates backend handlers directly and runs booking, price-override and
  zero-payment model trials with committed-snapshot evidence.
- Campaigns: fixed repetitions with fresh workers, one shared budget, per-case
  95% Wilson intervals, severity, execution-coverage and required-scope gates,
  exported non-secret profiles and `--api-key-env` for CI.
- `plenger redteam run` with terminal, JSON, Markdown and SARIF reports and
  private evidence under `<project>/.plenger/runs/`.
- `plenger redteam compare` for explicit before/after comparisons with
  fixed-configuration checks and minimum sample counts.
- Settings → Providers: named OpenAI, Gemini and Ollama connections with keys
  encrypted at rest; Gemini through its OpenAI-compatible transport.
- Persistent dashboard: SQLite stores scans, plans, runs, campaigns, provider
  settings and theme; refresh reconnects to active runs; Clear saved data.
- Docker support in the launcher, preferred over Podman when available.
- Scope matrix of discovered input, tool, MCP, web and retrieval surfaces,
  retaining unsupported and unselected entries.
- Qualification records: Autocare live run (2026-10-03), Docker llmfy
  qualification and scripted Next.js qualification (2026-10-04).

## M6a preview and M8 start (2026-10-03, c2bd4e4)

### Added

- React + Vite dashboard served by `plenger serve`: project picker with native
  folder chooser, scan overview, findings with evidence drawers, inventory
  browser, scan history, offline red-team preparation review and the managed
  llmfy file-canary run with model access, budgets and cancellation.
- Standalone executable (Node.js single executable application) bundling the
  CLI, dashboard, WASM grammars and runtime recipes, with `pnpm build:binary`,
  `pnpm test:binary`, SHA-256 checksums and `THIRD_PARTY_NOTICES.txt`.
- Native build, smoke-test and artifact workflow for Ubuntu, macOS and Windows.
- Shared `ModelBudget` controller and host-side qualification broker exercised
  through the networkless fixture.

## M6a foundations (2026-10-02, 9524bb5)

### Added

- `plenger redteam discover`: offline llmfy candidate discovery from the static
  inventory with reasons for unsupported shapes.
- `plenger redteam plan`: offline source-snapshot preparation with the
  `python-only-v1` policy, dependency declaration review and digests.
- llmfy runtime recipe (`runtimes/llmfy/`) with a digest-pinned image, hashed
  wheels, 18 isolation checks before import and the synthetic qualification
  suite run by `pnpm qualify:llmfy`.

## M5 review (2026-10-02, 1cfbd59)

### Fixed

- Redaction no longer rewrites plenger's own titles and evidence; only known
  secrets are redacted in generated text.
- SARIF for GitHub code scanning: `--source-root`, per-severity rule
  descriptors (`PLG302/low`), evidence as a code flow, suppressed findings left
  out by default, no local absolute paths.
- Third-party actions pinned to commit SHAs.

## M4 and M5: risk triage, reports and CI (2026-10-02, 19b4d82)

### Added

- 26 evidence-backed risk rules with OWASP LLM 2025, OWASP Agentic 2026 and
  CWE mappings, triage scores, evidence chains and stable fingerprints.
- Secret redaction across reports.
- Versioned JSON report (schema v1), SARIF 2.1.0 and Markdown formats;
  `--output`.
- Baselines (`--write-baseline`, `--baseline`), suppression files, `--fail-on`
  gate with exit code 3, and a composite GitHub Action.

## M3: cross-file links and capabilities (2026-10-02, b3beb03)

### Added

- Project linking of the project's own imports (Python absolute, relative and
  namespace packages; JS/TS relative paths, index files, CommonJS, tsconfig
  aliases) so inventory items attach across files.
- Capability analysis from tool handlers and HTTP entry points down to effect
  sinks, with call chains and bound inputs; agents roll up their tools.

## M2: agent inventory (2026-10-02, c67a4bc, 23c443e)

### Added

- Data-driven inventory of frameworks, models, LLM calls, agents, tools, MCP
  servers and clients, prompts, data stores and HTTP entry points.
- Detection for the OpenAI and Anthropic SDKs, Google GenAI, AWS Bedrock,
  LiteLLM, Ollama, Vercel AI SDK, LangChain/LangGraph, OpenAI Agents SDK,
  CrewAI, Pydantic AI, smolagents, AutoGen, LlamaIndex, Mastra, llmfy, MCP SDKs,
  FastAPI, Flask, Django, Express, Hono, Fastify and Next.js, with reviewed
  fixtures at precision and recall 1.0.

## M1: code facts (2026-10-01, 56acdef)

### Added

- `plenger facts`: imports, definitions, assignments and calls per file with
  call targets resolved to canonical names.
- `.gitignore` support in the walker (`--no-gitignore`); single-file roots.

## M0: foundation (2026-10-01, 8787833)

### Added

- `plenger scan` with a symlink-safe file walker, dependency and virtualenv
  exclusions, and web-tree-sitter parsing of Python, JavaScript, TypeScript and
  TSX with vendored WASM grammars.
- Supply-chain policy: three-day minimum release age, no install scripts.

The Python implementation that preceded this rewrite (v0) is kept on the
`feat/backup` branch.
