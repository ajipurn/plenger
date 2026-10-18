# Detection evaluation, Claude Haiku 5.5, cross-file pairs in Batch and Explore mode, 2026-10-17

Three runs per mode after three pairs were added where the file that tells the
twins apart is outside both the batch and Explore's first message. In the
[previous record](detection-claude-haiku-2026-10-17-explore.md) every case fit
the first message, and the model called `read_file` once in 86 reviews. This
record measures what Explore does when it has to read.

## Configuration

- Connection: saved provider "Claude 2", model `claude-haiku-5-5`, no separate
  second-review model. `pnpm evaluate --provider "Claude 2" --runs 3 --yes
  --mode <mode> --json <file>`. Both modes ran at the same time: Batch from
  20:05 to 21:22 UTC, Explore from 20:05 to 21:59 UTC.
- Prompt digests: Batch `96606658d921`, Explore `404467970ca1` with strict
  submit tools. These are the digests of Batch v2 and Explore v2 in the
  previous record.
- Corpus: 92 cases, 47 vulnerable and 45 safe: the previous 86 and the three
  pairs below.

| Pair | Vulnerable | Safe near-miss | Deciding file |
| --- | --- | --- | --- |
| `py-invoice-number-*` (CWE-639) | A repository method looks invoices up by number without the organization filter the other methods apply | The method uses the scoped query | `app/repositories/invoices.py` |
| `py-ticket-file-path-*` (CWE-22) | A ticket file route passes the URL's file name to a helper that joins it onto the ticket folder | The helper resolves the path and keeps it in the folder | `app/utils/files/paths.py` |
| `ts-exports-mount-*` (CWE-862) | The router mounts the payroll and member exports with sign-in only, while the rates they reveal require the manager role | The router mounts them behind the admin role | `src/http/router.ts` |

The Python pairs are a FastAPI helpdesk of about 80 modules and 70 KiB on one
shared core; the TS pair is an Express time tracker of 79 modules and 69 KiB.
The labeled handler and its service are in the first message and in the
largest batch. The deciding file comes after the 48-file limit of the largest
batch and after the 48 KiB of Explore's first message; `test/evaluation.test.ts`
checks both. The batch's
second review adds imports and callers of cited files: for the path helper that
excerpt holds the deciding lines, for the router only its imports, not the mount
line, and the repository is two imports away from the handler, so it never
arrives.

## Answer

On this corpus, yes. Over three runs Explore's recall is not lower than Batch's
on the whole corpus, and its precision is higher on the cross-file pairs, which
is the design's acceptance for M9b. The gain comes from the new pairs: Explore
read the deciding file in every review that completed and named the labeled
weakness on all three vulnerable twins in every run, with no labeled-weakness
finding on a safe twin. Batch missed both Python vulnerabilities in every run
and reported the safe TS twin in every run. Two Explore reviews of the safe TS
twin failed (see Observations); counted as false positives instead, Explore's
precision on the new pairs is still 0.78, against Batch's 0.50. Counting any
finding on all 12 cross-file cases, the run ranges overlap (0.75 to 0.86
against 0.60 to 0.80), and on the whole corpus precision is level.

## Results

Mean over three runs, with the lowest and highest run.

