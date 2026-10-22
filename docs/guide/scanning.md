# Scanning

The static engine reads Python, JavaScript and TypeScript source and reports
the agent inventory, tool capabilities and risk findings. PHP files are parsed
into code facts too (see [Code facts](#code-facts)); no detectors, sinks or
rules use them yet. It never runs,
imports or installs the project and needs no network access. The dashboard
uses this engine before its AI source review. See [reports-ci.md](reports-ci.md)
for the direct-engine GitHub Action, baselines and suppressions.

The public CLI launches the dashboard with `plenger`. Contributors call
`scan(root, options)` from src/scan.ts for offline engine work.

## Coverage

The scan reports the files it parsed per language, files with syntax errors
(results for those may be partial), files it skipped and why, and directories
it excluded: dependencies, build output, virtualenvs (detected by `pyvenv.cfg`),
and whatever the project's `.gitignore` files ignore. The engine option `gitignore: false` turns the last rule off. The walker never follows symlinks and applies size and
file-count limits. Type declarations and minified bundles are skipped with a
reason. TypeScript 5 type syntax the bundled grammar does not know
(`export type * from`, type arguments after an import type, `in`/`out` variance)
is blanked before parsing; it has no runtime effect and positions are kept. A
JavaScript or TSX file the grammar rejects is parsed again in two other ways, and
the tree with the fewest errors is kept:

- with the TSX grammar, which accepts keywords as JSX names (`<Skeleton.default>`,
  `<feBlend in="...">`) and `import ... assert { type: "json" }`;
- with each bare `&` in JSX text or an attribute (`Reject & close`) read as `+`.
  Neither grammar accepts a bare `&`, though React does.

Projects of 64 files or more are parsed on up to four worker threads. The result
is the same as on one thread.

Compiled files are listed, not analysed: native libraries and objects (`.so`,
`libssl.so.3`, `.dylib`, `.dll`, `.pyd`, `.node`, `.a`, `.lib`, `.o`),
executables (`.exe`, `.bin`, `.elf`, `.appimage`), WebAssembly, JVM bytecode
(`.jar`, `.war`, `.class`) and Python packages (`.whl`, `.egg`). The JSON report lists each under `binaries`
with its kind, size and SHA-256 (files up to 64 MiB are hashed), and the
Markdown report names them. The scan only reads their size and
bytes; it never loads or runs them.

A completed scan is not proof of safety. Syntax errors, truncation, skipped
files and incomplete handler traces leave gaps, and the report shows them. A rule that finds nothing proves
nothing: plenger reports what it can see in the code.

## Agent inventory

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
  JSON schema). A project's own tool base class counts too: a class whose local
  base class name ends in `Tool` and that defines `execute`, `_execute`, `run`,
  `_run`, `arun` or `_arun` is a tool, reported under the framework "Project
  tool classes"
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
untrusted data or drive a browser. `torch.load` with `weights_only=True` is not
such a deserializer: its unpickler refuses classes other than tensors and plain
containers. For every tool handler and HTTP entry point,
plenger follows calls into project functions, methods and constructors (across
files, six levels deep) down to a call with an outside effect. Each capability
carries the call chain and the non-constant inputs of the effect, with caller
arguments bound to callee parameters at every step. Agents roll up their tools'
capabilities, their MCP servers, delegates and their own code execution. Entry
points report the models and agents they reach and with what input. Framework
built-in tools map to known capabilities, marked `hosted` when they run at the
provider.

Data flow is name-based, not field- or path-sensitive. Unpacked names
(`path, body = data.split("|")`) carry what the value comes from, a pathlib join
(`target = NOTES / name`) carries its parts into `target.read_text()`, and a
method called on a parenthesized expression (`(NOTES / name).open()`) takes its
input from that expression. A pathlib method counts only on a path: in
`Path(p).suffix.replace(".", "")`, `replace` is a string method. A call through a
fixed table of functions (`HANDLERS[name](x)`, `TOOLS.get(name)`, a JS object or
`Map` literal) follows every function the table holds, or the one a fixed key names;
a table the code fills or changes at run time is not followed. Other dynamic
dispatch, callbacks passed in from other files and framework-internal effects are
not followed.

The result of a call into a project function is computed only from the arguments
its return values use, and from the request globals it reads (`flask.request`):
`label("daily", name)` that returns `f"report-{kind}.txt"` does not carry `name`.
Plenger cannot always tell what a function returns. It then takes the result to
depend on every argument. This happens for a class, a generator, a function with
ten or more returns, or an argument a JS pattern unpacks. A name such a pattern
binds gets the entry for its key when an object literal is passed
(`processAsFile({ uri: link })`), and the whole argument otherwise
(`readDoc(req.query)` for `function readDoc({ name })`). Plain parameters next to
a pattern bind by position.

A check before an effect takes the input it limits out of the model's reach, when
it leaves the function or the block on failure (`if name not in REPORTS: raise`) or
holds around the effect (`if (HOSTS.has(url.hostname)) { ... }`):

- for every effect: membership in a fixed collection, equality with a fixed value,
  or a lookup into a fixed table (`COMMANDS[kind]`, `COMMANDS.get(kind)`)
- for a URL: its host (`url.hostname`, `urlparse(u).hostname`) in a fixed allowlist
- for a file path: a name matching a pattern of letters, digits, `_` and `-`
  (anchored with `^` and `$`, or tested with `re.fullmatch`); a
  value checked for `..` and for `/` or for being absolute; or a resolved path
  (`realpath`, `resolve`) checked to lie in a fixed base with `is_relative_to` or a
  prefix that ends with a separator (`BASE + os.sep`), since `/srv/notes_old`
  starts with `/srv/notes`; or a resolved path whose `relative_to(BASE)` runs in a
  `try` whose handlers all leave; or a path measured against a base
  (`path.relative(BASE, p)`, `os.path.relpath(p, BASE)`) that is not absolute and
  does not start with `..`, or with `../` once it is also not `..` itself
- for any of these: a call to a project function that returns true only when one of
  its parameters passes such a check (`if not is_within(BASE, path): raise`). What
  the function returns is read: the tests it returns and the guards around each
  return of something other than `False`, `None` or `null`

A test whose block ends in a call that never returns (`abort(400)` in Flask,
`sys.exit()`) protects the code after it, as one that ends in `raise` does. The call
must resolve to Flask's, Quart's or werkzeug's `abort`, `sys.exit`, `os._exit` or the
builtin `exit`: a project function named `abort` returns.

A check holds only until a name it checks is assigned again, for a check helper's
arguments too. A path helper's checks count only for the returns they guard.

A file name built so that it holds no path separator and is never `.` or `..` stays
in the directory it is joined to, and carries nothing to a file effect. Such names
come from:

- `secure_filename`, `sanitize-filename` and Django's `get_valid_filename`;
- python-slugify, unless its `separator`, `replacements` or `regex_pattern` can put a
  separator back;
- a name-only sanitizer (`basename`, `path.parse(p).name`, `PurePath(p).stem`, the
  `slugify` package, a URL's `hostname`, or a `replace` or `re.sub` that removes `/`
  and `\` everywhere, with no `count`, including chained Python `str.replace` calls)
  when fixed text other than
  dots sits in the same component
  (`` `${name}.wav` ``, `` `${host}-${slug}` ``), or when its input holds a fixed
  letter. Generated ids (`uuid`'s `v4()`, `crypto.randomUUID()`, `nanoid()`,
  Python's `uuid.uuid4()`) count as such text, also read from an object literal the
  code never changes (`data.id` of `{ id: v4() }`);
- a project function that builds its result in one of these ways.

A path built from fixed text and such names (`` `/srv/${slug}.txt` ``) keeps each
name in its own component, so it stays under its fixed part. A name that may be `..`
still cannot be opened as a file when it ends the path, so it is allowed there for
calls that read or write a file's contents (`open`, `read_text`, `readFile`,
`writeFile`). It is not allowed for calls that list, link, move, delete or change a
path (`os.listdir`, `chmod`, `rename`), which act on the folder `..` names.

An absolute path (`path.resolve`, `os.path.realpath`, or a project function
returning one) among a program's arguments cannot be read as an option. It is read
as a file path instead: it carries input only where it could leave its folder, as
`rm -f` on `os.path.realpath(os.path.join(CACHE, name))` does with a raw name. In a
library scan, such a path that the caller passes whole is the caller's file and is
not reported.

Values built from a checked name are checked too. A path returned by a project
function counts as checked when every value the function returns is a resolved path
it checked in that way, or one built without its arguments, directly or through
another such function (`open(report_path(name))`). There the base may come from the
function's own parameters (`safe_join(base, name)`). A collection is fixed when it is
a non-empty literal the code never changes in place. A check inside a `try` also
covers the code after it when every handler leaves the function.

A handler whose trace stopped short carries a `trace` entry in the JSON
inventory: calls past the depth limit, and calls whose target is chosen at run
time, such as a callback parameter, a subscript of a table that is not fixed
(`handlers[name](args)`) or a call's result (`getattr(tools, name)(args)`). Up to
ten of those calls are listed by location. The coverage section of every report
lists these handlers, and findings about them, or about an agent using them, carry
a "Trace incomplete" note. Effects behind those calls are not seen.

## Findings

Findings come last, most urgent first. JSON, SARIF and Markdown list every one.
Each finding has:

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

The rule catalog lists the checks; [RULES.md](../RULES.md) describes each one
with its remediation. Most are about agents, tools, prompts and MCP. PLG901 to PLG907
report only in [library scans](#library-scans). PLG001 to PLG003 cover
[runtime advisories](#runtime-advisories). PLG801 to PLG807
cover web routes with no model in between. They report request input that reaches,
in the handler or in project functions it calls in other files:

- a command;
- a file path, including Flask's `send_file`, FastAPI's `FileResponse` and the
  pattern of `Path.glob`;
- SQL text, including Django `cursor().execute`, `raw` and `extra`, SQLAlchemy
  `text`, Sequelize and TypeORM `query`, and Prisma's `query_raw` and
  `$queryRawUnsafe`;
- the host of a URL;
- code, including hub modules loaded with `get_class_from_dynamic_module` and
  Pyodide's `runPython`;
- a template: `render_template_string`, `jinja2.Template`, `ejs.render`,
  `handlebars.compile` and others;
- a deserializer, including `pandas.read_pickle` and statsmodels' `load_pickle`.

Routes are read for FastAPI, Flask, Django, Starlette, aiohttp, Express, Fastify,
Hono, Koa, NestJS (with the `@Controller` prefix) and Next.js. Request input is a
handler parameter or a request global such as `flask.request`. These are not request
input:

- FastAPI parameters filled by `Depends` or `Security`, or typed as a number,
  boolean, UUID or date;
- response parameters (`res`, `response`, `next`).

A row returned by a database lookup (`.query(...).first()`, `Model.objects.get(...)`,
`prisma.user.findUnique(...)`) does not carry the values it was found by, so stored
data is not traced (second-order injection). Data received over the network is, by
PLG809 to PLG812 below. An approval or input check done by a proxy, middleware or
configuration outside the code is not seen and leaves a finding at medium
confidence. Checks other than the ones under [Capabilities](#capabilities), such as
a call to a sanitizer, are recognised by name, not verified, and lower confidence
instead of removing the finding.

PLG808 reports a tar archive extracted with `tarfile` and neither `filter="data"` (or
`"tar"`) nor a `members` selection, wherever the archive comes from: its members are
the untrusted input. An archive opened from a literal path ships with the code and is
left out.

PLG809 to PLG812 report data received over the network that reaches a shell command
or a program's name, a file path, code or a deserializer. Received data is the result
of an HTTP client (`requests`, `httpx`, `aiohttp`, `urllib`, `fetch`, `axios`,
`got`), a socket or zmq receive (`recv_pyobj` unpickles too), an FTP listing or an S3
listing, and of a project function that returns one of these. Confidence is medium:
whether the remote end is trusted is outside the scan. Received data among a fixed
program's arguments is not reported.

## Runtime advisories

PLG001 to PLG003 report a known critical vulnerability in the runtime a project
deploys on, not in its code. The first advisory is PHP2Shell (CVE-2026-109618,
CVE-2026-109619), fixed in PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35. The scan reads
these files in every language, with or without the AI review's text files:

- Dockerfiles and Containerfiles: `FROM` images with `ARG` defaults filled in,
  and PHP packages installed with `apt-get`, `apk`, `dnf`, `yum` or `zypper`;
- Compose files and Kubernetes manifests: `image:`;
- `composer.json`: `config.platform.php`;
- `*.ini`, `.user.ini`, `*.conf`, `.htaccess` and the `ini_set()` calls in
  parsed PHP code: where `session.upload_progress.enabled` is turned off.

PLG001 reports an image pinned below the fix of its branch (`php:8.3.35-apache`)
or on an end-of-life branch (`php:8.1-fpm`, `php:7.4`). PLG002 reports a version
the build decides: a floating tag (`php:8.3-apache`), an application image such
as `wordpress:6.6-apache`, a build argument without a default, or distribution
packages, which get fixes as backports. PLG003 reports the setting turned off by
`ini_set()` or in `.user.ini`, where it does not take effect. A stage that only
other stages copy from does not ship and is not reported. An image that runs the
PHP CLI is rated one step lower. A `composer.json` platform is reported only for
an end-of-life branch and only when no image or package declares PHP. CI
definitions are not read.

The repository shows the declared runtime, not the one a server runs. Check
deployed hosts with a live scanner as well. The design and its limits are in
[design/runtime-advisories.md](../design/runtime-advisories.md).

## Library scans

The engine option `library: true` scans a package rather than an application. A package's
flaws are often in code that no route or tool of its own reaches: a loader, a store
or a helper whose callers pass the input. A library scan counts the parameters of the
package's public functions and methods as untrusted input and reports them with
PLG901 to PLG907. The dashboard uses the default application mode. Contributors exercise library
mode with `pnpm evaluate --corpus test/fixtures/evaluation-library`.

The public functions and methods are:

- module-level functions and the methods of module-level classes;
- in Python, names without a leading `_`, and dunder methods such as `__init__`, in
  modules whose file and directory names do not start with `_`;
- in JavaScript and TypeScript, exported functions and the methods of exported
  classes, except names that start with `_` or `#`.

Code under `tests`, `examples`, `docs`, `benchmarks` and `scripts` directories is not
part of the API. `self`, `cls` and `this` are not input. A function inside a function
is not public, but its effects count for the public function that calls it.

What a library scan reports:

- a file path or URL only when the function places a parameter on a base it chooses
  itself (`os.path.join(self.root, key)`, `f"/srv/{name}"`) or reads it from inside a
  parameter (`config["template_path"]`, `element.url`, `kwargs.get("path")`). A path
  or URL whose start the caller passes (`open(path)`, `os.path.join(directory, name)`,
  `httpx.get(f"{base_url}/v1")`) is the caller's choice and is not reported;
- a shell command, SQL text, code, a template or deserialized data built from a
  parameter, at medium confidence;
- the same received whole (`subprocess.run(command, shell=True)`, `eval(expression)`,
  `pickle.loads(payload)`), at low confidence: running it is what the function is
  for;
- a program a parameter names, parameters among a program's arguments, and a module
  a parameter names (`importlib.import_module`), at low confidence.

Confidence is never high, because the scan does not see the callers. A check on the
way lowers medium to low. The checks that confine paths and limit values in other
scans also apply here. Each effect is reported once, from the function that reaches
it with the most confidence and the fewest calls; an effect that a tool or route rule
already reports is not reported again. The summary and the JSON report
(`library.functions`) say how many public functions were traced, and the capabilities
of tools and routes gain `given`: the inputs a caller passes whole.

Library scans are for packages. On an application they also report a helper that is
safe only because its route checks the input first. The
[2026-10-20 record](../qualifications/detection-static-2026-10-20-library.md) measures
both, and the mode on 105 published advisories.

## JSON output and redaction

The JSON report includes every inventory item with its location, every capability
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

The engine option `facts: true` includes, per file, the imports, definitions (with
decorators, base classes and docstrings), assignments and calls as JSON. Call
targets are resolved through imports, variables, `self`/`this` attributes and
destructuring into canonical names such as `openai.OpenAI().chat.completions.create`
(Python) or `openai#default().chat.completions.create` (JS/TS). The fact model
is [src/facts/model.ts](../../src/facts/model.ts). Facts use the static report
contract and are retained by the engine and offline evaluation tools.

PHP facts name classes and functions by their fully qualified names, through `use`
declarations and the file's namespace: `GuzzleHttp\Client().get`,
`App\Models\User.find`. A function name nothing defines or imports is the global
function (`shell_exec`). Variables keep their `$`, and a function sees only its
parameters, its `use` variables and its own assignments. Superglobals are globals
keyed by the string they are read with (`$_GET.page`). `include` and `require`,
and backticks (as `shell_exec`), are recorded as calls, PHP 8 attributes as
decorators, and interpolations show as `{$expr}` in a string's text.
