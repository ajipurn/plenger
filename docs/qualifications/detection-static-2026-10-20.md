# Static detection with return-value summaries, 2026-10-20

This change makes the effect tracer read project functions in two ways.

- **Return flow.** The result of a call into a project function is computed only
  from the arguments its return values use, and from the request globals the
  function reads, such as `flask.request`. Before, a call's result was taken to
  depend on every argument, and request globals read inside the function were
  missed. Plenger keeps the old over-approximation where it cannot tell what a
  function returns: a class, a generator, ten or more returns, or a JS function
  that unpacks its parameters.
- **Check helpers.** An `if` test that calls a project function now counts as a
  check of the arguments that function confines, as in `if not is_within(BASE,
  path): raise`. What the function establishes is read from its returns: the tests
  it returns, and the guards around each return that is not a falsy literal. A path
  measured with `path.relative` or `os.path.relpath` counts as confined when the
  result is not absolute and does not start with `..`. A result that starts with
  `../` also counts, once the code rules out `..` itself.

A JS function that unpacks its parameters (`({ uri, options }) => ...`) now binds
the entries of an object literal passed to it, by key. Before, it bound the whole
literal to the first unpacked name and lost the flow. The web route rules count
only the handler's own parameters and request globals as request input. A parameter
of a function further down that tracing could not bind no longer counts.

## Evaluation corpus

The corpus has 106 labeled cases in `test/fixtures/evaluation`: 54 vulnerable and
52 safe near-misses. The four new cases are two pairs, written alongside the change:

- `ts-route-download-helper-checked` (safe) and `ts-route-download-helper-prefix`
  (vulnerable). An Express download route checks the resolved path with a helper
  in another module. The safe helper measures the path with `path.relative`. The
  vulnerable helper only checks a prefix without a separator, so `downloads_old`
  passes.
- `py-route-host-helper-shell` (vulnerable) and `py-route-host-helper-lookup`
  (safe). A Flask route runs a shell command with a host that a helper reads from
  `flask.request`. The safe helper maps it to a fixed table.

| Scanner | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| `f110b81`, before | 46 | 1 | 8 | 51 | 0.98 | 0.85 |
| This change | 47 | 0 | 7 | 52 | 1.00 | 0.87 |

On the two new pairs, the old scanner gets one wrong in each pair:

- It reports the safe `ts-route-download-helper-checked`, because it does not
  read the helper.
- It misses `py-route-host-helper-shell`, because it does not see the request read
  inside the helper.

The other 102 cases give the same result with both scanners. The seven false
negatives that remain are the two Go and Java cases and the five authorization
cases listed in the [2026-10-19 record](detection-static-2026-10-19.md#evaluation-corpus).

## Open-source projects

The same six snapshots as the
[2026-10-17 record](detection-static-2026-10-17.md#open-source-projects) were
scanned read-only by `f110b81` and by this change. Nothing was installed or run.

| Project | Findings before | Findings after | Traced input parts with a source, before / after |
| --- | --- | --- | --- |
| SuperAGI | 17 | 17 | 86 / 81 |
| ai-chatbot | 0 | 0 | 7 / 8 |
| anything-llm | 2 | 6 | 2 / 12 |
| crewAI-examples | 0 | 0 | 0 / 0 |
| gpt-researcher | 0 | 0 | 5 / 5 |
| openai-agents-python | 0 | 0 | 0 / 0 |

The last column counts the names input parts are traced to, over every tool and
route effect. On SuperAGI it fell because call results no longer carry arguments
their functions do not return. On anything-llm it rose because unpacked parameters
now bind.

The four new anything-llm findings are PLG802 at medium confidence, two routes
each reaching two writes:

- **`downloadURIToFile`.** It writes to a name built from the URL's host and
  `slugify(pathname)`, with `/` mapped to `-`.
- **The YouTube transcript loader.** It creates a folder named by
  `sanitizeFileName`, which strips `/` and `\`.

Both are false positives. The flow from the request's `link` is real, but neither
name can hold a path separator, and plenger does not read these sanitizers.
Before this change, both flows were lost at the unpacked parameters of
`processAsFile` and `loadYouTubeTranscript`.

The two earlier anything-llm findings remain. `isWithin` is now read, but it checks
the input path, and both findings come from the output path, built with
`path.parse(filename).name`. No SuperAGI finding changed.

Scan times stayed within run-to-run variation on five projects, and
openai-agents-python was faster (8.8 to 11.4 s before, 7.7 s after, on single
runs).

## Gaps

- A name built by a sanitizer that removes separators (`slugify`, a `replace` of
  `/` and `\`, `path.parse(x).name` with a fixed suffix) is not read as confined.
- Checks confine for file effects only. An absolute resolved path is not read as
  safe among a program's arguments, though it cannot start with `-`.
- A check helper's base may come from its own parameters; the base the caller
  passes is not checked.
- Results of library calls (an ORM lookup by a request id) still depend on every
  argument.