| Cases | Mode | Any finding: precision | Recall | Source-supported: precision | Recall | Labeled weakness: precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| All 92 | Batch | 0.80 (0.77 to 0.81) | 0.91 (0.89 to 0.91) | 0.87 (0.84 to 0.90) | 0.79 (0.77 to 0.81) | 0.91 (0.89 to 0.93) | 0.89 (0.89 to 0.89) |
| All 92 | Explore | 0.81 (0.80 to 0.82) | 0.97 (0.96 to 1.00) | 0.86 (0.83 to 0.87) | 0.85 (0.85 to 0.85) | 0.94 (0.94 to 0.96) | 0.93 (0.91 to 0.94) |
| The 86 previous | Batch | 0.81 (0.78 to 0.82) | 0.95 (0.93 to 0.95) | 0.87 (0.86 to 0.90) | 0.83 (0.82 to 0.84) | 0.93 (0.91 to 0.95) | 0.93 (0.93 to 0.93) |
| The 86 previous | Explore | 0.80 (0.79 to 0.81) | 0.97 (0.95 to 1.00) | 0.85 (0.82 to 0.86) | 0.86 (0.84 to 0.86) | 0.94 (0.93 to 0.95) | 0.92 (0.91 to 0.93) |
| 12 cross-file | Batch | 0.72 (0.60 to 0.80) | 0.56 (0.50 to 0.67) | 0.92 (0.75 to 1.00) | 0.44 (0.33 to 0.50) | 0.77 (0.75 to 0.80) | 0.56 (0.50 to 0.67) |
| 12 cross-file | Explore | 0.82 (0.75 to 0.86) | 1.00 (1.00 to 1.00) | 0.83 (0.80 to 0.86) | 0.83 (0.67 to 1.00) | 1.00 (1.00 to 1.00) | 1.00 (1.00 to 1.00) |
| 6 new | Batch | 0.50 (0.50 to 0.50) | 0.33 (0.33 to 0.33) | 0.50 (0.50 to 0.50) | 0.11 (0.00 to 0.33) | 0.50 (0.50 to 0.50) | 0.33 (0.33 to 0.33) |
| 6 new | Explore | 0.92 (0.75 to 1.00) | 1.00 (1.00 to 1.00) | 1.00 (1.00 to 1.00) | 0.78 (0.67 to 1.00) | 1.00 (1.00 to 1.00) | 1.00 (1.00 to 1.00) |

The 12 cross-file cases are the six new ones and the three older pairs whose
guard is in another small file (`ts-route-*`, `py-tenant-*`, `py-path-helper-*`).
On the 86 previous cases both modes stay within three points of the single runs
in the previous record (Batch v2 0.82 and 0.95, Explore v2 0.83 and 0.98).

Findings that name the labeled weakness, true and false positives per run:

| Cases | Mode | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- | --- |
| All 92 | Batch | 42 and 5 | 42 and 4 | 42 and 3 |
| All 92 | Explore | 44 and 3 | 43 and 2 | 44 and 3 |
| 6 new | Batch | 1 and 1 | 1 and 1 | 1 and 1 |
| 6 new | Explore | 3 and 0 | 3 and 0 | 3 and 0 |

The new cases, per mode over three runs:

| Case | Truth | Batch: detected | Batch verdicts | Explore: detected | Explore verdicts | Explore read the deciding file |
| --- | --- | --- | --- | --- | --- | --- |
| py-invoice-number-unscoped | vulnerable | 0/3 | none | 3/3 | source-supported ×3 | 3/3 |
| py-invoice-number-scoped | safe | 0/3 | none | 0/3 | none | 3/3 |
| py-ticket-file-path-unconfined | vulnerable | 0/3 | none | 3/3 | unvalidated ×2, source-supported | 3/3 |
| py-ticket-file-path-confined | safe | 0/3 | none | 1/3 | unvalidated (CWE-200) | 3/3 |
| ts-exports-mount-no-role | vulnerable | 3/3 | needs-review ×2, source-supported | 3/3 | source-supported ×3 | 3/3 |
| ts-exports-mount-admin-role | safe | 3/3 | needs-review ×2, source-supported | 0/3, 2 failed | none | 1/1 completed |

## Reading, requests and cost

| Mode | Completed | Model requests | Tool calls | Reported tokens | Estimated USD |
| --- | --- | --- | --- | --- | --- |
| Batch | 276 of 276 | 440 (145, 146, 149) | none | 3,245,760 | 8.68 (2.82 to 2.99 per run) |
| Explore | 274 of 276 | 725 (252, 234, 239) | `read_file` 477, `search` 189, `list_files` 120, submits 470 | 7,659,893 | 13.49 (4.41 to 4.60 per run) |

- `read_file` went from 1 call in 86 reviews to 477 calls in 276: 165, 144
  and 168 per run, of which 163, 143 and 168 on the six new cases. An Explore
  review of a new case that completed made 6 to 14 requests and 13 to 48
  `read_file` calls; the other cases still needed 1 to 4 requests.
- On the six new cases, per run, Batch made 8 requests for about 144,000 tokens
  (USD 0.25 to 0.31); Explore made 45 to 59 requests for 1.2 to 1.5 million
  tokens (USD 0.73 to 0.83).
