# Cross-origin duplicates on the OpenAI API, full corpus, 2026-11-02

Two host-side changes to how a duplicate claim between an AI candidate and a
static candidate merges, measured with one Batch run before and one after on the
same model. A live Quick scan of e2b-dev/fragments prompted them: an AI finding
and a PLG302 finding about the same system prompt stayed separate.

## Configuration

- Connection: saved provider "OpenAI API", model `gpt-6-luna` through
  `--model`, with its Models.dev prices. No separate validation model.
- `pnpm evaluate --provider "OpenAI API" --model gpt-6-luna --mode batch --runs 1
  --concurrency 4 --yes` on `main` at `e1c401f` with the changes in the working
  tree. Before: the two merge changes reverted. After: applied. Prompt digest
  `4e38603f8ca4` in both. 05:03 to 05:34 UTC.
- Corpus: the 150 cases in `test/fixtures/evaluation`, 76 vulnerable and 74
  safe.
- An earlier run used the connection's default model `gpt-6.1-terra`, before
  `--model` existed. It is kept below as a reference with the old rules.

## Changes

- A duplicate claim whose `duplicateOf` is missing or invalid takes its target
  from the reason when the reason names exactly one other candidate id.
  Candidate ids are UUIDs. The host still requires the target to be kept.
- `sameCandidatePath` also accepts a sink of one candidate on the other's sink or
  flow citation. A rule may name the prompt text as its sink where the model
  names the call that sends it. Sources are still not compared.

## Answer

The changes merge more duplicates and leave precision and recall where they
were. Duplicates the host rejected for their weakness and sink fell from 9 to 4,
and vulnerable cases listed twice, once by the AI review and once by a static
rule, fell from 15 to 8. One run per side cannot show a change in precision or
recall; their intervals overlap almost completely.

## Results

| Measure | Before | After |
| --- | --- | --- |
| Reviews completed | 149 of 150 | 149 of 150 |
| Precision, kept AI or static findings | 0.74 (0.64 to 0.82) | 0.74 (0.65 to 0.82) |
| Recall, kept AI or static findings | 0.91 (0.82 to 0.95) | 0.92 (0.84 to 0.96) |
| Discovery alone, precision and recall | 0.73 and 0.84 | 0.73 and 0.86 |
| Duplicate dismissals accepted at a labeled location | 45 | 52 |
| Duplicates rejected for their weakness and sink | 9 | 4 |
| Duplicates rejected for a missing target | 0 | 0 |
| Dismissals kept as Needs review, any basis | 9 | 4 |
| Vulnerable cases listed twice | 15 | 8 |
| Safe cases flagged | 24 | 24 |
| Model requests | 247 | 247 |
| Estimated cost | USD 0.2177 | USD 0.2297 |

Intervals are 95% Wilson intervals. Counts of duplicates and cases listed twice
come from the `--json` outcomes.

The `gpt-6.1-terra` reference run with the old rules: 150 of 150 completed,
precision 0.79 (0.70 to 0.86), recall 0.96 (0.89 to 0.99), 52 duplicate
dismissals accepted and none rejected at a labeled location, 243 model requests,
USD 1.8415. That model set `duplicateOf` and cited matching sinks, so the
changes have little to fix there.

## Observations

- The missing-target rule did not apply in the corpus: `gpt-6-luna` named the
  kept candidate in `duplicateOf` in every claim at a labeled location. The
  fragments scan and a unit test exercise it.
- Different cases were missed in each run, and neither change caused it. A merge
  only folds a dismissed duplicate into a kept candidate, so it cannot hide a
  labeled case.
  - Missed only before: `py-aws-key-in-source`, `py-faiss-dangerous-load` (its
    review failed) and `py-prompt-with-password`.
  - Missed only after: `ts-route-report-read`, whose discovery response was
    rejected, and `ts-exports-mount-no-role`, with no AI finding at the label.
    The same case was missed on 2026-10-30.
  - Three safe cases were flagged only before and three others only after.
- `ts-route-report-read` before the change shows the defect: its PLG802 finding
  was kept and the AI finding at the same lines stayed Needs review because the
  host could not match the duplicate's sink.

## Live scan that prompted it

e2b-dev/fragments at `3b11c7f`, Quick Batch on "OpenAI API" with `gpt-6-luna`,
2026-11-02: 1 minute 22 seconds, 60,020 tokens, USD 0.0105, 23 files sent and 5
related files read. It reported five findings, each checked against the source:

- Critical, AI review: an unauthenticated sandbox route runs caller-supplied code
  and commands in an E2B sandbox. Correct; execution stays in the sandbox.
- High, PLG302: `/api/chat` and `/api/morph-chat` put request input into the
  system prompt. Both correct.
- Medium, AI review: server-funded model calls without authentication, and file
  content in the morph system prompt. The second repeats the PLG302 finding on
  `/api/morph-chat`.

Validation named the static candidate only in its reason, since structured
output was off. The rule's sink, the prompt text at line 53, lay on the AI
candidate's flow (lines 53 to 67), not on its sink (lines 70 to 86). Both
changes together merge the pair.

## Limits

One run per side on one model. The corpus cases are small, and their duplicate
claims mostly name a target. The changes are host-side, so prompt digests are
unchanged.
