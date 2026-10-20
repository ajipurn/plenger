# Static detection: library scans, 2026-10-20

The [advisory benchmark](detection-static-2026-10-20-advisories.md#advisory-benchmark)
showed that 60 of the 101 advisories the static rules missed have no route or tool in
the scanned code. The flaw is in library code, such as langchain loaders, llama-index
or vLLM, whose callers pass the input. This change adds an opt-in mode for that code:

- `plenger scan --library` counts the parameters of a package's public functions and
  methods as untrusted input;
- seven rules, PLG901 to PLG907, report them reaching a command, a file path, SQL text,
  the host of a URL, code, a template or a deserializer;
- `scripts/advisories.ts run --library` runs the benchmark in that mode;
- a library corpus of nine pairs, `test/fixtures/evaluation-library`.

Scans without `--library` are unchanged. The [scanning
guide](../guide/scanning.md#library-scans) describes the mode.

## How a library scan decides

A function is public when a caller can reach it by name: a module-level function or a
method of a module-level class, without a leading `_` in Python (dunder methods
count), exported in JavaScript and TypeScript. Tests, examples, docs, benchmarks,
scripts and Python modules named with a leading `_` are left out. Each public function
is traced like a route handler, through the project functions it calls.

Taking a parameter is what most library functions are for. A loader opens the path it
is given, and a client fetches the URL it is given. The tracer therefore records, for
each effect, the inputs the function received whole: a parameter, an item of one, one
converted (`str()`, `Path()`, `os.path.abspath`), or the start of a path joined onto
it. The rules use that record:

- A file path or URL is reported only when the function places a parameter on a base
  it chooses itself (`os.path.join(self.root, key)`), or reads it from inside a
  parameter (`config["template_path"]`, `element.url`). A path or URL whose start the
  caller passes is not reported.
- A shell command, SQL text, code, a template or deserialized data is reported at
  medium confidence when it is built from a parameter, and at low confidence when the
  function receives it whole.
- Program arguments, a program a parameter names and a module a parameter names are
  reported at low confidence.

No library finding is rated high, because the scan does not see the callers. Each
effect is reported once, from the function that reaches it with the most confidence
and the fewest calls. An effect a tool or route rule already reports is not reported
again.

The path and URL rule changed twice during this work, before the record below. Its
first version reported any path not received whole. That counted paths computed by
calls over a parameter (`inspect.getfile(cls)`, a run record looked up by id) and
two-argument APIs (`read_yaml(root, file_name)`). On the 105 advisory trees, the two
changes cut PLG902 findings from 735 to 283 and PLG904 findings from 133 to 81. The
number of advisories reported went from 21 to 20. The one lost, mlflow
GHSA-wp72-7hj9-5265, was a copy inside the function just above the helper its fix
added, not its flaw.

## Default scans

The evaluation corpus is unchanged at 118 cases: 53 true positives, 0 false positives,
7 false negatives and 58 true negatives, precision 1.00 and recall 0.88. The golden
files under `test/fixtures` are unchanged. The default advisory run, from the same
cache, writes the same report as the [previous
record](detection-static-2026-10-20-advisories.md#advisory-benchmark): 4 of 105
reported before the fix.

## Library corpus

`test/fixtures/evaluation-library` has nine pairs, written alongside the rules. They
show that the rules do what they were built to do; they say little about precision on
real packages.

| Pair | Vulnerable | Safe |
| --- | --- | --- |
| Store keys, Python (CWE-22) | a key joined below the store's root | the resolved path kept inside the root |
| Store keys, TypeScript (CWE-22) | a key joined to `rootPath` | keys limited to letters, digits, `-` and `_` |
| Prompt config (CWE-22) | `config["template_path"]` read | a checked template name in the package's own folder |
| Element download (CWE-918) | `element.url` fetched | the element fetched from a fixed host by id |
| ffmpeg (CWE-78) | a shell command with the file name and format | an argument list, an absolute input and a fixed set of formats |
| Vector search (CWE-89) | the filter put into SQL text | placeholders |
| Math chain (CWE-95) | `eval` of the expression | `ast.literal_eval` |
| Prompt formatter (CWE-1336) | `jinja2.Template` | Jinja's sandboxed environment |
| Peer state (CWE-502) | `pickle.loads` | `json.loads` |

| Scan | Cases | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--library` | 18 | 9 | 0 | 0 | 9 | 1.00 | 1.00 |
| Default | 18 | 0 | 0 | 9 | 9 | n/a | 0.00 |

The safe prompt-config case first used an unanchored `re.fullmatch` pattern, which
plenger does not read as a check on the whole name, in any mode. It now uses the
anchored `re.match` form; the gap is listed below.

## The evaluation corpus in library mode

The 118 application cases scanned with `--library` give 53 true positives and 3 false
positives, precision 0.95. All three are helpers that are safe only because their
route checks the input first: `ping(host)` and `gitLog(branch)` build shell commands,
and `transcode(input)` passes its argument to ffmpeg. For a package those helpers
would be unsafe API, so the findings follow the mode's model. They show why the mode is
for packages, not applications.

## Advisory benchmark

The 105 advisories of the [2026-10-20
manifest](../../test/fixtures/advisories/manifest.json) were scanned from the cache of
the earlier run, offline:

```sh
node scripts/advisories.ts run --cache <dir>
node scripts/advisories.ts run --library --cache <dir>
```

| Scan | Reported before the fix | Of those, not reported after it | Reported after the fix |
| --- | --- | --- | --- |
| Default | 4 of 105 | 2 | 4 |
| `--library` | 20 of 105 | 5 | 17 |

Recall on the benchmark rises from 4% to 19%. Of the 20 advisories reported before
their fix, 15 are still reported after it. The 17 reported after the fix include two
that only the fixed version reports, as in the default scan (PLG104 and PLG705).

| Weakness | Advisories | Reported before the fix, default | Reported before the fix, `--library` | Reported after the fix, `--library` |
| --- | --- | --- | --- | --- |
| Path traversal | 40 | 3 | 7 | 5 |
| SSRF | 26 | 0 | 1 | 1 |
| Code injection | 21 | 1 | 8 | 7 |
| Command injection | 7 | 0 | 2 | 2 |
| Deserialization | 6 | 0 | 2 | 2 |
| SQL injection | 5 | 0 | 0 | 0 |

By the groups of misses in the earlier record:

| Earlier group | Advisories | Reported with `--library` | Not reported after the fix |
| --- | --- | --- | --- |
| No route or tool in scope (library code) | 60 | 12 | 3 |
| Effects traced, no rule of the family fired | 21 | 2 | 0 |
| Routes elsewhere, changed code not reached | 13 | 1 | 0 |
| A route in the changed file, no effect traced | 7 | 1 | 0 |
| Reported by default | 4 | 4 | 2 |

The 16 advisories that only the library rules report:

| Advisory | Before the fix | After the fix | Finding, and what the fix did |
| --- | --- | --- | --- |
| flowise GHSA-3769-jgqc-cxm7 | PLG905 | PLG905 | `executeJavaScriptCode` runs code built from `code` in vm2's `NodeVM`; the fix limits the options callers pass, the evaluation stays |
| flowise GHSA-wg86-r78f-74mp | PLG905 | PLG905 | the same function, for another sandbox escape; the fix moves URLs out of the evaluated code |
| vllm GHSA-4hhp-h66f-j5j7 | PLG904 | none | a processor fetches image and audio URLs read from its input with `requests.get`; the fix removes those fetches |
| litellm GHSA-53gh-p8jc-7rg8 | PLG905 | PLG905 | `get_instance_fn` imports a module its parameter names; the fix adds a module blocklist |
| litellm GHSA-5jmr-gcrj-2c9q | PLG902 | none | archive entries joined to a temporary directory; the fix adds a prefix check with a separator |
| langchain GHSA-7gfq-f96f-g85j | PLG906 | PLG906 | `jinja2_formatter` compiles its template with `jinja2.Template`; the fix adds a warning and refuses jinja2 in loaded configurations |
| langflow GHSA-8qpj-27x8-pwpq | PLG905 | PLG905 | the Python REPL component imports the modules its parameter names; its `exec` goes through a class plenger does not list; the fix adds a policy switch |
| langchain GHSA-f73w-4m7g-ch9x | PLG905 | PLG905 | numexpr's `stringToExpression` compiles and evaluates its expression; the fix adds a character blocklist |
| mlflow GHSA-ffw3-6378-cqgp | PLG901 | PLG901 | `PyFuncBackend.serve` passes the host among `subprocess.Popen`'s arguments, at low confidence; the fix quotes the host and replaces a `python -c` command built from paths |
| llama-index-core GHSA-fxc2-8m62-m85x | PLG905 | none | `exec(f"from {module_import_str} import {cls_name}")`; the fix uses `importlib` |
| langchain GHSA-hc5w-c9f8-9cc4 | PLG902 | PLG902 | `LocalFileStore` joins keys to its root; the fix's `startsWith(root)` has no separator, which plenger does not read as confinement |
| vllm GHSA-hjq4-87xh-g4fv | PLG907 | PLG907 | `StatelessProcessGroup.recv_obj` unpickles what it receives; the fix binds the listening socket to one interface |
| mlflow GHSA-q2r8-vmq7-fpx2 | PLG902 | PLG902 | `FileStore` joins run ids and keys below its root; the advisory's flaw is a path stored in `meta.yaml`, which the finding does not describe |
| langchain-core GHSA-qh6h-p6c9-ff54 | PLG902 | PLG902 | `load_prompt_from_config` reads `template_path` from its configuration; the fix's `_validate_path` helper is not read |
| vllm GHSA-rh4j-5rhw-hr54 | PLG907 | PLG907 | `torch.load` of checkpoint files; the fix adds `weights_only=True`, which the sink catalog does not read |
| langflow GHSA-w584-2h2r-2hvf | PLG905 | PLG905 | `validate_code` compiles and runs the code it validates; the fix changes which decorators run |

In 13 of the 16, the finding is at the advisory's flaw. Two are next to it: mlflow
GHSA-ffw3-6378-cqgp at one of the two places its fix quotes, and langflow
GHSA-8qpj-27x8-pwpq at the REPL's imports rather than its `exec`. mlflow
GHSA-q2r8-vmq7-fpx2 is not about its flaw.

Most fixes keep the effect and add a check: a blocklist, a policy switch, a warning, a
prefix test or a path helper. The library rules report where a caller's value reaches
a dangerous effect; they do not judge whether such a check is enough. Two fixed
versions stay reported because of gaps that also affect default scans:
`torch.load(weights_only=True)`, and a prefix test without a separator, which is a real
weakness of that fix.

One flaw is reported but not counted. langchain GHSA-x32c-59v5-h7fg is labeled CWE-78,
but its flaw is `exec(f"result = {query}")` in the Jira wrapper. PLG905 reports that
line at medium confidence, and the code-injection family does not match the label.

## Findings outside the fixes

The vulnerable trees of the 105 advisories hold 6,176 source files and 31,710 public
functions and methods. The library rules report 609 findings in them: 579 at low and
30 at medium confidence.

| Rule | Low | Medium |
| --- | --- | --- |
| PLG901 command | 82 | 3 |
| PLG902 path | 283 | 0 |
| PLG903 SQL | 1 | 2 |
| PLG904 URL host | 81 | 0 |
| PLG905 code | 75 | 20 |
| PLG906 template | 2 | 0 |
| PLG907 deserializer | 55 | 5 |

The 30 medium findings are 21 distinct lines, because some trees overlap. All 21 were
read:

- 14 evaluate or deserialize a caller's value:
  - flowise's `NodeVM` call;
  - six in langflow's code validation, including `exec` of import statements built
    from names;
  - the Jira `exec` and llama-index's `exec` import;
  - smolagents' `Tool.from_dict`;
  - vLLM's compiled code artifacts and `torch.load`;
  - langchain's TF-IDF `joblib` and `pickle` loads, behind an opt-in flag.

  Several of them are the flaws of advisories in the manifest.
- 2 run shell commands built from parameters: gradio's `zoom_in` and mlflow's wheel
  download command.
- 5 are not flaws a caller is likely to reach: gradio's reload `exec` of the app's own
  file (twice), pandasai's `shelve` cache file, and chainlit's two SQL texts whose
  values are bound as parameters.

Low findings were sampled, not all read. Most are by design: options objects of
clients, paths under `/proc` with a process id, and helpers whose sanitizer plenger
does not read.

Two packages from the [2026-10-17 snapshots](detection-static-2026-10-17.md#open-source-projects)
were scanned read-only in both modes:

| Package | Files | Public functions | Default findings | `--library` findings | Scan time, default / `--library` |
| --- | --- | --- | --- | --- | --- |
| openai-agents-python | 1,034 | 1,478 | 0 | 8, all low | 4.8 s / 5.1 s |
| gpt-researcher | 454 | 527 | 0 | 7, all low | 0.7 s / 0.8 s |

Reading all 15 found no confirmed flaw. Four are git and process arguments that a
caller's value could turn into an option, a weak candidate: `clone_repo` runs `git
checkout ref`. The other 11 are by design or missed sanitizers:

- URLs from a client's options;
- `/proc/{pid}` paths;
- evaluation scripts under `evals/`;
- a report name with its separators replaced;
- image names hashed from the prompt.

Over the 105 trees, the library scan took 10% longer than the default scan
(25.1 s against 22.9 s in total).

## Gaps

- Constructor arguments kept on `self` are not parameters of the other methods. A
  loader whose `__init__` takes `web_path` and whose `load()` fetches `self.web_path`
  is not reported; that is the shape of most langchain loader advisories.
- Content a library fetches or reads (links in a crawled page, members of an archive,
  a path stored in a file) is not input. These are second-order flows.
- The public API is read from names. TypeScript `private`, `__all__`, CommonJS
  `module.exports` and re-exports are not read. Folders such as `evals/` count as API.
- Sink and sanitizer gaps that also affect default scans:
  - `torch.load(weights_only=True)` is still a loader that can run code;
  - `Path(p).suffix.replace(...)` matches the pathlib `replace` sink;
  - an unanchored `re.fullmatch` pattern is not read as a check on the whole value;
  - separators removed with chained `str.replace` are not read as a name sanitizer.
- Low-confidence findings are numerous on large packages: about six per tree of up to
  150 files in the benchmark. Triage them by confidence.
- The benchmark scans the directories around each fix, at most 150 files, not whole
  packages.
