# Detection evaluation, Claude Haiku 5.5, Batch and Explore on the 150-case corpus, 2026-10-21

Three runs per mode on the whole evaluation corpus as it stands after the static
rule work of 2026-10-19 to 2026-10-21. The last AI record,
[2026-10-17](detection-claude-haiku-2026-10-17-cross-file.md), used 92 cases.
This run repeats the M9b comparison on the larger corpus and is the "before"
baseline for M10a.

## Configuration

- Connection: saved provider "Claude 2", model `claude-haiku-5-5`, no separate
  second-review model.
- `pnpm evaluate --provider "Claude 2" --runs 3 --concurrency <n> --mode <mode>`
  on `main` at `7d0d867`, Batch with concurrency 4 and Explore with
  concurrency 3, at the same time: Batch from 16:27 to 17:22 UTC and Explore from
  16:48 to 17:55 UTC.
- Prompt digests: Batch `96606658d921`, Explore `626d00ea8dbc`.
- Corpus: 150 cases in `test/fixtures/evaluation`, 76 vulnerable and 74 safe.
  Severity labels were added later, on the M10a branch; the severity figures
  below are computed against those labels from the saved findings.
- An earlier attempt at the same runs used twelve processes and lost most
  reviews to HTTP 429; it was discarded, and `pnpm evaluate` gained
  `--concurrency` and reruns of rate-limited reviews (`7d0d867`). Here Explore
  reran 5 reviews after a 429 and Batch none.

## Answer

The M9b acceptance holds on the larger corpus. Explore's recall is not lower
than Batch's on the whole corpus (1.00 against 0.93), and its precision is
higher on the twelve cross-file cases (0.87 against 0.76). Both modes lost
precision against the 92-case record: most of the 58 added cases are static
rule pairs whose safe twin keeps a similar sink behind a check, and the review
reports many of those twins.

## Results

Mean over three runs, with the lowest and highest run.

| Cases | Mode | Precision | Recall | Labeled weakness: precision | Recall |
| --- | --- | --- | --- | --- | --- |
| All 150 | Batch | 0.72 (0.71 to 0.73) | 0.93 (0.91 to 0.93) | 0.90 (0.88 to 0.91) | 0.91 (0.91 to 0.91) |
| All 150 | Explore | 0.68 (0.66 to 0.70) | 1.00 (0.99 to 1.00) | 0.91 (0.90 to 0.91) | 0.96 (0.95 to 0.96) |
| 12 cross-file | Batch | 0.76 (0.67 to 0.80) | 0.67 (0.67 to 0.67) | | |
| 12 cross-file | Explore | 0.87 (0.75 to 1.00) | 1.00 (1.00 to 1.00) | | |

| Mode | TP/FP/FN/TN per run | Reviews failed | Requests | Accounted tokens | Estimated USD |
| --- | --- | --- | --- | --- | --- |
| Batch | 71/29/5/45, 71/28/5/46, 69/25/7/49 | 1 of 450 | 751 | 5,371,026 | 15.14 |
| Explore | 76/32/0/42, 75/39/1/35, 76/36/0/38 | 0 of 450 | 1,254 | 12,092,785 | 33.27 |

Explore tool calls: `read_file` 582, `search` 442, `list_files` 267,
`submit_discovery` 454, `submit_decisions` 339.

Severity against the labels, over detections at the labeled location:

| Mode | Rated | Same level | Within one level | Higher | Lower |
| --- | --- | --- | --- | --- | --- |
| Batch | 211 | 0.70 | 0.98 | 30 | 34 |
| Explore | 227 | 0.69 | 1.00 | 29 | 41 |

Vulnerable cases whose only findings at the label were dismissed: Batch 0, 1
and 2 per run; Explore none.

## Observations

- Batch missed the same cases in every run: `py-invoice-number-unscoped` and
  `py-ticket-file-path-unconfined`, whose deciding file is outside the batch,
  `py-hardcoded-key` and `py-team-no-termination`. Explore missed only
  `py-team-no-termination`, once.
- 38 safe cases drew a finding in Batch and 43 in Explore in at least one run.
  Counting only the labeled weakness, precision is about 0.90 in both modes, so
  most of those findings name a different weakness at the same lines.
- The one failed Batch review returned five STRIDE categories and was rejected,
  as the contract requires.
- No reply was seen to hold more than eight tool calls, so the fix for such
  replies is still not exercised live; every Explore review completed.

## Limits

One model on a synthetic corpus. The figures describe this corpus, not
arbitrary projects.
