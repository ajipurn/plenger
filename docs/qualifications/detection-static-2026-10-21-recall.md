# Static detection: what the missed advisories needed, 2026-10-21

The [library scan record](detection-static-2026-10-20-library.md#gaps) named
constructor arguments kept on `self` as the shape of most missed advisories. Before
building that, the 85 advisories that library scans still missed were read one by
one. Five read-only agents each took 17 advisories. Each read the fix diff and the
code around it in the cached trees, and named what plenger lacked, from a fixed
list. Nothing was run.

| What plenger lacked | Advisories |
| --- | --- |
| Nothing it can judge: the flaw bypasses an existing check (IPv6 forms, redirects, DNS rebinding, encodings, Windows paths) | 25 |
| Data received over the network, a stored value or a remote listing as input | 15 |
| The dangerous call as a sink | 14 |
| The flow: callbacks, `**kwargs` spreads, comprehensions, conditional module aliases | 13 |
| Other: the manifest points at an unrelated commit (2), the CWE label names another family than the cited rule (2), the flaw is in an unscanned file | 10 |
| Nothing: not a data flow (authorization, symlinks, races, temporary files) | 6 |
| The request as a source, reaching the code through a helper plenger does not read | 2 |

Constructor arguments on `self` were the main reason for none of them, and a
secondary reason for six. Code facts already resolve `self.web_path` in `load()` to
its assignment in `__init__`; the langchain loader advisories are about links and
redirects the loader fetches, which are second-order. This change takes the sinks,
part of the received data and part of the flow.

## Changes

- **Sinks.**
  - Flask's `send_file` and FastAPI's and Starlette's `FileResponse` read files.
  - The pattern of `Path.glob` and `rglob` is a path.
  - Prisma's raw SQL (`query_raw`, `query_first`, `execute_raw`, `$queryRawUnsafe`,
    `$executeRawUnsafe`) is a query.
  - Pyodide's `runPython` and transformers' `get_class_from_dynamic_module` and
    `get_cached_module_file` run code.
  - `pandas.read_pickle` and statsmodels' `load_pickle` unpickle.
- **Flow.**
  - Python comprehensions bind their loop names to items of their iterables, in a
    scope of their own.
  - In `for i, item in enumerate(items)`, `i` is a count, not an item.
- **PLG808.** A tar archive extracted with `tarfile` and neither `filter="data"` (or
  `"tar"`) nor a `members` selection, wherever the archive comes from: its members are
  the untrusted input.
  - An archive opened from a literal path ships with the code and is left out.
  - A call named like a check that takes the archive first
    (`check_tarfile_security(archive_path)`) is read by its name, not verified, and
    lowers confidence to low.
- **PLG809 to PLG812.** Data received over the network that reaches a shell command or
  a program's name (PLG809), a file path (PLG810), code (PLG811) or a deserializer
  (PLG812).
  - Received data is the result of an HTTP client (`requests`, `httpx`, `aiohttp`,
    `urllib`, `fetch`, `axios`, `got`), a socket or zmq receive, an FTP or S3
    listing, or a project function that returns one of these. They are found the way
    model output is found for PLG401.
  - Confidence is medium, and low when checks are seen on the way.
  - Received data among a fixed program's arguments, and received data that decides
    a URL's host, are not reported: following links and redirects is what crawlers
    and loaders are for.
- **Found on the way.**
  - `const axios = require("axios")` names `axios.get` as `axios#get`, which the
    network sinks did not match. SSRF through CommonJS `axios`, `got` and `ky` went
    unreported.
  - A file object or an in-memory stream given to a file sink
    (`send_file(io.BytesIO(data))`) is not a path.
  - A hex digest (`hashlib.sha256(...).hexdigest()`) is a file name part, as other
    generated ids are.
  - The benchmark's path family now includes the named traversal variants (CWE-24 to
    CWE-34, CWE-37 to CWE-40). Eight advisories are labeled CWE-29 only.

## Evaluation corpus

The corpus has 150 labeled cases in `test/fixtures/evaluation`: 76 vulnerable and 74
safe near-misses. The 16 new cases are eight pairs:

| Pair | Vulnerable | Safe |
| --- | --- | --- |
| Model archive (CWE-22) | `extractall` with no filter | `filter="data"` |
| Export download (CWE-22) | `send_file(os.path.join(EXPORTS_DIR, name))` | `send_from_directory` |
| Sheet cells (CWE-95) | `eval` in a nested comprehension over request rows | `ast.literal_eval` |
| Spend logs (CWE-89) | Prisma `query_raw` with the key in the SQL text | the key bound as a parameter |
| Remote settings (CWE-95) | `eval(response.text)` | `ast.literal_eval` |
| Remote weights (CWE-502) | `torch.load` of downloaded bytes | `weights_only=True` |
| Bucket mirror, JS (CWE-22) | files written under listed names | `path.basename` of each name |
| Job worker (CWE-78) | the job's command through a shell | a fixed command per task name |

| Scanner | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| `93a3a73`, before | 61 | 0 | 15 | 74 | 1.00 | 0.80 |
| This change | 69 | 0 | 7 | 74 | 1.00 | 0.91 |

The earlier scanner misses the eight new vulnerable cases and reads every safe case as
safe. The seven false negatives that remain are the two Go and Java cases and the five
authorization cases. The library corpus is unchanged at 9 true positives and 9 true
negatives.

