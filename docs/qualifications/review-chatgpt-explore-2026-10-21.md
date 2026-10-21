# Explore mode on the ChatGPT subscription transport, cross-file pairs, 2026-10-21

One live Explore run on the ChatGPT connection, the first live run of the
exploring review on a transport other than Claude. It covers the cases whose
deciding file is outside the first message and the two pairs in languages
without a parser, so the model has to read through its tools.

## Configuration

- Connection: saved provider "ChatGPT", Sign in with ChatGPT, model
  `gpt-6.1-sol`, plain function tools on the Responses transport. No separate
  second-review model. No saved prices, so no USD estimate.
- `pnpm evaluate --provider ChatGPT --mode explore --runs 1 --yes` on `main` at
  `0e6e80e`, prompt digest `626d00ea8dbc`.
- Corpus: ten cases copied from `test/fixtures/evaluation`, unchanged:
  `py-invoice-number-*`, `py-ticket-file-path-*` and `ts-exports-mount-*`
  (deciding file outside the first message), `go-sql-handler-*` and
  `java-download-path-*` (no parser).

## Answer

The tool loop works live on this transport. All ten reviews completed, with
58 model requests, 265 `read_file` and 6 `list_files` calls and no rejected
submission. Every vulnerable twin was found with the labeled weakness. Two safe
twins were reported for other weaknesses at the labeled lines, so precision is
0.71 counting any finding and 1.00 counting only the labeled weakness.

## Results

| Case | Truth | Detected | Finding at the label | Requests | Reads |
| --- | --- | --- | --- | --- | --- |
| go-sql-handler-concat | vulnerable | yes | CWE-89, source-supported | 2 | 0 |
| go-sql-handler-placeholder | safe | yes | CWE-862: the customer selector has no authentication | 2 | 0 |
| java-download-path-confined | safe | yes | CWE-61: a symbolic link could pass the lexical check | 3 | 0 |
| java-download-path-traversal | vulnerable | yes | CWE-22, source-supported | 3 | 0 |
| py-invoice-number-scoped | safe | no | none | 6 | 39 |
| py-invoice-number-unscoped | vulnerable | yes | CWE-639, source-supported | 9 | 42 |
| py-ticket-file-path-confined | safe | no | none | 6 | 38 |
| py-ticket-file-path-unconfined | vulnerable | yes | CWE-22, source-supported | 8 | 36 |
| ts-exports-mount-admin-role | safe | no | none | 10 | 59 |
| ts-exports-mount-no-role | vulnerable | yes | CWE-862, source-supported | 9 | 51 |

| Counting | Precision | Recall |
| --- | --- | --- |
| Any finding at the label | 0.71 | 1.00 |
| Source-supported only | 0.71 | 1.00 |
| Labeled weakness only | 1.00 | 1.00 |

## Observations

- The model read heavily on the mid-size projects: 36 to 59 `read_file` calls
  and up to 173,000 accounted tokens for one case. It found the deciding file
  every time. The small Go and Java cases fit the first message, so it read
  nothing more.
- Both false positives name a different weakness than the label. The Go
  handler has no authentication, which the fixture leaves out; the Java finding
  is speculative, since the fixture creates no links.
- The safe TS twin got two unlabeled findings, both outside the labeled lines.

## Limits

One run on ten cases. It establishes that the exploring review works on this
transport, not its detection rate. OpenAI, Gemini and Ollama have no live
record; no connection for them was available.
