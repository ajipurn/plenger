# Static candidate validation on the ChatGPT subscription transport, full corpus, 2026-10-30

One live Batch run of the current prompt on the ChatGPT connection. Two things
changed since the [2026-10-22 record](review-chatgpt-batch-2026-10-22.md): the
change instructions were removed from the discovery prompt on 2026-10-25, and
the second review now also decides the static scanner's findings. The model
and mode are the same, so the runs are compared.

## Configuration

- Connection: saved provider "ChatGPT", Sign in with ChatGPT, model
  `gpt-6.1-sol`. No separate second-review model. No saved prices, so no USD
  estimate; the run counts against the subscription.
- `pnpm evaluate --provider ChatGPT --mode batch --runs 1 --concurrency 4
  --yes` on `main` at `046c8c9`, prompt digest `4e38603f8ca4`. `src/` was
  unchanged; the evaluation script had the static verdict table added. 21:24
  to 21:56 UTC.
- Corpus: the 150 cases in `test/fixtures/evaluation`, 76 vulnerable and 74
  safe.

## Answer

The current prompt finds what the earlier one found. When an AI finding that
the second review merged into a static candidate counts as found, discovery has
66 true and 10 false positives, against 66 and 8 on 2026-10-22. With the static
findings the second review kept, as the dashboard shows them, recall is 0.95:
72 of 76 vulnerable cases.

The report's own figures, recall 0.58 and 22 vulnerable cases dismissed by
mistake, count only the AI findings that were kept. In all 22 cases the second
review dismissed the AI finding as a duplicate of a static candidate it kept at
the same lines.

The run shows a defect. The host rejected 37 of the 59 duplicate dismissals
between an AI and a static candidate and kept them as Needs review, so the same
weakness appears twice.

## Results

| Counting | TP/FP/FN/TN | Precision | Recall |
| --- | --- | --- | --- |
| Report: kept AI findings | 44/10/32/64 | 0.81 | 0.58 |
| Discovery, merged findings counted | 66/10/10/64 | 0.87 | 0.87 |
| Kept AI or static findings | 72/10/4/64 | 0.88 | 0.95 |
| 2026-10-22, 150 cases without changes | 66/8/10/66 | 0.89 | 0.87 |

The second and third rows are counted from the `--json` outcomes.

| Static candidates | Source-supported | Needs review | Dismissed |
| --- | --- | --- | --- |
| At a vulnerable label | 58 | 11 | 2 |
| At a safe label | 0 | 0 | 0 |
| Elsewhere | 0 | 0 | 0 |

| Measure | Value |
| --- | --- |
| Reviews completed | 149 of 150 |
| Duplicate dismissals of an AI candidate for a static one | 59: 22 accepted, 37 kept as Needs review |
| Severity at the labeled level | 40 of 44 rated, all within one level |
| Traced paths listed, closed | 122, 122: finding 60, safe 47, open 15 |
| Model requests | 233 |
| Accounted tokens | 860,950 |

## Observations

- Rejected duplicates: 26 of the 37 name the static rule's CWE, so their first
  or last citation did not overlap the static candidate's. The other 11 name
  another CWE, four of them CWE-95 against the rule's CWE-94. All 22 accepted
  duplicates name the rule's CWE. `sameCandidatePath` in
  `src/assessment/review-static.ts` requires the same CWE and overlapping first
  and last citations.
- Six vulnerable cases were found only through the static candidate:
  `py-agent-unapproved-delete`, `py-aws-key-in-source`,
  `py-copy-tool-path-pattern`, `py-path-helper-unconfined`,
  `py-requests-toolkit-dangerous` and `py-ticket-file-path-unconfined`.
- The four misses: `py-invoice-number-unscoped` and
  `py-tenant-unscoped-repository`, cross-file Python cases also missed on
  2026-10-22; `ts-exports-mount-no-role`, whose review stopped at its deadline;
  and `ts-route-transcode-raw-input`.
- Both dismissed static candidates are PLG801 command execution, dismissed with
  a control basis: the program is fixed and no shell runs. Their labels are
  CWE-22 on `py-route-cache-evict-joined`, which discovery found, and CWE-88 on
  `ts-route-transcode-raw-input`.
- Most of the 11 static candidates kept as Needs review are agent
  configurations (PLG202, PLG203, PLG701, PLG705). The second review found the
  unsafe setting but no code that runs the agent in the files it received.
- Six of the ten false positives name another weakness than the label, three
  of them missing authorization or authentication. The other four claim the
  labeled weakness; one of them, `ts-exports-mount-admin-role`, is unvalidated
  because its second review stopped at the deadline.

## Limits

One run on one model. It establishes that the current prompt and static
candidate validation run on this transport, not their detection rates. At run
time the report did not count static findings; the rescored rows come from its
JSON outcomes. After this run the evaluation counts kept static findings and
reports discovery alone, and the duplicate check compares the CWE family and the
marked sinks. The [run after both changes](review-chatgpt-batch-2026-10-30-duplicates.md)
measures them.
