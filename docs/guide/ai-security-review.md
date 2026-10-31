# AI security review

The dashboard can discover security findings from source code through a saved
model provider, including Anthropic Claude. It also produces a STRIDE threat
model. Discovery is independent of the offline rule scanner. Its static candidates
join AI candidates only for the second source review. See
[../STATUS.md](../STATUS.md) for qualification.

## Run a review

1. Add a local folder under **Projects**.
2. Save a model connection under **Settings > Providers**.
3. Press **New Scan**, choose **Run all**, then the project, provider, model,
   review mode and depth. The review runs in rounds: each round runs discovery, then validation
   of static and AI candidates. **Batch** sends each round the files the scan picks.
   **Explore** lets the model read the project through read-only tools; see
   [Explore mode](#explore-mode).
4. Press **Start Scan**. The job first captures an offline scan, then sends
   redacted source and context to that provider and consumes model usage.

The static engine remains offline. **Static only** runs it and stops without a
provider. A completed static scan offers **Continue with AI**, which creates a
linked review from the saved result after checking that the local source is
unchanged. See [scan workflow choices](dashboard.md#start-a-scan).

The host rereads files from the static scan's allowlist. It reapplies current
exclusions and `.gitignore` rules. The allowlist holds the parsed Python,
JavaScript, TypeScript and PHP files and, for dashboard scans, text files without a
parser: code in other languages (Go, Java, Ruby, C#, Rust and more),
shell scripts, SQL, templates (HTML, Jinja, ERB, Handlebars, Twig and others),
configuration (YAML, TOML, JSON, XML, INI), Terraform and Dockerfiles. These are
read as plain text: they get no static facts, so nothing orders or excerpts
them by function. Lockfiles, generated protobuf and minified files stay out.
Source can change during a job. Reviews record capture time, file and
context digests, coverage, provider, model, calls and reported token usage.
During a scan, token totals and estimated costs update after each model response.
Usage that the provider has not reported stays unknown.
They also record what produced them, so results can be compared across prompt
versions and models: `generation.promptDigest` is the SHA-256 of the discovery
and validation instructions with their schemas, and each request's provider,
model, temperature, output ceiling and use of structured output are kept. Any
change to the instructions changes the digest. Outputs show the digest and the
settings of each request. The observed Git revision does not freeze a commit or
working tree.

Selection follows the static scan. Files on traced paths come first: HTTP and
MCP entry points that reach an effect, tools with effects, model output that
reaches an effect, and static finding evidence. The files of one path stay
adjacent, so one round can hold the path from end to end. Other AI components
follow. The remaining files come in this order: code in any language before
configuration, security-related file names first within each group, then
relative path order. Tests, fixtures and examples, traced or not, come after
everything else in the same order.

In Batch mode each round sends by default at most 24 files, 16 KiB of source
per file and 20 KiB of serialized source context. When the selected model's
input window is known, the round's source grows with it. Claude catalogs report the window; press **Load
models** once to save it. The cost ceiling does not change: each round stays
within two requests and 400,000 accounted tokens. The larger, second request
(instructions, candidates, round source and related files) is sized to fit half that
ceiling and the smallest window of the models in use, counting one token per
request byte. Seventy percent goes to the round's source, up to 112 KiB with 48 KiB per
file and 48 files, and thirty percent to related files, up to 48 KiB. A
validation model whose window is unknown keeps the defaults. New Scan shows
the source per round for the selected model, and Outputs record the budget each
round used. Path files are added first as excerpts: the functions
and methods on the path, their class headers and the module imports. Spare
budget then replaces those excerpts with whole files and adds the remaining
files. Budget left after that extends excerpts with their files' other
top-level definitions. A file larger than 16 KiB is always an excerpt. It holds
the located functions first, or its top-level definitions in source order when
nothing was located. A file without a parser, or one that no longer parses, is
excerpted as consecutive 80-line windows from its start; the excerpt stops at
the first window that does not fit. A function too large on its own keeps its signature and 8 lines around
each located line. Excerpts keep original line numbers and mark every omitted
stretch. The review adds a limitation when it includes an excerpt. Located lines
are ignored when a file's line count changed since the scan. Hidden and
credential-related paths, links, hard-linked files, binaries, minified files
and files that change while reading are excluded. CI definitions are the one
hidden exception: `.github/workflows/*.yml`, `.github/actions/**/action.yml`,
`.gitlab-ci.yml` and `.circleci/config.yml` are reviewed, after redaction.

**Quick** runs one round. **Full coverage** keeps adding independent rounds
until no unsent source or unattempted static candidates fit a round, the scan's token or USD limit
cannot hold another round's maximum, or 100 rounds have run; see
[dashboard.md](dashboard.md#start-a-scan). Later rounds skip files an earlier
round sent whole. A file sent as an excerpt
continues: a later round sends its definitions that were not sent yet, with the
module imports again for context, or the line windows after the last one sent.
Module-level code outside definitions is sent only where the scan located
something. A file that changed after a round sent
part of it does not continue. Each round has its own discovery and
validation context. Full coverage sends every file it can, but each round is
reviewed on its own: a path that crosses rounds is not analysed as one path. Choose a smaller
source folder when related files do not fit. Included paths, omissions and
limitations are visible in **Scan > Outputs**.

Coverage is cumulative across rounds. **Read** means every line of the same file
version was included, **Partial** means only some lines were included, and
**Unread** means the file was never included. Excerpts from multiple rounds are
combined without filling unread gaps. Each round shows these cumulative counts
separately from its new and revisited files. These counts also apply to saved scans.

## Response contract and failures

Native Claude reviews send the output schema using `output_config.format`.
The transport moves API-unsupported length and numeric bounds into schema
descriptions. The host still enforces those bounds, all six STRIDE categories,
exact submitted file paths and line ranges, and host-assigned candidate IDs.
The selected Claude model and endpoint must support structured JSON outputs.
Connection tests check model access, rather than this response capability.
See [Anthropic's structured output contract](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

Known enum values are compared without case sensitivity and saved with canonical
spelling. For example, Information Disclosure maps to Information disclosure.
Unknown values are rejected. File paths and candidate IDs are not case-folded.
Completed responses use a null top-level `reason`. Bounded string values in that
field are accepted and normalized to null. Decision reasons remain required.
A decision reason longer than 1,200 characters is cut at a word and marked as
cut, instead of rejecting the validation.
Refused responses require a non-empty top-level reason and no findings or decisions.
Citations must stay within a submitted file and, for an excerpt, inside one
submitted range. Longer valid ranges are retained;
code previews show at most 13 source lines and mark any omitted cited lines. Import statements
can mention files that were omitted; those files remain outside the review scope.

Rejected replies identify Discovery or Validation and a JSON field location,
such as `$.findings[0].evidence[0].path`. Diagnostics do not echo rejected model
values or credentials. A provider that fails a request inside its reply, such
as a ChatGPT stream that reports a reached usage limit, is named with its error
code only, never its message. A failed AI review leaves completed static findings
available. No automatic repair or provider retry occurs. Raw provider replies
are not persisted. Earlier failed records can only show their original generic
message; a new scan uses the updated contract and diagnostics.

## Analysis and validation

The first model request reads line-numbered source, maps architecture, assets and
trust boundaries, and assesses all six STRIDE categories:

| Category | Property under review |
| --- | --- |
| Spoofing | Identity and authentication |
| Tampering | Integrity of data and actions |
| Repudiation | Attribution and auditability |
| Information disclosure | Confidentiality and tenant boundaries |
| Denial of service | Availability and resource limits |
| Elevation of privilege | Authorization and privilege boundaries |

Each category has an analysis, mitigation and a status of **Threat identified**,
**Not observed** or **Needs context**. Identified threats require source citations.
Not observed applies to the submitted context and does not establish safety.
These threat hypotheses are distinct from concrete vulnerability findings.

The same first request independently discovers up to six concrete findings.
The model receives source rather than existing static findings. It can find an
issue when the static scan reports zero findings. Every candidate includes its
impact, preconditions, mitigation, a source-to-sink trace and the CWE id that
best names its weakness, or none. The host normalises the id to `CWE-<n>`, and
the finding page links it to the CWE entry. The host validates all cited paths
and line ranges and supplies code excerpts from captured source.

Severity follows who can reach the path and what they gain, not the weakness
class. The evaluation labels use the same rules
([corpus README](../../test/fixtures/evaluation/README.md)):

| Reach | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- |
| An HTTP or MCP caller; a route without authentication in the source counts | Code execution, SQL over all data, every user's or tenant's data | The same after sign-in, or another tenant's data, a privileged action, a file or host outside its bounds | That effect limited: one folder up, one file type, a sibling folder | |
| Input the model chooses, or content from a remote service or download | | Code execution, deserialization, SQL, writes or deletes outside a base | Reads, requests and other actions | The same, limited |
| Other | | Credentials in source or in the browser | Plain transport, unpinned servers or packages, a prompt with a secret or untrusted text | A missing loop or turn limit |

When the reach or the effect is unclear, discovery chooses the lower level and
names the precondition that limits it.

Discovery is told to leave out generic best practices. Hardening items are not
findings: rate limits, timeouts, request size, token or cost limits, logging and
audit trails, monitoring and security headers. They belong in the STRIDE
mitigations. A missing iteration or turn limit is reported only for an agent
loop or multi-agent conversation without a stop condition. Supply-chain
weaknesses stay findings: code, packages, models or servers fetched and run
without a pinned version or integrity check, and credentials in source. Prompt
injection is reported when untrusted text, retrieved documents and tool results
included, reaches a system or developer message, or steers a model whose tools
or output reach a privileged effect.

### Traced paths

The static scan traces paths from HTTP and MCP entry points, tools, agents and
model output to effects such as a command, a file, SQL or a request. Discovery
receives the paths that start in its files, at most 16 per review, each with an
id and up to six effects. In Explore mode a review gets the paths no earlier
review of the scan received whole. Discovery closes each path:

| Closure | Meaning | Host check |
| --- | --- | --- |
| Finding | A candidate reports the path | The candidate exists |
| Safe | A control, or code that keeps untrusted input from the effect | A citation of lines the review received |
| Open | Discovery could not decide | A reason that names what is missing |

Each reason is one short sentence of at most 300 characters; a longer one is cut.

A path without a closure that checks out is **Not closed**, and the review adds a
limitation with the count. The list of paths is the scan's observation; the
closures are the model's account. Files without a parser have no traced paths.
Outputs show each path with its closure, reason, cited lines and the candidate
that reports it.

### Project threat model

A project keeps a threat model: its architecture, assets and trust boundaries.
The first completed round of a project's first scan derives it. Every later
round, in the same scan and in later scans, starts from it, keeps its entries
unless the source contradicts them, and adds what its own source shows. When a
scan completes, the project saves the extended model as a new version. A model
written on the project page is kept as written: reviews start from it and do
not change it. **Let scans derive it** returns the choice to the scans. Each
scan records the version it started from. STRIDE stays per round, because it
assesses the source that round read.

After independent discovery, validation checks AI candidates and up to six static
candidates per round, within the existing 16 KiB combined candidate limit. Static
candidates keep their rule ids, fingerprints and evidence. Batch validation rereads
the cited files within its source budget, then adds related imports and callers.
Explore validation starts with cited source and can read more through the same tools.
Candidates outside those limits remain Unvalidated. Full coverage attempts later
static candidates in later rounds, even when discovery has covered all files.
Validation checks callers, guards, sanitization, scope and counterevidence. Each receives
one outcome:

- **Source-supported**: validation supports the path in the supplied code.
- **Needs review**: an essential assumption or control needs more context.
- **Dismissed**: the candidate is contradicted, duplicated or unsupported.
- **Unvalidated**: validation stopped before it decided. The candidate
  is kept with the reason, and never counts as source-supported.

A dismissal names its basis and cites the lines that decide it:

| Basis | Meaning | Citation |
| --- | --- | --- |
| Control | A control that counts defeats the attack | The control, with role guard |
| Unreachable | Untrusted input cannot reach the effect. Not for a supply-chain candidate or a missing loop limit, whose risk is not the input | The source that shows it |
| Contradicted | The source contradicts the claim | The contradicting lines |
| Duplicate | Another candidate reports the same path | The other candidate's id |

The host checks each citation against the source validation received:
the round's source and its related files, or what an Explore session read. A
dismissal without a basis, with no citation that checks, or as a duplicate of a
candidate that is not kept becomes **Needs review**. Its reason starts with the
host's note, and the review adds a limitation with the count.

Guards and callers often live outside the round's source, so validation also
reads related files that discovery did not see. These are project files a cited
file imports, with the imported definitions, and project files that call a cited
file, with the calling functions. They come from the scan's allowlist through the
same reader, redaction and excerpt rules as the round's source, within the related
budget (12 KiB by default) and eight files, and never repeat lines the round
already holds. Outputs list them under
**Validation context**, and the review adds a limitation naming their count.
If they cannot be read, validation continues without them.

By default validation uses the same model with a separate
instruction. **Validation model** in New Scan can pick another saved connection,
which runs with its saved model; a different model is less likely to repeat the
first model's mistakes. Its usage and estimated cost are reported separately.
Validation reads source only; it is not runtime testing. A Source-supported static
candidate must have all its submitted evidence ranges inside validation's captured
source. A claimed supported decision without those ranges becomes Needs review.
A refusal stops the review. Any other failure of validation, such as an
invalid reply, an incomplete decision set, a provider error or a limit, keeps
its candidates as Unvalidated and adds a limitation with the reason; the review
still completes. A failed discovery request fails the review. There are no
model retries. No candidates means one request. The limit per round is two
requests, 400,000 accounted tokens and 120 seconds. Full coverage stops further
rounds after a failed or refused round. Output is capped at the smaller of
the provider setting and 12,288 tokens per request.

## Explore mode

In Explore mode the model chooses what to read. Discovery and validation each run as one conversation
with four read-only tools over the scan's allowlist:

| Tool | What it returns |
| --- | --- |
| `list_files` | Allowlisted paths under a prefix, with kind, lines and bytes, 300 per page |
| `read_file` | Redacted, line-numbered lines, at most 300 lines and 16 KiB per call |
| `search` | Lines that contain a literal string, on redacted text, at most 40 matches |
| `outline` | Definitions and imports of a parsed Python, JavaScript, TypeScript or PHP file |

Discovery ends by calling `submit_discovery`, validation by calling
`submit_decisions`. Their parameters are the Batch mode response schemas. On Claude
the submit tools are strict, so the provider holds their arguments to the
schema as it does for a Batch mode answer; the host checks them in every case. The first
discovery message holds a repository map (up to 24 KiB), hints from the static
scan (entry points, tools, their effects and the calls the trace could not
follow), the environment notes and a first set of files packed as in Batch mode, up
to 48 KiB. The first validation message holds the candidates and their cited
lines, a small file whole and a larger one as its cited ranges with 20 lines of
context, up to 32 KiB. Static findings join this validation message only; discovery
never receives them.

The host checks every call:

- A path must match an allowlisted path exactly. Excluded, missing and
  malformed paths all get the same answer, "not in the review allowlist", and
  the map never lists excluded paths.
- Search runs on redacted text, so a redacted value never matches, and the
  query is redacted before it is saved.
- Lines already in the conversation are not sent again; the result says which.
- A citation must lie inside a range the session received, in its first
  message or from `read_file`. Search hits and outlines cannot be cited. A
  rejected submission gets its errors back once; a second rejection fails
  discovery, or leaves the candidates Unvalidated in validation.

| Limit | Discovery | Validation |
| --- | --- | --- |
| Model calls | 12 | 6 |
| Tool calls run per turn (a reply may ask for up to 64) | 8 | 8 |
| Bytes returned by tools | 160 KiB | 64 KiB |
| Request size | 192 KiB | 128 KiB |
| Accounted tokens | 1,000,000 | 400,000 |
| Time | 10 minutes | 5 minutes |
| Output tokens per turn | 16,384 | 16,384 |

A model with a smaller input window gets a smaller request cap. A reply cut at
its output allowance is discarded, and the session asks once for a shorter
answer; a second cut fails discovery or leaves the candidates Unvalidated. Near a limit,
the host asks for the submission and refuses other tools for a closing turn,
so a session that is about to run out can still answer. Every request is also
checked against the scan's token or USD limit before it is sent. Every turn
resends the conversation, so an Explore round uses more tokens than a Batch round.
On Claude each turn asks the API to cache its prefix, so the next turn reads
the earlier conversation at the cache-read price; usage reports cache reads
and writes, and the cost estimate prices them.

**Quick** runs one round. **Full coverage** runs rounds
until every readable file was read and its static candidates were attempted,
the scan's limit cannot hold another round's maximum, 100 rounds have run, or a
round read no new source and attempted no new static candidates. A later round's first set holds files no earlier round read whole,
and its first message lists, within 8 KiB, the files earlier rounds read and
the candidates they reported, so it explores elsewhere and does not repeat
them.

New Scan selects Explore for Claude connections and Batch for the others,
which can choose Explore. On OpenAI, Gemini and Ollama the tools go through
chat completions, on a ChatGPT subscription through the Responses transport;
there the submit tools are not strict, so the host's checks and the one
correction carry the schema, and no cache breakpoint is sent. Whether an
Ollama model calls tools depends on the model. Only Claude has been measured.

Reviews record `mode`, and for
Explore `exploration`: per session the stop reason, model calls, tool calls by
name, bytes returned, the files and ranges read with their digests, the
searches, and the host's reasons for any rejected submission (field locations,
never model values). The review's scope lists the files and ranges read, and its
limitations say how many files the model read and searched. **Scan > Outputs**
shows each Explore round's sessions: why each stopped, its calls and tool
calls, the files and ranges it read and its searches.

Text in the repository can address the model, for example asking it to read an
excluded file or to report nothing. The tools cannot leave the allowlist, and
the provider is still the only recipient of what is read. Such text can waste
the session's budget or suppress findings, which no source review can rule
out. The read log in the review record shows what was read.

## Measuring detection

Contributors measure the review with `pnpm evaluate` on the labeled corpus in
`test/fixtures/evaluation/`; see [CONTRIBUTING.md](../../CONTRIBUTING.md#detection-evaluation).
Records are in [../qualifications/](../qualifications/), and
[../STATUS.md](../STATUS.md) states what has been measured. Compare records
only when their prompt digests match.

## Review results and prepare a fix

Results and failures are saved per scan and survive navigation, refresh and
restart. **Scans** opens the saved job. Its **Findings** tab shows non-dismissed static and AI candidates; **Outputs** shows each round's architecture, assets,
trust boundaries, STRIDE, traced paths with their closures, dismissed candidates
with their basis and cited lines, and source coverage. **Export JSON** includes
these redacted records and usage.

Native Claude reviews retain per-request cache usage and the model's manual
price snapshot. Scan details show category costs and an estimated USD total.
Missing usage or cache-write lifetimes cannot be priced. Valid usage remains
billable even when a reply is refused, truncated or fails host validation.
See [model pricing](dashboard.md#model-pricing) for configuration and
the estimate's limits.

Origin and validation appear separately. Static indications saved before this
feature show as Unvalidated. Validation failures never promote an indication.
Dismissed static candidates remain saved and can be selected through the Findings
validation filter; Outputs also show their dismissal evidence.

A cross-origin duplicate merges only after validation names the other candidate
and the host matches a CWE of the same family and an overlapping sink. The host
compares the citations each candidate marks as its sink, since a configuration
rule cites only the setting and the model may cite the input at another line.
Similar titles do not merge. The report keeps each origin's rule, evidence and review, and absorbed ids
remain aliases for triage. The most recently updated saved workflow state wins a
merge; both earlier states remain in `mergedTriage`. Historical scan occurrences
stay unchanged. A merged report with an AI origin is not resolved by static absence.

Open a finding for its trace and validation reason. **Fix with a coding
agent** generates instructions from the saved finding through a selected
provider. Its assumptions and review outcome accompany the evidence. Optional
REA imports can be selected for this prompt. They are not inputs to AI
discovery or validation. Workflow statuses such as Triaged or Resolved are
stored separately from the source analysis verdict.

The local service keeps scans running when you leave the page. **Cancel scan**
requests cancellation and saves the outcome. Model refusals and errors stop
without retries. All scans start manually; see [dashboard.md](dashboard.md#manual-local-scans).

Batch mode exposes no model tools. Explore mode exposes only the four
read-only tools above. Neither has a terminal, application execution, network
access or active target requests. The dashboard does not run a coding agent or apply patches. Source
review is evidence for human assessment and does not prove runtime exploitability
or establish that a repository is secure.