- On the whole corpus Explore made 65% more requests than Batch, reported 2.4
  times the tokens and cost 55% more. Failed reviews report no tokens, so the
  token totals leave out their two requests.
- The estimated USD uses the saved prices of "Claude 2", which give about
  13 times the per-token estimate of the "Claude 1" records. Compare tokens and
  requests with earlier records, not USD.

## Observations

- Batch never held a deciding file. It reported nothing at the labeled handler
  of either Python pair, so no second review ran and the related path helper
  was never read. On the TS pair it reported both twins in every run; its
  second review noted that the router lines that mount the exports were not
  submitted and kept the finding as Needs review in two runs.
- Explore's validated findings on the vulnerable twins give the path through
  the deciding file with its lines, such as the invoice route through the
  service to `InvoiceRepository.by_number`, or the mount at `router.ts:46`
  beside the manager-only mounts.
- The one false positive on a new case, `py-ticket-file-path-confined` in
  run 1, was a real weakness of the fixture at the labeled lines: attachments
  could belong to an internal comment, and viewers could list and download them
  while comments hid internal ones from them. The attachment's comment link was
  removed from both twins after these runs, so the corpus now differs from the
  measured one in those two model and schema files.
- Two Explore reviews of `ts-exports-mount-admin-role`, in runs 1 and 2,
  failed after their first request with the generic message. The run kept no
  error text. Offline, a first Claude reply with nine parallel `read_file`
  calls fails the same way: the Claude transport rejects a reply with more than
  eight tool calls (`MODEL_TOOL_CALL_LIMIT`), before the exploring session can
  answer the extra calls with its own per-turn limit. That is the likely cause,
  not a confirmed one. After these runs, exploring reviews accept up to 64 tool
  calls in one reply and answer those past eight, and a rejected reply names
  its check in the review's reason.
- The host rejected 21 second-review submissions for a reason over 1,200
  characters and two discovery submissions for missing STRIDE categories. Three labeled
  findings stayed Unvalidated, all on the ticket file pair.
- Of the older cross-file pairs, Explore reported `py-path-helper-confined` in
  every run and Batch in one, both for the missing authentication of its route,
  a real weakness of that fixture already noted in the previous record.
  Batch's second review dismissed the unconfined path helper twin in two runs;
  Explore found it in all three. The router-level middleware twin and the
  tenant pair were right in both modes.

## Not established

Other models and transports, Full coverage, real projects, and more than three
pairs of this kind. The pairs were written for this measurement, and their
twins differ in one place, so the figures show that Explore reads when it must,
not how often a real project's guard is found. The cause of the two failed
reviews is not confirmed, and no run has measured the fix for it.

## Generated report: Batch

Batch mode, prompt digest `96606658d921`, 3 runs, Standard depth. 0 of 276 reviews did not complete. Estimated cost USD 8.6816. 440 model requests.

Precision 0.80 (min 0.77, max 0.81). Recall 0.91 (min 0.89, max 0.91). Counting only source-supported findings: precision 0.87 (min 0.84, max 0.90), recall 0.79 (min 0.77, max 0.81). Counting only findings that name the labeled weakness: precision 0.91 (min 0.89, max 0.93), recall 0.89 (min 0.89, max 0.89).

| Run | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 42 | 10 | 5 | 35 | 0.81 | 0.89 |
| 2 | 43 | 10 | 4 | 35 | 0.81 | 0.91 |
| 3 | 43 | 13 | 4 | 32 | 0.77 | 0.91 |

| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |
| --- | --- | --- | --- | --- |
| go-sql-handler-concat | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| go-sql-handler-placeholder | safe | 3/3 | source-supported, source-supported, source-supported | 0 |
| java-download-path-confined | safe | 0/3 | none | 0 |
| java-download-path-traversal | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-agent-approved-delete | safe | 2/3 | needs-review, needs-review | 0 |
| py-agent-unapproved-delete | vulnerable | 3/3 | source-supported, source-supported, needs-review, source-supported, source-supported | 0 |
| py-aws-key-docs-example | safe | 0/3 | none | 0 |
| py-aws-key-in-source | vulnerable | 3/3 | source-supported, source-supported, needs-review | 0 |
| py-calc-tool-eval | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-calc-tool-literal-eval | safe | 2/3 | source-supported, source-supported | 0 |
| py-command-tool-lookup | safe | 0/3 | none | 0 |
| py-command-tool-lookup-fallback | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-copy-tool-name-pattern | safe | 0/3 | none | 0 |
| py-copy-tool-path-pattern | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-crew-agent-safe-code | safe | 1/3 | needs-review | 0 |
| py-crew-agent-unsafe-code | vulnerable | 3/3 | needs-review, needs-review, needs-review, source-supported | 0 |
| py-delete-tool-guarded | safe | 1/3 | needs-review | 0 |
| py-delete-tool-late-check | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-eval-output | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-eval-output-literal | safe | 0/3 | none | 0 |
| py-faiss-dangerous-load | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-faiss-rebuild | safe | 0/3 | none | 0 |
| py-fetch-tool-host-allowlist | safe | 0/3 | none | 0 |
| py-fetch-tool-scheme-check | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-hardcoded-key | vulnerable | 1/3 | needs-review | 0 |
| py-hf-no-remote-code | safe | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-hf-trust-remote-code | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-invoice-number-scoped | safe | 0/3 | none | 0 |
| py-invoice-number-unscoped | vulnerable | 0/3 | none | 0 |
| py-key-from-env | safe | 0/3 | none | 0 |
| py-mcp-local-http | safe | 0/3 | none | 0 |
| py-mcp-pinned-uvx | safe | 0/3 | none | 0 |
| py-mcp-remote-http | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-mcp-unpinned-uvx | vulnerable | 3/3 | source-supported, source-supported, source-supported | 1 |
| py-path-helper-confined | safe | 1/3 | needs-review | 0 |
| py-path-helper-unconfined | vulnerable | 1/3 | dismissed, source-supported, dismissed | 0 |
| py-path-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-path-tool-confined | safe | 0/3 | none | 0 |
| py-path-tool-pathlib | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-prompt-refuses-password | safe | 0/3 | none | 0 |
| py-prompt-with-password | vulnerable | 3/3 | source-supported, source-supported, source-supported | 2 |
| py-rag-context-system | vulnerable | 3/3 | needs-review, source-supported, source-supported | 0 |
| py-rag-context-user | safe | 2/3 | needs-review, needs-review | 0 |
| py-read-tool-confined | safe | 0/3 | none | 0 |
| py-read-tool-sibling-prefix | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-read-tool-unresolved-prefix | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-requests-toolkit-dangerous | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-requests-toolkit-disabled | safe | 0/3 | none | 0 |
| py-restore-tool-json | safe | 2/3 | needs-review, needs-review | 0 |
| py-restore-tool-pickle | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-shell-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-shell-tool-allowlist | safe | 0/3 | none | 0 |
| py-smolagents-any-import | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-smolagents-docker-imports | safe | 0/3 | none | 0 |
| py-sql-tool | vulnerable | 3/3 | source-supported, needs-review, source-supported, source-supported | 0 |
| py-sql-tool-param | safe | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-system-prompt-injection | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-system-prompt-safe | safe | 0/3 | none | 0 |
| py-team-max-messages | safe | 0/3 | none | 0 |
| py-team-no-termination | vulnerable | 0/3 | none | 0 |
| py-tenant-scoped-repository | safe | 0/3 | none | 0 |
| py-tenant-unscoped-repository | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-ticket-file-path-confined | safe | 0/3 | none | 0 |
| py-ticket-file-path-unconfined | vulnerable | 0/3 | none | 0 |
| py-write-tool-absolute-only | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-allowlist | safe | 1/3 | needs-review | 0 |
| py-write-tool-relative-checked | safe | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-write-tool-unchecked-guard | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-unpacked | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-unpacked-confined | safe | 1/3 | source-supported | 0 |
| ts-command-tool-allowlist | safe | 0/3 | none | 0 |
| ts-command-tool-model-allowlist | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| ts-email-tool-fixed-recipient | safe | 3/3 | source-supported, source-supported, needs-review | 0 |
| ts-email-tool-recipient | vulnerable | 3/3 | source-supported, needs-review, source-supported, needs-review, source-supported | 0 |
| ts-exports-mount-admin-role | safe | 3/3 | needs-review, needs-review, source-supported | 8 |
| ts-exports-mount-no-role | vulnerable | 3/3 | needs-review, needs-review, source-supported | 8 |
| ts-git-tool-argument | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-git-tool-argument-allowlist | safe | 0/3 | none | 0 |
| ts-idor-route | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-idor-route-scoped | safe | 0/3 | none | 0 |
| ts-mcp-http-bearer-auth | safe | 2/3 | source-supported, source-supported | 1 |
| ts-mcp-http-no-auth | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-openai-browser | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-openai-server | safe | 0/3 | none | 0 |
| ts-read-tool-no-separators | safe | 0/3 | none | 0 |
| ts-read-tool-slash-only | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-route-agent-clock-tool | safe | 0/3 | none | 0 |
| ts-route-agent-shell-tool | vulnerable | 3/3 | needs-review, source-supported, needs-review, needs-review, source-supported | 0 |
| ts-route-missing-auth | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-route-router-auth | safe | 0/3 | none | 1 |
| ts-ssrf-tool | vulnerable | 3/3 | source-supported, source-supported, needs-review, source-supported | 0 |
| ts-ssrf-tool-allowlist | safe | 0/3 | none | 0 |

