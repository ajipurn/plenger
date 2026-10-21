# Full coverage Explore scan of Vercel ai-chatbot, 2026-10-21

One measured Full coverage scan in Explore mode on a real project, through the
dashboard's own scan coordinator, the pending M9b item "a measured Full
coverage scan".

## Configuration

- Project: [vercel/ai-chatbot](https://github.com/vercel/ai-chatbot) at
  `c2f8235e1f3ea903ad8b7f61447c4f74164b5c58` (2026-07-08), a shallow clone read
  only and never run. 166 reviewable files.
- Connection: saved provider "Claude 2", model `claude-haiku-5-5`, its saved
  prices. Explore, Full coverage, a USD 12 limit.
- Code: `main` at `7d0d867`. A script started the scan through
  `SecurityCoordinator` on a scratch data directory and read the saved Claude 2
  connection without copying its key.
- Started 17:58 UTC, with one other evaluation process on the same connection
  for its first minutes.

## Answer

The scan completed and stopped at its limit: 25 exploring reviews read 131 of
the 166 files in 19.9 minutes, for USD 4.65 at saved prices. Each review cost
USD 0.12 to 0.37. The scan stopped with USD 7.35 of the limit left, because a
review starts only when its maximum, USD 7.37 at these prices, fits what
remains. A USD 5 limit cannot start an exploring Full coverage scan at all.

## Results

| Measure | Value |
| --- | --- |
| Reviews | 25, all completed |
| Files read | 131 of 166 |
| Stop | limit: the next review's maximum did not fit |
| Model requests | 178 |
| Accounted tokens | 5,891,365 |
| Estimated USD | 4.65 of 12.00 |
| Duration | 19 min 51 s |
| AI findings kept | 6: 4 source-supported, 2 needs review |
| Trust boundaries | 114 entries over 25 reviews, 109 distinct |

Kept findings, as the scan reported them; they were not checked line by line:

| Severity | Second review | Finding |
| --- | --- | --- |
| medium | source-supported | The vote endpoint does not bind `messageId` to the caller's chat (CWE-639) |
| low | needs review | The upload accepts any file whose declared type is JPEG or PNG (CWE-434) |
| medium | needs review | A client file-part URL reaches the model layer without a host check (CWE-918) |
| low | source-supported | CI installs pnpm `latest` with secrets in the job environment (CWE-829) |
| low | source-supported | The Pyodide runtime loads from a CDN without integrity (CWE-829) |
| low | source-supported | Tool approval lets the client overwrite stored tool-part fields (CWE-915) |

## Observations

- A first attempt the same evening ran beside eight evaluation lanes on the
  same connection. Its 17th review got HTTP 429 and the whole scan failed after
  16 completed reviews, 97 files and USD 3.46. That led to continuing a Full
  coverage scan after a failed later batch, in M10e.
- Every review derived architecture, assets and trust boundaries again: 109 of
  114 trust boundary entries are worded differently. This is the baseline for
  M10c's project threat model.

## Limits

One project snapshot and one run. Coverage counts files the model chose to
read; lines it did not read were not reviewed.
