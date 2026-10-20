# Static detection: sink, sanitizer and route check gaps, 2026-10-21

The [library scan record](detection-static-2026-10-20-library.md#gaps) listed four
gaps that also affect default scans. This change closes them:

- `torch.load(..., weights_only=True)` is no longer a deserializer that can run code.
  PLG107 and PLG807 recommend it. A sink can now name an option that makes the call
  safe when it is a literal true.
- A pathlib method counts only on a path. The `**` in the pathlib sink patterns
  crossed members that are text, so `Path(p).suffix.replace(".", "")` read as a file
  move. A sink can now list call patterns it never matches: the chain past `name`,
  `stem`, `suffix`, `suffixes`, `parts`, `anchor`, `drive`, `root`, `as_posix()`,
  `as_uri()`, `read_text()`, `read_bytes()` and `open()`.
- `re.fullmatch(r"[A-Za-z0-9_-]+", name)` and a compiled pattern's `fullmatch` check
  the whole name without `^` and `$`. The guard records them as `fullmatches`, a new
  value in the report schema's guard tests.
- Python `str.replace` calls with fixed text that between them replace `/` and `\`
  make a file name, as a separator-removing `re.sub` does. Replacements that put a
  separator back, or a call with a count, are not read. A chain that does not
  remove both keeps a name that had no separator free of them, though it may then
  be `..`.

A fifth gap came up while testing the third. In a Flask route, a check on a variable
assigned from a request global did not apply, whatever the check:

```python
name = request.form["name"]
if name not in REPORTS:
    abort(400)
return open(os.path.join(BASE, name)).read()
```

The variable keeps the request global's reference, and tracing recorded that
reference as request input before it looked at the checked names. It now looks at
them first, for the variable and for calls made on it (`name.strip()`). FastAPI
parameters and tool parameters were not affected.

PyTorch before 2.6.0 had a bypass of the `weights_only` unpickler
(CVE-2025-32434). Plenger does not read dependency versions, so it trusts the
option on any version.

## Evaluation corpus

The corpus has 126 labeled cases in `test/fixtures/evaluation`: 64 vulnerable and 62
safe near-misses. The eight new cases are four pairs. Each safe case was a false
positive before this change.

| Pair | Vulnerable | Safe |
| --- | --- | --- |
| Checkpoint upload (CWE-502) | `torch.load(..., weights_only=False)` | `torch.load(..., weights_only=True)` |
| Export name (CWE-22) | `re.match` without `$`, which checks only the start | `re.fullmatch` without anchors |
| Report title (CWE-22) | `replace("../", "")`, which `....//` defeats | `replace("/", "-").replace("\\", "-")` |
| Report download, Flask (CWE-22) | a name outside the fixed reports only logged | the same test followed by `abort(404)` |

| Scanner | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| Static, before (118 cases) | 53 | 0 | 7 | 58 | 1.00 | 0.88 |
| Static, after (126 cases) | 57 | 0 | 7 | 62 | 1.00 | 0.89 |

The 118 earlier cases give the same results. The library corpus is unchanged at 9
true positives and 9 true negatives. The golden files under `test/fixtures` are
unchanged.

## Advisory benchmark

The 105 advisories of the [2026-10-20
manifest](../../test/fixtures/advisories/manifest.json) were scanned from the cache of
the [library record](detection-static-2026-10-20-library.md#advisory-benchmark),
offline, before and after the change:

```sh
node scripts/advisories.ts run --cache <dir>
node scripts/advisories.ts run --library --cache <dir>
```

| Scan | Reported before the fix | Not reported after it | Reported after the fix |
| --- | --- | --- | --- |
| Default | 4 of 105 | 2 | 4 |
| `--library` | 20 of 105 | 5 | 17 |

Both reports are byte-identical to the ones before the change. Default scans of the
vulnerable trees give the same 317 findings. Library findings fall from 609 to 571:

| Rule | Before | After | What went |
| --- | --- | --- | --- |
| PLG902 path | 283 | 259 | `Path(p).suffix.replace(".", "")` in gradio's image, image editor and video components and llama-index's `schema.py` |
| PLG907 deserializer | 60 | 46 | `torch.load(..., weights_only=True)` in vLLM's LoRA loader, multimodal media loaders and weight utilities |

All of them were read. The unanchored `fullmatch` and chained `replace` forms occur in
the trees, but not where a default or library finding was reported. The Flask change
alone changes no finding there.

vLLM GHSA-rh4j-5rhw-hr54 stays reported after its fix, now for a reason in the code.
Its fix added `weights_only=True` to six `torch.load` calls. The fixed tree had six
PLG907 findings before this change and has one after it. The one left is
`torch.load(lora_bin_file_path, map_location=device)` in
`LoRAModel.from_local_checkpoint`, the function the fix changed: the fix missed that
call.

The six open-source projects of the earlier records were not scanned again.

## Gaps

- `weights_only=True` is trusted on any PyTorch version.
- JavaScript `replaceAll("/", "-")` with a string pattern is not read as a sanitizer;
  only a global regular expression is.
