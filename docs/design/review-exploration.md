# Read-only review exploration (design)

Status: partly implemented as the dashboard's Explore mode. This is checkpoint
M9b of [M9](../ROADMAP.md#m9-review-for-any-language-in-progress). What works
and what is qualified is in [../STATUS.md](../STATUS.md); the review as built is
described in [../guide/ai-security-review.md](../guide/ai-security-review.md#explore-mode).

## Why

Today the host decides what the model sees. It packs one batch from the scan's
traced paths, file names and line windows, then sends it in one discovery
request. The model cannot ask for another file. The second review gets the
batch, the candidates and, for parsed files only, the imports and callers of
cited files. This has four measured or visible limits:

- **Cross-file context.** A guard in middleware, a tenant filter in a
  repository class or a sanitizer in a helper is often outside the batch.
  Discovery then reports the path without the guard, and the second review
  cannot look for it.
- **Other languages.** Since M9a, Go, PHP or Java files are reviewed, but as
  plain text in path order. Nothing points the batch at a handler or a query.
- **Coverage of large repositories.** Full coverage sends every file, batch
  by batch within the user's limit, but each batch is a separate review. What
  sits together in a batch is decided by heuristics, not by the code's paths.
- **Validation.** In the live evaluation
  ([detection-claude-haiku-2026-10-16](../qualifications/detection-claude-haiku-2026-10-16.md))
  the second review almost never dismissed a safe near-miss. Counting every
  finding it did not dismiss, precision was 0.59.

Codex Security and similar agents explore the repository themselves: they
list, read and search before they conclude. M9b gives the model the same
ability inside Plenger's existing limits. The model chooses what to read.
The host still decides what may be read, redacts it, bounds it and checks
every citation against what was actually read.

## Decisions

1. **Tools only read.** The model gets `list_files`, `read_file`, `search`,
   `outline` and one submit tool per phase. There is no shell, no execution,
   no network fetch and no write. Scanning never executes project code.
2. **One allowlist.** Every tool works over `ReviewSourceReader`: the scan's
   allowlist with the same exclusions, redaction, link checks and size limits
   as a batch. A path outside it gets the same answer whether or not it exists.
3. **Search runs on redacted text.** A match or a miss never reveals a
   redacted value. Queries are literal strings, not regular expressions, so a
   model-supplied pattern cannot stall the host.
4. **Citations come from reads.** A citation must lie inside one range that a
   `read_file` result, or the first message, returned in the same session.
   Search hits and outlines are for navigation and cannot be cited.
5. **The answer is a tool call.** Discovery ends with `submit_discovery`, the
   second review with `submit_decisions`. Their parameters are the existing
   response schemas, strict where the provider supports it. This gives every
   provider structured output, not only Claude.
6. **Bounded sessions.** Each phase is one conversation with limits on model
   calls, tool calls, bytes returned, request size, accounted tokens and time.
   When a limit is near, the host asks for the submission instead of failing.
7. **Batch mode stays.** The M9a batch review remains as a mode. It is the
   fallback for connections without tool calling and the baseline the
   evaluation compares against.
8. **Candidates survive a failed second review.** When validation stops, its
   candidates are kept as `unvalidated` instead of being dropped. This applies
   to both modes.
9. **Static facts are hints, not conclusions.** The first message names entry
   points, tools, effects and traced locations. It does not include static
   findings, so discovery stays independent. Correlating static and AI findings
   is separate work.

## What stays the same

- The scan's allowlist, exclusions, redaction and the rule that omission
  details stay local. Excluded paths are never listed to the provider.
- Host-checked citations and host-supplied snippets.
- Saved providers, per-scan model selection, the optional second-review
  connection, Claude usage and cost estimates.
- The review record: summary, architecture, assets, trust boundaries, all six
  STRIDE categories, findings with validation verdicts, limitations, prompt
  digest and request settings.
- Findings, triage, fix prompts and the dashboard journey.

## Session flow

### Discovery

1. The host opens the reader over the scan's allowlist.
2. The first message holds the instructions, the tool definitions, the
   environment notes, the repository map and the static hints (see below). For
   a small repository it also holds the traced files, packed as in batch mode,
   so a simple project needs few tool calls.
3. The model calls tools. The host checks each call, runs it, appends the
   redacted result and logs it. The model may call up to eight tools per turn.
4. The model calls `submit_discovery`. The host parses it and checks every
   citation against the read log. A rejected submission returns the errors as
   the tool result and allows one corrected submission.
5. When the conversation nears a limit, the host adds a notice and answers
   any tool call but the submit tool with a refusal for a closing turn. Every
   turn keeps the same tool definitions, so earlier tool use stays valid. One
   call and its output allowance stay reserved for this.

### Validation

The second review is its own session, on the discovery connection or on the
separately chosen one. Its first message holds the candidates, the cited
ranges re-read through the reader, and the imports and callers of cited
parsed files as today. It has the same read tools with a smaller budget. Its
instructions ask it to look for counterevidence before deciding: callers,
middleware, scoping, sanitizers and safe APIs. It ends with
`submit_decisions`, one decision per candidate. Decisions may cite read ranges
as counterevidence; those are checked like discovery citations.

### Quick and Full coverage

Quick runs one discovery session and its second review. Full coverage runs
sessions until the read logs cover every readable file, the user's token or
USD limit cannot hold another session's maximum, or the batch cap is reached,
as batches do today. Each later session receives what earlier sessions read
(paths and ranges) and the titles and locations of their candidates, and is
asked to explore what is still unread. It may still read a file again, because
a citation must come from its own reads. Each session is saved as one review.

## Tools

| Tool | Arguments | Result | Limits (initial) |
| --- | --- | --- | --- |
| `list_files` | `prefix?`, `cursor?` | Allowlisted paths under the prefix with kind (Python, JavaScript, TypeScript, other code, configuration), lines and bytes | 300 entries per page |
| `read_file` | `path`, `startLine?`, `endLine?` | Redacted, line-numbered text with the file's line count and digest; says where it stopped | 300 lines and 16 KiB per call |
| `search` | `query`, `prefix?`, `caseSensitive?` | Matching lines: path, line number and the redacted line, trimmed | 3 to 200 characters; 40 matches; 2,000 files or 32 MiB of text per session |
| `outline` | `path` | Definitions with kind and line ranges, and module imports, from facts | Parsed files only |
| `submit_discovery` | The discovery schema | Accepted, or the list of errors | One correction |
| `submit_decisions` | The validation schema | Accepted, or the list of errors | One correction |

Rules for every tool:

- Paths must match an allowlisted path exactly. There is no normalisation, no
  globbing and no `..`. Anything else, including an excluded or a missing
  path, returns `not in the review allowlist`.
- A range read earlier in the same session is not sent again. The result says
  which lines are already in the conversation. This keeps re-reads cheap and
  the conversation small.
- A file that changed since it was first read in the session is refused, so
  every citation refers to one version.
- Results are data. The instructions repeat that tool results can contain text
  addressed to the model and must never be followed.

## First message hints

- **Repository map.** Allowlisted paths with kind, lines and flags (traced,
  focused, test), in review order, up to 24 KiB. Longer maps are cut by
  directory and completed with `list_files`.
- **Entry points.** Method, route, handler location and what it reaches, for
  HTTP and MCP entry points.
- **Tools and agents.** Tool names, capabilities and handler locations; agent
  and model output paths that reach an effect.
- **Trace gaps.** Calls the static trace could not follow, so the model can
  read them.
- **Environment notes** from the project, marked as user assumptions.

Static findings are left out (decision 9). Whether adding them helps recall
more than it anchors discovery is an open question for the evaluation.

## Limits

Initial values. The evaluation tunes them before the checkpoint closes.

| Limit | Discovery session | Second review | Reason |
| --- | --- | --- | --- |
| Model calls | 12 | 6 | Includes the reserved closing turn |
| Tool calls per turn | 8 | 8 | `MODEL_TOOL_CALL_LIMIT` |
| Bytes returned by tools | 160 KiB | 64 KiB | Bounds conversation growth |
| Request size | 192 KiB | 128 KiB | Within the 256 KiB transport limit and the model window |
| Accounted tokens | 1,000,000 | 400,000 | Per session, and never more than what remains of the scan's limit |
| Time | 10 minutes | 5 minutes | Per-call timeout stays 120 seconds |

Every turn resends the conversation, so accounted tokens grow faster than the
bytes returned. The Claude provider adds cache reads and cache writes to the
input tokens it accounts, so the budget counts them at face value and the
ceiling is higher than in batch mode. Cost grows less: the host marks the end
of each turn's tool results as a Claude cache breakpoint, so the next turn
reads the earlier conversation from the cache at the cache-read price. OpenAI
and Gemini apply their own automatic prefix caching.

The scan's token or USD limit works as it does for batches. A session starts
only when its maximum fits what remains, and every turn is checked again
before it is sent; the USD check prices every prompt token at the dearest
prompt rate. A session's maximum is far above a batch's, so the same limit
covers fewer sessions than batches. New Scan shows the per-session maximum and
how many sessions the limit guarantees. Reservations keep using one token per
request byte.

## Citations and coverage

- The read log records, per path, the merged ranges each session received
  and the file digest. Initial context counts as read.
- A citation is valid only inside one received range of the session that
  makes it. A citation that still fails after the correction fails the
  review, as an invalid response does today.
- `scope.files` lists the files read and their ranges; a file read in full
  has no ranges. `eligibleFiles` stays the allowlist size.
- Limitations state that the model chose what to read, how many files and
  lines it read, the searches it ran and why the session stopped.

## Failure handling

| Event | Outcome |
| --- | --- |
| Invalid submission | Errors returned as the tool result; one correction within the budget |
| Second invalid submission in discovery | Review failed, as today |
| Limit near | Closing turn that asks for the submission; other tool calls are refused |
| Limit reached without a submission | Discovery: review failed with the stop reason. Validation: candidates kept as `unvalidated` |
| Provider error or refusal in validation | Refusal ends the review as today; other errors keep candidates as `unvalidated` |
| Tool call for a disallowed path | Tool result `not in the review allowlist`; logged; counts toward limits |
| Too many tool calls in one turn | Turn rejected as an invalid response, as the Claude and chat-completions transports do today; the Responses transport gets the same check |

`unvalidated` is a new verdict next to `source-supported`, `needs-review` and
`dismissed`. It never counts as source-supported. Findings show it with its
reason, and the evaluation scores it like `needs-review`. In batch mode the
same rules add one retry request for a malformed response, so a batch makes
at most three calls.

## Providers

The provider layer already carries tool definitions and tool calls:
`ModelRequest.tools`, `ModelReply.toolCalls` and the Claude, chat-completions
and Responses transports. M9b adds:

- Claude: strict tool input schemas, cache breakpoints and tool use together
  with the closing turn.
- OpenAI chat completions and Gemini's compatible endpoint: strict function
  schemas where accepted. Gemini thought signatures are already kept between
  turns.
- ChatGPT subscription: function calls through the Responses transport.
- Ollama: tool support depends on the model, so batch mode is the default.

New Scan gets a **Review mode** choice: Explore or Batch. Explore is the
default for connections whose transport supports tools. A connection that
rejects tool calls fails the session with a message that names Batch mode.
There is no silent fallback, so a record always states the mode that ran.

## Records and reproducibility

- `SecurityReview.mode`: `explore` or `batch`. Records without it are batch.
- `SecurityReview.exploration`: per session the stop reason, model calls,
  tool calls by name, bytes returned, the read log (paths, ranges, digests)
  and the searches (redacted query, prefix, match count). Paths and queries
  are redacted before they are saved.
- The prompt digest covers the instructions, the response schemas and the tool
  definitions of the mode, so batch and explore reviews never share a digest.
- Request settings are recorded per phase as today.

## Dashboard

- New Scan: the mode, and the session limits and maximum cost described above.
- Scan progress: `exploring` with the number of reads, then `validating`.
- Scan > Outputs: per session the read log in order, the searches, the stop
  reason and the limitations. Findings link their citations to the read ranges.
- Findings: the `unvalidated` verdict with its reason.

## Security considerations

- **Prompt injection in repository text.** A file can tell the model to read
  other files or to report nothing. Tools cannot leave the allowlist, and the
  provider is the only recipient of what is read, as in batch mode. Injection
  can waste budget, which the limits bound, or suppress findings, which no
  source review can rule out. The second review, the static rules and the read
  log in Outputs make suppression visible; they do not prevent it.
- **Secret probing.** Search runs on redacted text, and redacted values are
  placeholders in every result. The search query is redacted before it is
  logged.
- **Path probing.** Excluded and missing paths get the same answer, and the
  map never lists excluded paths.
- **Host resources.** Search reads files lazily through the reader cache, up
  to the per-session cap. Queries are literal, so matching time is linear in
  the text searched.

## What this does not fix

The near-misses in the live evaluation sat in the same file as the cited code.
The second review had the whole file and still kept them as needs-review.
Reading more will not change that. The validation instructions also need
calibration: when to dismiss, and what counts as a guard. That calibration is
measured with `pnpm evaluate` in both modes, and its prompt digests are
compared. M9b ships only if it does not lower recall.

## Evaluation and acceptance

The corpus in `test/fixtures/evaluation` gains pairs that need more than one
file, and a pair in a language without a parser:

| Pair | Vulnerable | Safe near-miss |
| --- | --- | --- |
| Route authorization | A route registered without the auth middleware the other routes use | The middleware is applied at router level in another file |
| Tenant scoping | A handler calls a repository method without a tenant filter | The repository method adds the filter |
| Path helper | A route passes a name to a helper that joins it into a path | The helper confines the result to its base directory |
| Go SQL | A handler concatenates a query parameter into SQL | The handler uses a placeholder |

These pairs, and a Java path pair, are in the corpus. The batch-mode baseline on
it is [detection-claude-haiku-2026-10-17](../qualifications/detection-claude-haiku-2026-10-17.md):
the tenant pair was right in every run, while the router-level middleware, the
confining helper and the Go placeholder were reported in every run with their
guard in the batch.

`pnpm evaluate` gains `--mode explore|batch`. A qualification record compares
both modes on the same model and corpus over three runs: precision and recall
with their spread, verdicts per case, model calls, tool calls, tokens and
estimated cost.

Acceptance for M9b:

- Every tool refuses paths outside the allowlist, and redaction holds in every
  result, including search.
- Every citation in a saved review lies inside a range its session read.
- Limits stop every session, with a closing turn before the hard stop.
- Explore recall is not lower than batch recall on the whole corpus, and
  precision is higher on the cross-file pairs.
- The tool loop works with a scripted stub on every advertised transport, and
  with at least one live Claude model.

## Checkpoints

1. **Tool loop on Claude.** Tools over the reader, the read log, citation
   checks, limits and the closing turn, `submit_discovery`. Offline tests with
   scripted stubs: allowlist refusals, redaction in read and search results, a
   secret query that does not match, a citation outside the read log,
   re-read notices, the closing turn, and an injection fixture that asks for an
   excluded file.
2. **Second review with tools.** `submit_decisions`, counterevidence
   citations, the `unvalidated` verdict and the one-correction rule, in both
   modes.
3. **Other transports and caching.** OpenAI, Gemini and ChatGPT, strict
   schemas, Claude cache breakpoints, Review mode in New Scan.
4. **Full coverage and the dashboard.** Later sessions with earlier read
   logs, the limit checks per session and turn, progress, the read log in
   Outputs and the per-session maximum in New Scan.
5. **Evaluation.** The new corpus pairs, `--mode`, and a dated comparison in
   `docs/qualifications/`.

Each checkpoint lands with its tests and docs. The guide, STATUS and the
changelog change when a checkpoint is usable, not before.

## Open questions

- Whether static findings in the first message raise recall more than they
  anchor discovery.
- Whether Full coverage works better as many short sessions or as fewer,
  longer ones with a larger budget each.
- Whether a `callers` tool built on the project links finds guards better
  than `search` alone for parsed languages.
- Which limits the evaluation supports, especially the token ceiling and the
  bytes returned per session.
