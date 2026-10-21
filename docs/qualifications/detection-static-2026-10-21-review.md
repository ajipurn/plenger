# Static detection: false negatives from a code review, 2026-10-21

A review of the thirteen unpushed commits that add the web route rules, return-value
summaries, name sanitizers, the advisory benchmark, library scans and the sink gap
fixes found eight ways a real flow went unreported. Each was reproduced with a small
project before it was fixed. Four of them were regressions against `f110b81`, the
first scanner with the route rules: unpacked parameters, the `..` allowance, absolute
program arguments, and the path helper's guards.

- **Guards around each return.** A path helper counted as confining when a check
  anywhere in it named the value, even a check that guarded another return:

  ```python
  def report_path(name):
      if name in ALIASES:
          return os.path.join(REPORTS_DIR, ALIASES[name])
      return os.path.join(REPORTS_DIR, name)
  ```

  Code facts now record where each return is (`returnSpans`), and only the guards
  whose region holds a return count for it.
- **Reassigned check helper arguments.** After `if (!isWithin(BASE, target)) return`,
  `target = req.query.other` kept `target` checked. A check helper's guard now ends
  where a name passed to it is assigned again, as a plain guard already did.
- **Calls that never return.** An `if` body that ended in any call named `abort` or
  `exit` counted as leaving the block, a project's own `def abort(code): print(...)`
  too. The call must now resolve to Flask's, Quart's or werkzeug's `abort`,
  `sys.exit`, `os._exit` or the builtin `exit` or `quit`.
- **Unpacked parameters.** A JS function with an unpacked parameter bound only the
  entries of an object literal, by key. `readDoc(req.query)` for
  `function readDoc({ name })` bound nothing, and nor did `name` in
  `function readWith(name, { encoding })`. Code facts now record what each parameter
  binds by position (`unpacks`, which replaces `destructured`). A name a pattern
  unpacks gets its key's entry from an object literal and the whole argument
  otherwise; plain parameters bind by position.
- **The `..` allowance.** A name that may be `..` was allowed at the end of a path for
  every read and write but moves. `os.listdir`, `iterdir`, `glob`, `readdir`, `chmod`,
  `chown` and `mkdir` act on the folder `..` names, so the allowance now applies only
  to sinks that open a file's contents (`open`, `read_text`, `write_text`, `readFile`,
  `writeFile`, `createReadStream`), marked `contents` in the sink catalog.
- **Absolute program arguments.** An absolute path among a program's arguments
  carried nothing, since it cannot be an option. A program still acts on it: `rm -f`
  on `os.path.realpath(os.path.join(CACHE, name))` deletes any file a raw name
  reaches. Such a path is now read as a file path, with the checks and sanitizers for
  files. It is reported as PLG801 when it can leave its folder. A helper that makes
  its argument absolute binds the caller's value the same way. Input parts in such a
  path carry `path`. In a library scan, an absolute path the caller passes whole is a
  file the caller chooses, as for PLG902, and is not reported.
- **`re.sub` with a count.** `re.sub(r"[/\\]", "", name, count=1)` removes one
  separator, but was read as removing all of them. A `count` other than `0` now
  leaves the name unread. Keyword arguments are matched by name.
- **`os.chmod` and `os.makedirs`.** `os.makedirs`, `os.mkdir`, `os.chmod` and
  `os.chown` took their input from `dst|#1|#0` with the rename family, which for
  them is the mode or owner. They now trace `path|name|#0`. This one predates the
  reviewed commits.

The first fix removed a wrong reading that had made some confined paths look
confined for the wrong reason, and the open-source scans below showed three of them.
Three readings now see why those paths are confined:

- A generated id holds only letters, digits, `-` and `_`: `uuid`'s `v1()` to `v7()`,
  `crypto.randomUUID()`, `nanoid()` and Python's `uuid.uuid1()` to `uuid.uuid5()`.
- A member of an object literal the code never changes in place reads as its entry:
  `data.id` of `data = { id: v4() }`.
- `path.relative_to(BASE)` as a statement in a `try` whose handlers all leave
  confines the path after the `try`, as langchain's file search does.

## Evaluation corpus

The corpus has 134 labeled cases in `test/fixtures/evaluation`: 68 vulnerable and 66
safe near-misses. The eight new cases are four pairs:

| Pair | Vulnerable | Safe |
| --- | --- | --- |
| Report download, Flask (CWE-22) | `py-route-report-fallback`: the helper passes names other than aliases through | `py-route-report-known`: it refuses names outside the fixed reports first |
| Upload listing (CWE-22) | `py-route-listing-basename`: `os.listdir` of `basename(folder)`, which may be `..` | `py-route-listing-secure-filename`: `secure_filename`, never `..` |
| Docs, Express (CWE-22) | `ts-route-doc-unpacked-query`: `readDoc(request.query)` for `readDoc({ name, encoding })` | `ts-route-doc-unpacked-checked`: the helper checks the unpacked name |
| Cache eviction (CWE-22) | `py-route-cache-evict-joined`: `rm -f` on the resolved path of a raw name | `py-route-cache-evict-secure`: the name passes `secure_filename` first |

The safe transcode case `ts-route-transcode-resolved-input` passed ffmpeg
`path.resolve(MEDIA, name)` with a raw name. That path cannot start with `-`, but it
can leave the media folder, so the case was not safe. Both transcode cases now check
the name against `^[\w-]+$` first. The pattern admits a leading `-`, so the
vulnerable case, which passes the name as is, still lets an option through. The safe
case resolves the name inside the folder.

| Scanner | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| `51f2b27`, before | 57 | 0 | 11 | 66 | 1.00 | 0.84 |
| This change | 61 | 0 | 7 | 66 | 1.00 | 0.90 |

The earlier scanner misses the four new vulnerable cases and reads every safe case
as safe. The seven false negatives that remain are the two Go and Java cases and the
five authorization cases listed in the
[2026-10-19 record](detection-static-2026-10-19.md#evaluation-corpus). The library
corpus is unchanged at 9 true positives and 9 true negatives. The golden files under
`test/fixtures` are unchanged.

Each fix also has a regression test in `test/rules.test.ts` with a safe near-miss,
and the three readings share a ninth. All nine tests fail on `51f2b27` and pass after
the change.

## Open-source projects

The same six snapshots as the
[2026-10-17 record](detection-static-2026-10-17.md#open-source-projects) were
scanned read-only by `51f2b27` and by this change. Nothing was installed or run.

| Project | Findings before | Findings after |
| --- | --- | --- |
| SuperAGI | 17 | 17 |
| ai-chatbot | 0 | 0 |
| anything-llm | 6 | 8 |
| crewAI-examples | 0 | 0 |
| gpt-researcher | 0 | 0 |
| openai-agents-python | 0 | 0 |

The two new anything-llm findings are PLG802 for `POST /process` and `POST /parse`,
at the `fs.rmSync` in `trashFile`. Both are false positives. `processSingleFile`
checks `isWithin(WATCH_DIRECTORY, fullFilePath)` only when `options.absolutePath` is
unset, and it calls `trashFile` only then too. Plenger does not relate the two
conditions. Before, the flow was hidden by the wrong reading the first fix removes:
`normalizePath` counted as confining, because the guard of
`if (["..", ".", "/"].includes(result)) throw` was read at its return.

Without the three readings above, the first fix also reported three of anything-llm's
document writes, whose names hold a `v4()` id, and langchain's file search on the
fixed tree of GHSA-gr75-jv2w-4656.

## Advisory benchmark

The 105 advisories of the [2026-10-20
manifest](../../test/fixtures/advisories/manifest.json) were scanned offline from the
cache of the [library record](detection-static-2026-10-20-library.md#advisory-benchmark)
by `51f2b27` and by this change:

```sh
node scripts/advisories.ts run --cache <dir>
node scripts/advisories.ts run --library --cache <dir>
```

Both reports are byte-identical to the ones before the change. The vulnerable trees
give the same findings: 317 in a default scan and 888 with `--library`. The fixed
trees gain one, in both modes. It is an PLG802 at `os.makedirs(upload_dir)` in
dbgpt's document upload, on the fixed tree of GHSA-j9g7-mqhh-9hxf, which
`os.makedirs` now traces. That route still checks the path only with a substring test
(`ROOT in target_path`), and the scanner already reported two PLG802 findings in it.

## Gaps

- A check that holds only under a condition the effect also needs is not read:
  `if (!options.absolutePath && !isWithin(BASE, p)) return`, then
  `if (!options.absolutePath) trashFile(p)`. Plenger does not relate conditions.
- `os.path.join` of an absolute base and a name is not read as absolute, so a name
  that may start with `-` joined onto a resolved folder still reads as a possible
  option.
- python-slugify's `separator` and `replacements` options are not read.