## Advisory benchmark

The 105 advisories of the [2026-10-20
manifest](../../test/fixtures/advisories/manifest.json) were scanned offline from the
cache of the [library record](detection-static-2026-10-20-library.md#advisory-benchmark)
by `93a3a73` and by this change:

```sh
node scripts/advisories.ts run --cache <dir>
node scripts/advisories.ts run --library --cache <dir>
```

| Scan | Reported before the fix | Still reported after it | Cleared by the fix |
| --- | --- | --- | --- |
| Default, before | 4 | 4 | 2 |
| Default, this change | 9 | 7 | 4 |
| `--library`, before | 20 | 17 | 5 |
| `--library`, this change | 29 | 23 | 8 |

Recall on the benchmark rises from 4% to 9% in a default scan and from 19% to 28% with
`--library`. The nine advisories reported now and not before:

| Advisory | Rule | After the fix |
| --- | --- | --- |
| llama-index GHSA-pw38-xv9x-h8ch | PLG811: `eval` of server-sent event data from the RunGPT endpoint | cleared: the fix removes the `eval` |
| vllm GHSA-x3m8-f7g5-qhm7 | PLG812: `pickle.loads` of bytes a Mooncake transfer engine received | cleared: the fix removes `pickle` |
| langchain-experimental GHSA-cgcg-p68q-3w7v | PLG905: `eval` of each value of each row in a comprehension | cleared: the fix removes the `eval` |
| mlflow GHSA-wc6j-5g83-xfm6 | PLG802: `send_file` of an artifact path from the request | still reported: the fix's validator is not read as confining |
| mlflow GHSA-fhff-qmm8-h2fp and GHSA-vhcx-3pq2-4fvc | PLG808: `extractall` with no filter | still reported, at low: the fix calls `check_tarfile_security` first |
| mlflow GHSA-gqvg-gmmx-x4hm | PLG907: statsmodels `load_pickle` of the loaded model's path | still reported: the fix adds a policy switch |
| vllm GHSA-2pc9-4j83-qjmr | PLG905: `get_class_from_dynamic_module` of a model's `auto_map` entries | still reported: the fix adds a `trust_remote_code` gate |
| flowise GHSA-x6vm-w76m-8j7g | PLG905: Pyodide `runPythonAsync` of code built from a node input | still reported: the fix extends a denylist |

Five of the nine are reported by a default scan too: llama-index, vllm Mooncake,
mlflow's `send_file` and the two tar advisories. The other four need `--library`. Where
the advisory stays reported, the fix kept the effect and added a check that plenger
reads by name or not at all.

The vulnerable trees hold 344 default findings instead of 317. PLG802 findings rise
from 112 to 141: the new file sinks add findings on routes in mlflow, gradio, chainlit
and open-webui that send files, and hex digest names remove some in open-webui's speech
cache. The `enumerate` change removes all ten PLG803 findings, in open-webui:
`text(f"... :{param}")` where `param` is `f"tag_id_{index}"`, a bound-parameter name
built from an `enumerate` count.

## Open-source projects

The same six snapshots as the
[2026-10-17 record](detection-static-2026-10-17.md#open-source-projects) were scanned
read-only by `93a3a73` and by this change. Nothing was installed or run.

| Project | Findings before | Findings after |
| --- | --- | --- |
| SuperAGI | 17 | 17 |
| ai-chatbot | 0 | 0 |
| anything-llm | 8 | 11 |
| crewAI-examples | 0 | 0 |
| gpt-researcher | 0 | 1 |
| openai-agents-python | 0 | 0 |

The four new findings were read:

- **anything-llm, two PLG810 at low.** Speech-to-text reads and deletes the WAV file
  the collector service names in its JSON reply, joined to the hot directory with no
  check. The reply comes from the project's own service, so the risk is low, but the
  flow is real.
- **anything-llm, one PLG810 at low.** The DrupalWiki loader writes each page under
  `sanitizeFileName(`${slugify(title)}-${id}`)` plus `.json`. That name cannot leave
  the folder; plenger does not read two things here (see Gaps).
- **gpt-researcher, one PLG802.** `FileResponse(os.path.join("outputs",
  f"{research_id}.docx"))` with a FastAPI path parameter. The default converter does
  not admit `/`, so this is a false positive.

## Gaps

- Path parameters of FastAPI, Starlette, Flask and Express routes are read as any
  text, though their default converters do not admit `/`.
- A sanitizer that returns a falsy input unchanged (`if (!name) return name;`), and a
  suffix added outside `path.resolve` (`path.resolve(dir, name) + ".json"`), are not
  read.
- Received data that decides a URL's host is not reported, so SSRF through crawled
  links and redirects stays out of reach (langchain's `RecursiveUrlLoader`, open-webui's
  web loaders).
- Flows through a store are not followed: a request value saved by one handler and
  used by another (mlflow model version sources, webhook URLs).
- Callbacks passed to traversal helpers (gradio's `traverse`), `**kwargs` spreads of
  request bodies (litellm), conditional module aliases (`impl = a if c else b`) and
  objects built by registries are still lost.
- 25 advisories bypass a check plenger accepts. Judging such a check as too weak is
  out of reach of these rules.
