# M10 path closure, guides and change review, Claude Haiku 5.5, 2026-10-21

The live measurements of M10b to M10d on the evaluation corpus, after the
[M10a record](detection-claude-haiku-2026-10-21-m10a.md). M10b closes traced
paths. The next version adds framework guides, the project threat model,
change review, long scans and three fixes these runs found. The guides were
then removed, and a shortened run checked the version without them. The
threat model is measured on a real project in its
[own record](full-coverage-ai-chatbot-2026-10-21-m10.md). The acceptance is in
[the roadmap](../ROADMAP.md#m10-review-discipline-and-scope-done).

## Configuration

- Connection: saved provider "Claude 2", model `claude-haiku-5-5`, no separate
  second-review model. `pnpm evaluate --runs 3` with concurrency 4 (Batch) and
  3 (Explore). Commits are named as they are on `main`; the runs used the same
  source before the stack was rebased onto it.
- Before: M10a at `9c43d20`, Batch digest `f1f7157bebc8`, Explore
  `cba6d57a0412`, on the 150-case corpus.
- M10b at `09b3718`: Batch digest `263cc92edb8d`, 21:37 to 22:11 UTC; Explore
  `9a8703bc74ca`, 22:09 to 23:14 UTC. 150 cases.
- With guides: Batch at `2c2ed90`, digest `4eeeb7ce0fcc`, 22:12 to 22:44 UTC;
  Explore at `7ff93a8`, digest `def57baab3da`, 22:50 to 23:58 UTC. 154 cases:
  the 150 and the four change cases. `7ff93a8` raises the Batch output
  allowance and changes no prompt. Batch lost four replies of the
  `ts-exports-mount` pair at the old allowance; that pair ran again at
  `7ff93a8`, three runs, and its results replace all six of the pair's reviews
  in the Batch figures below.
- Without guides: `91200c4`, Batch digest `16caa5ecb46d`, Explore
  `47cd92daf80b`, 00:03 to 00:20 UTC on 2026-10-22. Both runs were stopped to
  save credits: Batch after one complete run and Explore after 125 of the 154
  cases of its first run.
- Shipped: `6717960`, Batch digest `80c73b91df93`, Explore `1ceabf89fee2`. It
  changes one sentence of the second review after `91200c4` and has not run
  live; see Observations.

## Answer

M10b meets its acceptance in Explore, and in Batch with the fixes that followed
it. Every traced path in Batch was closed, and 94 percent in Explore. Precision
rose from 0.71 to 0.73 in Batch and from 0.69 to 0.72 in Explore. Cross-file
recall held at 1.00 in Explore. In Batch it fell from 0.61 to 0.50, because
three discovery replies of the 16-path pair hit the output allowance. The fixes
after M10b remove those failures: with them, Batch completes every review and
cross-file recall is 0.67, the level before M10a.

The framework guides failed their acceptance and were removed. On the cases
that received one, precision fell from 0.76 to 0.72 in Batch and from 0.74 to
0.70 in Explore. No guide raised precision or recall beyond the run range of
M10b without lowering the other.

The version without guides scores as M10b did on the same cases:
Batch precision 0.73 and recall 0.93 in its one run, against 0.73 and 0.92 for
M10b. Explore scores 0.75 and 0.98 on 121 cases, against 0.71 to 0.74 and 0.98.
Change review found both vulnerable changes in every run with guides and
reported neither safe one. Without guides, Batch missed the new shell caller
once in its one run.

The M10a follow-up rule stopped the mistaken dismissals of an unpinned
server, but its credential part made Batch dismiss a redacted key it had
always found. That part was taken out again in the shipped version, which has
not run live.

## Results

Mean over three runs, with the lowest and highest run, on the 150 cases without
changes.

| Mode | Version | Precision | Recall | Labeled weakness: precision | Recall | Cross-file precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Batch | M10a | 0.71 (0.69 to 0.73) | 0.94 (0.92 to 0.96) | 0.90 | 0.89 | 0.69 | 0.61 |
| Batch | M10b | 0.73 (0.73 to 0.74) | 0.92 (0.91 to 0.92) | 0.90 | 0.87 | 0.83 | 0.50 |
| Batch | with guides | 0.70 (0.69 to 0.72) | 0.94 (0.93 to 0.95) | 0.90 | 0.89 | 0.71 | 0.67 |
| Explore | M10a | 0.69 (0.68 to 0.69) | 0.99 (0.97 to 1.00) | 0.90 | 0.93 | 0.85 | 0.94 |
| Explore | M10b | 0.72 (0.70 to 0.74) | 0.98 (0.97 to 0.99) | 0.91 | 0.95 | 0.90 | 1.00 |
| Explore | with guides | 0.68 (0.68 to 0.69) | 0.99 (0.99 to 1.00) | 0.91 | 0.96 | 0.86 | 1.00 |

| Mode | Version | Rated | Same level | Higher | Lower | Dismissed by mistake per run | Paths listed | Closed | Finding, safe, open |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Batch | M10a | 214 | 0.83 | 11 | 25 | 0, 1, 0 | | | |
| Batch | M10b | 209 | 0.82 | 14 | 23 | 1, 1, 1 | 366 | 366 | 219, 120, 27 |
| Batch | with guides | 215 | 0.79 | 17 | 29 | 0, 1, 1 | 426 | 425 | 245, 140, 40 |
| Explore | M10a | 225 | 0.83 | 15 | 23 | 1, 1, 0 | | | |
| Explore | M10b | 224 | 0.85 | 12 | 21 | 0, 1, 1 | 414 | 391 | 220, 152, 19 |
| Explore | with guides | 226 | 0.84 | 16 | 20 | 0, 0, 1 | 426 | 415 | 247, 161, 7 |

Paths count every review, the change cases included.

| Mode | Version | TP/FP/FN/TN per run | Failed | Requests | Accounted tokens | Estimated USD |
| --- | --- | --- | --- | --- | --- | --- |
| Batch | M10b | 70/26/6/48, 70/26/6/48, 69/24/7/50 | 3 of 450 | 741 | 6,593,640 | 15.22 |
| Batch | with guides | 72/32/4/42, 72/32/4/42, 71/27/5/47 | 0 of 450 | 763 | 7,090,825 | 14.31 |
| Explore | M10b | 75/27/1/47, 75/30/1/44, 74/32/2/42 | 0 of 450 | 1,161 | 12,026,272 | 34.98 |
| Explore | with guides | 76/36/0/38, 75/35/1/39, 75/33/1/41 | 1 of 450 | 1,206 | 12,628,124 | 36.47 |

### Without guides

The stopped runs wrote no report, so these figures come from their logs:
detection per case, without severity, verdicts or paths. Each is compared with
the earlier runs on the same cases.

| Mode | Cases | Without guides, TP/FP/FN/TN | Precision | Recall | M10b runs, precision | With guides, precision |
| --- | --- | --- | --- | --- | --- | --- |
| Batch | 150 | 71/26/5/48 | 0.73 | 0.93 | 0.73, 0.73, 0.74 | 0.69, 0.69, 0.72 |
| Explore | 121 | 61/20/1/39 | 0.75 | 0.98 | 0.74, 0.71, 0.71 | 0.69, 0.68, 0.70 |

M10b's recall on the same cases was 0.92, 0.92 and 0.91 in Batch and 0.98 in
each Explore run.

### Change cases

Only the changed file is reviewed, with its changed lines and base.

| Case | Truth | With guides, Batch | With guides, Explore | Without, Batch | Without, Explore |
| --- | --- | --- | --- | --- | --- |
| py-diff-new-caller-shell | vulnerable | 3 of 3 found | 3 of 3 found | not found | found |
| py-diff-new-caller-fixed | safe | 0 of 3 reported | 0 of 3 reported | not reported | not reported |
| ts-diff-guard-removed | vulnerable | 3 of 3 found | 3 of 3 found | found | found |
| ts-diff-guard-moved | safe | 0 of 3 reported | 0 of 3 reported | not reported | not reported |

### Framework guides

Precision and recall on the cases each guide was selected for: the M10b run
range without guides, then the mean with guides. A case can get several
guides.

| Guide | Cases | Batch precision | Batch recall | Explore precision | Explore recall |
| --- | --- | --- | --- | --- | --- |
| Express | 24 | 0.69 to 0.71; 0.71 | 0.83 to 1.00; 1.00 | 0.61 to 0.75; 0.67 | 0.92 to 1.00; 1.00 |
| FastAPI | 16 | 0.83 to 0.86; 0.64 (lower) | 0.63 to 0.75; 0.75 | 0.73 to 0.89; 0.67 (lower) | 1.00; 1.00 |
| Flask | 24 | 0.57 to 0.63; 0.55 (lower) | 1.00; 1.00 | 0.55 to 0.57; 0.57 | 1.00; 1.00 |
| LangChain | 36 | 0.82 to 0.86; 0.79 (lower) | 0.95 to 1.00; 1.00 | 0.83 to 0.86; 0.76 (lower) | 0.95 to 1.00; 0.98 |
| OpenAI SDKs | 16 | 1.00; 0.92 (lower) | 0.75 to 0.88; 0.92 (higher) | 0.78 to 1.00; 0.77 (lower) | 0.88 to 1.00; 0.96 |
| Vercel AI SDK | 12 | 0.75 to 0.86; 0.82 | 0.83 to 1.00; 1.00 | 0.75 to 0.86; 0.75 | 1.00; 1.00 |
| Next.js | 2 | 1.00; 0.83 (lower) | 1.00; 1.00 | 0.50 to 1.00; 0.50 | 1.00; 1.00 |
| MCP, CrewAI, smolagents, other agent frameworks | 2 each | no change beyond the range | | | |
| Any guide | 130 | 0.75 to 0.77; 0.72 (lower) | 0.89 to 0.91; 0.94 (higher) | 0.72 to 0.76; 0.70 (lower) | 0.97 to 0.98; 0.99 (higher) |
| No guide | 20 | 0.63; 0.61 | 1.00; 0.93 | 0.59; 0.61 | 1.00; 1.00 |

Django, aiohttp, Fastify, Koa, Hono and NestJS have no case.

## Observations

- The guides' new false positives are mostly other weaknesses at the labeled
  lines: routes reported as reachable without authentication and agent tools
  as acting without approval. Those are the controls the guides tell the model
  to look for. Precision on the labeled weakness did not change, 0.90 and 0.91.
- Batch's three M10b failures and four of the next version's were discovery
  replies of `ts-exports-mount`, which lists 16 traced paths, cut at the
  8,192-token output allowance. Shorter closure reasons, at most 300
  characters, were not enough. At 12,288 tokens all six reviews of the pair
  completed.
- Explore left 23 paths in M10b and 11 with guides without a closure the host
  accepted, almost all in safe cases. The host drops a closure it cannot check,
  such as a safe closure whose cited lines the session did not read.
- After the rule that unreachable does not apply to supply-chain candidates,
  loop limits and credentials in source (`59dc4df`), neither
  `py-team-no-termination` nor `py-mcp-unpinned-uvx` was dismissed in any run.
  M10b had dismissed the uvx case three times. But Batch now dismissed
  `py-aws-key-in-source` twice as contradicted: the host redacts the key, the
  instructions call redacted values placeholders, and the rule allowed a
  dismissal when the value is not a real credential. The case was found in all
  six Batch runs before the rule and missed in three of five after it,
  counting the run without guides. `6717960` takes credentials out of the rule
  again; that wording has not run live.

## Limits

Three runs per version on one synthetic corpus and one model. The version
without guides has one Batch run and part of one Explore run, so its figures
carry no run range, and its change-case results are one review each. The
shipped version has no live run. The
framework subsets are small, with two cases for five guides and none for six.