## Generated report: Explore

Explore mode, prompt digest `404467970ca1`, 3 runs, Standard depth. 2 of 276 reviews did not complete. Estimated cost USD 13.4858. 725 model requests; tool calls: list_files 120, read_file 477, search 189, submit_decisions 192, submit_discovery 278.

Precision 0.81 (min 0.80, max 0.82). Recall 0.97 (min 0.96, max 1.00). Counting only source-supported findings: precision 0.86 (min 0.83, max 0.87), recall 0.85 (min 0.85, max 0.85). Counting only findings that name the labeled weakness: precision 0.94 (min 0.94, max 0.96), recall 0.93 (min 0.91, max 0.94).

| Run | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 45 | 11 | 2 | 34 | 0.80 | 0.96 |
| 2 | 47 | 10 | 0 | 35 | 0.82 | 1.00 |
| 3 | 45 | 11 | 2 | 34 | 0.80 | 0.96 |

| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |
| --- | --- | --- | --- | --- |
| go-sql-handler-concat | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| go-sql-handler-placeholder | safe | 3/3 | source-supported, source-supported, source-supported | 0 |
| java-download-path-confined | safe | 1/3 | needs-review, needs-review | 0 |
| java-download-path-traversal | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-agent-approved-delete | safe | 1/3 | needs-review | 0 |
| py-agent-unapproved-delete | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-aws-key-docs-example | safe | 0/3 | none | 0 |
| py-aws-key-in-source | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-calc-tool-eval | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-calc-tool-literal-eval | safe | 1/3 | source-supported | 0 |
| py-command-tool-lookup | safe | 0/3 | none | 0 |
| py-command-tool-lookup-fallback | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-copy-tool-name-pattern | safe | 0/3 | none | 0 |
| py-copy-tool-path-pattern | vulnerable | 3/3 | source-supported, source-supported, dismissed, source-supported, source-supported | 0 |
| py-crew-agent-safe-code | safe | 0/3 | none | 0 |
| py-crew-agent-unsafe-code | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-delete-tool-guarded | safe | 1/3 | needs-review | 0 |
| py-delete-tool-late-check | vulnerable | 3/3 | source-supported, needs-review, source-supported, source-supported, needs-review | 0 |
| py-eval-output | vulnerable | 3/3 | source-supported, dismissed, source-supported, source-supported, source-supported | 0 |
| py-eval-output-literal | safe | 1/3 | source-supported | 0 |
| py-faiss-dangerous-load | vulnerable | 3/3 | source-supported, needs-review, needs-review | 0 |
| py-faiss-rebuild | safe | 0/3 | none | 0 |
| py-fetch-tool-host-allowlist | safe | 0/3 | none | 0 |
| py-fetch-tool-scheme-check | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-hardcoded-key | vulnerable | 1/3 | source-supported | 0 |
| py-hf-no-remote-code | safe | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-hf-trust-remote-code | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-invoice-number-scoped | safe | 0/3 | none | 3 |
| py-invoice-number-unscoped | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-key-from-env | safe | 0/3 | none | 0 |
| py-mcp-local-http | safe | 0/3 | none | 0 |
| py-mcp-pinned-uvx | safe | 0/3 | none | 0 |
| py-mcp-remote-http | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-mcp-unpinned-uvx | vulnerable | 3/3 | source-supported, source-supported, needs-review, source-supported | 0 |
| py-path-helper-confined | safe | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-path-helper-unconfined | vulnerable | 3/3 | source-supported, needs-review, needs-review, needs-review, source-supported | 0 |
| py-path-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-path-tool-confined | safe | 0/3 | none | 0 |
| py-path-tool-pathlib | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-prompt-refuses-password | safe | 0/3 | none | 0 |
| py-prompt-with-password | vulnerable | 3/3 | source-supported, needs-review, source-supported, source-supported | 1 |
| py-rag-context-system | vulnerable | 3/3 | needs-review, needs-review, source-supported, needs-review | 0 |
| py-rag-context-user | safe | 0/3 | none | 0 |
| py-read-tool-confined | safe | 0/3 | none | 0 |
| py-read-tool-sibling-prefix | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-read-tool-unresolved-prefix | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-requests-toolkit-dangerous | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-requests-toolkit-disabled | safe | 0/3 | none | 0 |
| py-restore-tool-json | safe | 2/3 | needs-review, needs-review | 0 |
| py-restore-tool-pickle | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-shell-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-shell-tool-allowlist | safe | 0/3 | none | 0 |
| py-smolagents-any-import | vulnerable | 3/3 | source-supported, needs-review, needs-review | 0 |
| py-smolagents-docker-imports | safe | 0/3 | none | 0 |
| py-sql-tool | vulnerable | 3/3 | source-supported, source-supported, needs-review, source-supported | 0 |
| py-sql-tool-param | safe | 2/3 | needs-review, needs-review | 0 |
| py-system-prompt-injection | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-system-prompt-safe | safe | 2/3 | source-supported, source-supported | 0 |
| py-team-max-messages | safe | 0/3 | none | 0 |
| py-team-no-termination | vulnerable | 1/3 | dismissed, needs-review | 0 |
| py-tenant-scoped-repository | safe | 0/3 | none | 0 |
| py-tenant-unscoped-repository | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-ticket-file-path-confined | safe | 1/3 | unvalidated | 0 |
| py-ticket-file-path-unconfined | vulnerable | 3/3 | unvalidated, unvalidated, source-supported | 0 |
| py-write-tool-absolute-only | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-allowlist | safe | 0/3 | none | 0 |
| py-write-tool-relative-checked | safe | 3/3 | source-supported, source-supported, needs-review, source-supported | 0 |
| py-write-tool-unchecked-guard | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-unpacked | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-unpacked-confined | safe | 1/3 | source-supported | 0 |
| ts-command-tool-allowlist | safe | 0/3 | none | 0 |
| ts-command-tool-model-allowlist | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| ts-email-tool-fixed-recipient | safe | 3/3 | needs-review, needs-review, source-supported | 0 |
| ts-email-tool-recipient | vulnerable | 3/3 | source-supported, source-supported, source-supported | 1 |
| ts-exports-mount-admin-role | safe | 0/3 | none | 1 |
| ts-exports-mount-no-role | vulnerable | 3/3 | source-supported, source-supported, source-supported | 1 |
| ts-git-tool-argument | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-git-tool-argument-allowlist | safe | 0/3 | none | 0 |
| ts-idor-route | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-idor-route-scoped | safe | 0/3 | none | 0 |
| ts-mcp-http-bearer-auth | safe | 1/3 | source-supported, source-supported | 0 |
| ts-mcp-http-no-auth | vulnerable | 3/3 | source-supported, needs-review, source-supported, source-supported, needs-review | 0 |
| ts-openai-browser | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-openai-server | safe | 0/3 | none | 0 |
| ts-read-tool-no-separators | safe | 0/3 | none | 0 |
| ts-read-tool-slash-only | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-route-agent-clock-tool | safe | 3/3 | source-supported, needs-review, source-supported | 0 |
| ts-route-agent-shell-tool | vulnerable | 3/3 | needs-review, source-supported, source-supported, source-supported, source-supported | 0 |
| ts-route-missing-auth | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-route-router-auth | safe | 0/3 | none | 1 |
| ts-ssrf-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported, needs-review | 0 |
| ts-ssrf-tool-allowlist | safe | 0/3 | none | 0 |
