# Proof sessions: first live pilot on OpenAI (2026-11-05)

A first live run of proof sessions (M11b) with `pnpm evaluate --proof`, on the 16
corpus cases that have handwritten tests, one run. The model wrote and ran the tests;
the outcomes come from the harness and `decideProof`.

| Item | Value |
| --- | --- |
| Connection | OpenAI API, `gpt-6.1-terra` (Responses API) |
| Code | `feat/proof-session` at `4357dca`, with the `--case` filter |
| Images | Python `sha256:7529eb0d…`, Node `sha256:cd970c53…` ([proof-session-2026-11-04.md](proof-session-2026-11-04.md)) |
| Backend | Podman 6.0.2, macOS Apple silicon |
| Limits | 10 model calls, 4 test runs, 400,000 tokens per session |

An earlier attempt the same day on the ChatGPT subscription connection stopped
before any model call: its saved sign-in had expired (token exchange HTTP 400).

## Results

| Outcome | Cases |
| --- | --- |
| Proven, vulnerable | `py-path-tool-pathlib`, `ts-route-doc-unpacked-query` |
| Not reproduced, safe | `py-route-send-file-directory`, `ts-route-doc-unpacked-checked` |
| Could not run, safe: the model gave up before a test, naming the check | `py-path-tool-confined`, `ts-route-report-read-confined` |
| Refused by the provider (`cyber_policy`) | all 8 CWE-78 cases, and `py-route-send-file-joined` and `ts-route-report-read` |

- **False proofs: none.** No safe case was Proven; 4 of the 8 safe cases finished.
- **Yield: 2 of 2** finished vulnerable cases were Proven, each with its first test.
- Finished sessions were short: 2 or 3 model calls, 3,063 to 6,602 accounted tokens
  and 5 to 14 seconds each, 25,222 tokens in all.
- **OpenAI's policy classifier declined 10 of 16 sessions**, every command-injection
  case and two path-traversal ones. The budget accounted 303,815 tokens, nearly all
  of them the reservations of the declined requests; whether OpenAI bills a declined
  response is not known here. At the saved rates (USD 1 input, 5 output per million),
  the finished sessions cost at most about USD 0.13, and everything accounted at most
  about USD 1.52.

## What changed after the run

- A policy failure from the provider (`cyber_policy` and similar codes) now ends the
  session as `refused`, with Could not run and the code in the reason, instead of
  failing the session.
- Reports split reported usage into input and output tokens and estimate USD from the
  connection's saved prices.
- The session's instructions now frame the task as it is: the owner's regression
  test for a bug report, in an isolated container, with harmless markers. The words
  attack, inject and payload are gone from the prose; the finding's own title, such
  as "Command injection at …", still reaches the model.

## Rerun of the 10 declined cases with the new instructions

The same connection, images and limits, one run.

| Outcome | Cases |
| --- | --- |
| Proven, vulnerable | `py-shell-tool` (CWE-78), `py-route-send-file-joined`, `ts-route-report-read` |
| Not reproduced, safe | `py-route-host-helper-lookup` |
| Could not run, safe: the intended case failed because the Python image has no `git` | `py-shell-tool-allowlist` |
| Refused by the provider (`cyber_policy`) | `py-route-host-helper-shell`, `py-route-ping-shell`, `py-route-ping-allowlist`, `ts-route-git-log-exec`, `ts-route-git-log-allowlist` |

- Refusals fell from 10 to 5. All remaining ones are command-injection cases where a
  route builds a shell command. Three were declined at the first request, two after
  two reads, at the request that would have written the test.
- **False proofs: none** (0 of 4 safe). The first command-injection proof by a live
  model: `py-shell-tool`, with its first test.
- Reported usage 26,134 input and 2,129 output tokens, about USD 0.04 at the saved
  rates; the 5 declined requests reported none.

## Both runs together

Taking each case's latest session (6 under the first wording, 10 under the new):

| | Vulnerable (8) | Safe (8) |
| --- | --- | --- |
| Proven | 5 | **0** |
| Not reproduced | 0 | 3 |
| Could not run: the model gave up naming the check | 0 | 2 |
| Could not run: the intended case failed | 0 | 1 |
| Could not run: declined by the provider | 3 | 2 |

Every vulnerable case the provider did not decline was Proven, each in one or two
model calls after reading, and no safe case was.

## What this does not show

The M11b acceptance needs three runs on the labeled cases under one set of
instructions. These two runs finished 11 sessions on one provider under two
wordings, so they show the session works end to end with a live model and stays
free of false proofs where it finished, not its yield or its cost at scale. Whether
a neutral finding title avoids the remaining refusals, and how other providers
answer, is still to measure.
Status: [../STATUS.md](../STATUS.md).
