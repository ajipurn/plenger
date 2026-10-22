# Batch mode on the ChatGPT subscription transport, full corpus, 2026-10-22

One live Batch run of the shipped M10 prompt on the ChatGPT connection. The
[M10 record](detection-claude-haiku-2026-10-21-m10.md) left that prompt
without a live run: its last fix takes credentials out of the second review's
unreachable rule. This run checks that the prompt works end to end on a
second transport and model. It is not a comparison with the Claude records,
because the model differs.

## Configuration

- Connection: saved provider "ChatGPT", Sign in with ChatGPT, model
  `gpt-6.1-sol`. No separate second-review model. No saved prices, so no USD
  estimate; the run counts against the subscription.
- `pnpm evaluate --provider ChatGPT --mode batch --runs 1 --concurrency 4
  --yes` on `main` at `fdd1c97`, prompt digest `80c73b91df93`, the shipped
  prompt of `6717960`. 00:33 to 00:56 UTC.
- Corpus: the 154 cases in `test/fixtures/evaluation`, the four change cases
  included.

## Answer

The shipped prompt works on this transport. All 154 reviews completed, with
229 model requests and no rejected reply. Every traced path was closed. No
vulnerable case was dismissed by mistake, and no dismissal failed the host's
check. On the 150 cases without changes, precision is 0.89 and recall 0.87.
The model reports fewer candidates than Claude Haiku 5.5 does in Batch, with
higher precision and lower recall.

## Results

| Counting | Precision | Recall |
| --- | --- | --- |
| Any finding at the label | 0.89 | 0.87 |
| Labeled weakness only | 0.94 | 0.82 |
| The 12 cross-file cases | 0.75 | 0.50 |

| Measure | Value |
| --- | --- |
| TP/FP/FN/TN | 66/8/10/66 |
| Severity at the labeled level | 60 of 66 rated, all within one level |
| Vulnerable cases dismissed by mistake | 0 |
| Dismissals the host kept as needs-review | 0 |
| Traced paths listed, closed | 142, 142: finding 62, safe 59, open 21 |
| Model requests | 229 |
| Accounted tokens | 881,120 |

Change cases:

| Case | Truth | Result |
| --- | --- | --- |
| py-diff-new-caller-shell | vulnerable | not found |
| py-diff-new-caller-fixed | safe | not reported |
| ts-diff-guard-removed | vulnerable | found |
| ts-diff-guard-moved | safe | not reported |

## Observations

- The credential cases: `py-hardcoded-key` was found and kept as
  source-supported. Discovery reported nothing for `py-aws-key-in-source`, so
  it is a missed case, not a dismissal. No candidate was dismissed as
  unreachable or contradicted on a redacted value.
- The missed cross-file cases are the three Python pairs where the deciding
  file is a repository or helper outside the route's file:
  `py-invoice-number-unscoped`, `py-tenant-unscoped-repository` and
  `py-ticket-file-path-unconfined`. Batch sends a fixed set of files; Explore
  reads such files through its tools.
- `py-diff-new-caller-shell` was also missed by the one Claude Batch run
  without guides, and found by the Claude Explore run. The changed route calls
  a helper in an unchanged file that runs a shell.
- Four of the eight false positives name another weakness than the label,
  three of them missing authorization or ownership. The other four claim the
  labeled weakness although the safe case has the control.

## Limits

One run on one model. It establishes that the shipped prompt runs on this
transport, not its detection rate, and it gives no figure for Claude on the
shipped prompt.
