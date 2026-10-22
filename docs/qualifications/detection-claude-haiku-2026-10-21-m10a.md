# M10a decision discipline, Claude Haiku 5.5, before and after, 2026-10-21

Severity calibration and dismissals with a checked basis, measured against the
[full-corpus record](detection-claude-haiku-2026-10-21-full-corpus.md) of the
same day, which is the "before" run. The acceptance of
[M10a](../ROADMAP.md#m10-review-discipline-and-scope-done): severity agreement
recorded before and after, precision and recall not lower, vulnerable cases
dismissed by mistake not more frequent.

## Configuration

- Connection: saved provider "Claude 2", model `claude-haiku-5-5`, no separate
  second-review model. `pnpm evaluate --runs 3` with concurrency 4 (Batch) and
  3 (Explore), on the 150-case corpus with its severity labels. Commits are
  named as they are on `main`; the runs used the same source before the
  stack was rebased onto it.
- First version, `43bbeb4`: Batch only, digest `dffede4a487e`, 17:22 to 17:57
  UTC. Its Explore run was stopped early and is not reported.
- Second version, `9c43d20`, after the first failed: Batch digest
  `f1f7157bebc8` from 21:03 to 21:37 UTC, Explore digest `cba6d57a0412` from
  21:03 to 22:08 UTC.
- Before: `main` at `7d0d867`, Batch `96606658d921`, Explore `626d00ea8dbc`.

## Answer

The second version meets the acceptance, with one shift between modes.
Precision and recall stay within the run ranges of the "before" runs in both
modes. Exact severity agreement rises from 0.70 to 0.83 in Batch and from 0.69
to 0.83 in Explore. Vulnerable cases dismissed by mistake fall from 3 to 1 in
Batch and rise from 0 to 2 in Explore, 3 in all both times. The two Explore
cases led to a validation rule after this run; see Follow-up.

The first version failed: Batch precision fell from 0.72 to 0.68 and exact
severity agreement from 0.70 to 0.65.

## Results

Mean over three runs, with the lowest and highest run, on the 150 cases.

| Mode | Version | Precision | Recall | Labeled weakness: precision | Recall | Cross-file precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Batch | before | 0.72 (0.71 to 0.73) | 0.93 (0.91 to 0.93) | 0.90 | 0.91 | 0.76 | 0.67 |
| Batch | first | 0.68 (0.67 to 0.71) | 0.93 (0.92 to 0.95) | 0.89 | 0.89 | 0.66 | 0.61 |
| Batch | second | 0.71 (0.69 to 0.73) | 0.94 (0.92 to 0.96) | 0.90 | 0.89 | 0.69 | 0.61 |
| Explore | before | 0.68 (0.66 to 0.70) | 1.00 (0.99 to 1.00) | 0.91 | 0.96 | 0.87 | 1.00 |
| Explore | second | 0.69 (0.68 to 0.69) | 0.99 (0.97 to 1.00) | 0.90 | 0.93 | 0.85 | 0.94 |

| Mode | Version | Rated | Same level | Within one | Higher | Lower | Dismissed by mistake per run | Unchecked dismissals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Batch | before | 211 | 0.70 | 0.98 | 30 | 34 | 0, 1, 2 | |
| Batch | first | 213 | 0.65 | 0.99 | 28 | 47 | 1, 0, 2 | 0 |
| Batch | second | 214 | 0.83 | 1.00 | 11 | 25 | 0, 1, 0 | 1 |
| Explore | before | 227 | 0.69 | 1.00 | 29 | 41 | 0, 0, 0 | |
| Explore | second | 225 | 0.83 | 0.99 | 15 | 23 | 1, 1, 0 | 0 |

| Mode | Version | TP/FP/FN/TN per run | Failed | Requests | Accounted tokens | Estimated USD |
| --- | --- | --- | --- | --- | --- | --- |
| Batch | second | 71/26/5/48, 70/28/6/46, 73/33/3/41 | 2 of 450 | 759 | 6,022,946 | 15.31 |
| Explore | second | 75/33/1/41, 74/34/2/40, 76/35/0/39 | 1 of 450 | 1,237 | 12,806,287 | 34.02 |

Dismissal bases on the findings at labeled locations: Batch `control` 3 and
`unreachable` 3; Explore `control` 4, `unreachable` 4 and `duplicate` 1.

## Observations

- The first version's rubric said nothing about input the model chooses or
  content from a remote service, while the labels do. The model rated code
  execution through agents and downloads medium, and tool file reads high. It
  also said that uncertainty was not a reason to leave out a candidate, and
  Batch reported more of them. The second version states the labels' reach
  rules and drops that sentence.
- The remaining disagreements are mostly one level apart: two unauthenticated
  routes labeled critical reported high, `trust_remote_code`, FAISS and
  smolagents code execution reported medium, and a few tool reads high.
- Explore dismissed `py-team-no-termination` and `py-mcp-unpinned-uvx` as
  unreachable, because their arguments are literals. Batch dismissed the same
  uvx case before M10a.
- The three failed reviews ended in the first request with no reply and no
  usage, a transport failure. No reply was rejected for the new decision
  fields.

## Follow-up

`59dc4df` tells the second review that unreachable does not apply to
supply-chain candidates, credentials in source or missing loop limits. It is
measured with the rest of M10 in the
[M10 record](detection-claude-haiku-2026-10-21-m10.md), where the credential
part led to new mistaken dismissals and was taken out again.
