# Full coverage Explore scan of Vercel ai-chatbot with the M10 review, 2026-10-21

The same scan as the [M9 record](full-coverage-ai-chatbot-2026-10-21.md), on the
M10 review: framework guides, traced path closures and a project threat model
that later reviews start from. This measures the project threat model of M10c:
tokens per batch and the consistency of trust boundaries across batches.

## Configuration

- Project, connection, mode and limit as in the M9 record: ai-chatbot at
  `c2f8235e1f3ea903ad8b7f61447c4f74164b5c58`, "Claude 2" with
  `claude-haiku-5-5`, Explore, Full coverage, USD 12.
- Code: the M10 stack at `7ff93a8`, the same source before the stack was
  rebased onto `main`. Started 22:45 UTC through `SecurityCoordinator` on a
  fresh scratch data directory, so the project had no threat model at the
  start. Two Explore evaluation runs used the same connection at the time.
- The requests also carried the framework guides for Next.js and the Vercel
  AI SDK, which were removed afterwards; see the
  [M10 record](detection-claude-haiku-2026-10-21-m10.md#framework-guides).

## Answer

The project threat model made later reviews consistent and cheaper. Trust
boundaries across the reviews fell from 109 distinct wordings in 114 entries to
57 in 109, and assets from 108 in 116 to 32 in 142. The mean review accounted
182,000 tokens against 236,000, and the same USD 4.7 read 140 files instead of
131. The scan saved the model as version 1 of the project, with 12 assets and
12 trust boundaries, the limit.

## Results

| Measure | M9 scan | M10 scan |
| --- | --- | --- |
| Reviews | 25 | 27 |
| Files read | 131 of 166 | 140 of 166 |
| Stop | limit | limit |
| Model requests | 178 | 147 |
| Accounted tokens | 5,891,365 | 4,910,877 |
| Mean tokens per review | 235,655 | 181,884 |
| Estimated USD | 4.65 | 4.67 |
| Duration | 19 min 51 s | 17 min 27 s |
| Trust boundary entries, distinct | 114, 109 | 109, 57 |
| Asset entries, distinct | 116, 108 | 142, 32 |
| Traced paths listed, unclosed | | 17, 0 |
| AI findings kept | 6 | 7 |

Kept findings of the M10 scan, not checked line by line:

| Severity | Second review | Finding |
| --- | --- | --- |
| high | source-supported | The `getSuggestions` server action returns any document's suggestions without an ownership check (CWE-639), reported by two reviews |
| low | source-supported | The vote endpoint does not bind the message to the chat (CWE-639) |
| low | source-supported | Uploads are accepted by declared MIME type and stored publicly (CWE-434) |
| low | source-supported | The Pyodide runtime loads from a CDN without integrity, reported by two reviews (CWE-830) |
| low | needs review | Model markdown can trigger remote image requests (CWE-201) |

## Observations

- The first review named `proxy.ts` and its matcher in the architecture; the
  saved model carries that, and later reviews kept it.
- The vote finding the M9 scan rated medium is low here; the M9 scan's CWE-918
  and CI findings did not recur, and the `getSuggestions` finding is new. One
  run of each does not separate the review change from run-to-run variation.
- The same finding from two reviews stays two findings of the scan. Merging
  them across batches is not part of M10.

## Limits

One run of each scan on one project.
