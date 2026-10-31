# Cross-origin duplicates after the sink check, ChatGPT subscription transport, 2026-10-30

One live Batch run after `e4a0735`, which matches a duplicate between an AI and
a static candidate by CWE family and the sinks each candidate marks. It repeats
the [earlier run of the same day](review-chatgpt-batch-2026-10-30.md) with the
same prompt, model and mode.

## Configuration

- Connection: saved provider "ChatGPT", Sign in with ChatGPT, model
  `gpt-6.1-sol`. No separate second-review model. No saved prices, so no USD
  estimate; the run counts against the subscription.
- `pnpm evaluate --provider ChatGPT --mode batch --runs 1 --concurrency 4
  --yes` on `main` at `e4a0735` with a clean tree, prompt digest
  `4e38603f8ca4`. 22:21 to 22:49 UTC.
- Corpus: the 150 cases in `test/fixtures/evaluation`.

## Answer

The host now accepts the duplicates the second review merges. On the 134 cases
both runs completed, it accepted 45 duplicate dismissals and rejected 6, against
19 and 35 before. Vulnerable cases listed twice, once as an AI finding and once
as a static finding, fell from 37 to 10. Detection did not change: precision
0.88 and recall 0.97, against 0.87 and 0.97.

The last 15 cases did not complete. The ChatGPT subscription reached its usage
limit (`subscription_sharing_usage_limit_exceeded`), and a rerun of those cases
failed the same way. The review reported its generic "Unable to complete the
source review" instead of the limit.

## Results

| 134 cases completed in both runs | Earlier run | This run |
| --- | --- | --- |
| Kept AI or static findings, TP/FP/FN | 66/10/2 | 66/9/2 |
| Precision, recall | 0.87, 0.97 | 0.88, 0.97 |
| Discovery alone, TP/FP/FN | 60/10/8 | 58/9/10 |
| Discovery alone, precision and recall | 0.86, 0.88 | 0.87, 0.85 |
| Duplicate dismissals accepted, rejected | 19, 35 | 45, 6 |
| Vulnerable cases listed twice | 37 | 10 |

The earlier run's rows are counted from its `--json` outcomes the way this
run's report counts.

| Measure | Value |
| --- | --- |
| Reviews completed | 135 of 150 |
| Static candidates at a vulnerable label | 52 source-supported, 10 needs review, 1 dismissed, 2 unvalidated |
| Vulnerable cases dismissed by mistake | 0 |
| Severity at the labeled level | 54 of 59 rated, all within one level |
| Traced paths listed, closed | 127, 127 |
| Model requests | 226 |
| Accounted tokens, completed reviews | 758,297 |

The report itself, over all 150 cases with the 15 failures as misses, gives
precision 0.88 and recall 0.88, and 0.87 and 0.78 for discovery alone.

## Observations

- Six duplicates were still rejected. Two name a CWE of another family than the
  rule: CWE-807 against PLG101's CWE-78 on `ts-command-tool-model-allowlist`,
  and CWE-862 against PLG301's CWE-1427 on `ts-route-agent-shell-tool`. In the
  other four the families match but the sinks do not overlap: the rule cites
  the setting or the template it builds, and the model marks a later line that
  uses the value. These are `py-hardcoded-key`, `py-prompt-with-password`,
  `py-route-mail-template` and `ts-openai-browser`.
- The two misses are `py-invoice-number-unscoped` and
  `py-tenant-unscoped-repository`, cross-file Python cases missed in every
  ChatGPT Batch run so far.
- The one dismissed static candidate is again PLG801 on
  `py-route-cache-evict-joined`, labeled CWE-22, which discovery found.
- Two completed reviews kept their static candidates unvalidated because their
  second review stopped at the usage limit.

## Limits

One run on one model, 135 of 150 cases. The 15 missing cases are TypeScript
route and SSRF cases, so their duplicates are not measured. The discovery prompt
did not change, so the two cases fewer that discovery alone found are model
variance within one run.
