# AI security review

The dashboard can discover security findings from source code through a saved
model provider, including Anthropic Claude. It also produces a STRIDE threat
model. This review is separate from the offline rule scanner and from the
facts-only `assess` CLI command. See [../STATUS.md](../STATUS.md) for qualification.

## Run a review

1. Add a local folder under **Projects**.
2. Save a model connection under **Settings > Providers**.
3. Press **New Scan**, choose the project, provider, model, review mode and
   depth. **Batch** sends source the scan packs. **Explore** lets the model read
   the project through read-only tools; see [Explore mode](#explore-mode).
4. Press **Start Scan**. The job first captures an offline scan, then sends
   redacted source and context to that provider and consumes model usage.

`plenger scan` remains offline. The facts-only `assess` command has its own
[guide](assessment.md).

The host rereads files from the static scan's allowlist. It reapplies current
exclusions and `.gitignore` rules. The allowlist holds the parsed Python,
JavaScript and TypeScript files and, for dashboard scans, text files without a
parser: code in other languages (Go, Java, PHP, Ruby, C#, Rust and more),
shell scripts, SQL, templates (HTML, Jinja, ERB, Handlebars, Twig and others),
configuration (YAML, TOML, JSON, XML, INI), Terraform and Dockerfiles. These are
read as plain text: they get no static facts, so nothing orders or excerpts
them by function. Lockfiles, generated protobuf and minified files stay out.
Source can change during a job. Reviews record capture time, file and
context digests, coverage, provider, model, calls and reported token usage.
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
adjacent, so a batch can hold the path from end to end. Other AI components
follow. The remaining files come in this order: code in any language before
configuration, security-related file names first within each group, then
relative path order. Tests, fixtures and examples, traced or not, come after
everything else in the same order.

By default each batch holds at most 24 files, 16 KiB of source per file and
20 KiB of serialized source context. When the selected model's input window is
known, the batch grows with it. Claude catalogs report the window; press **Load
models** once to save it. The cost ceiling does not change: each batch stays
within two requests and 400,000 accounted tokens. The larger, second request
(instructions, candidates, batch and related files) is sized to fit half that
ceiling and the smallest window of the models in use, counting one token per
request byte. Seventy percent goes to the batch, up to 112 KiB with 48 KiB per
file and 48 files, and thirty percent to related files, up to 48 KiB. A
second-review model whose window is unknown keeps the defaults. New Scan shows
the batch budget for the selected model, and Outputs record the budget each
batch used. Path files are added first as excerpts: the functions
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

**Quick** uses one batch. **Full coverage** keeps adding independent batches
until no unsent source that fits a batch remains, the scan's token or USD limit
cannot hold another batch's maximum, or 100 batches have run; see
[dashboard.md](dashboard.md#start-a-scan). Later batches skip files an earlier
batch sent whole. A file sent as an excerpt
continues: a later batch sends its definitions that were not sent yet, with the
module imports again for context, or the line windows after the last one sent.
Module-level code outside definitions is sent only where the scan located
something. A file that changed after a batch sent
part of it does not continue. Each batch has its own discovery and
validation context. Full coverage sends every file it can, but each batch is
reviewed on its own: a path that crosses batches is not analysed as one path. Choose a smaller
source folder when related files do not fit. Included paths, omissions and
limitations are visible in **Scan > Outputs**.

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
cut, instead of rejecting the second review.
Refused responses require a non-empty top-level reason and no findings or decisions.
Citations must stay within a submitted file and, for an excerpt, inside one
submitted range. Longer valid ranges are retained;
code previews show at most 13 source lines and mark any omitted cited lines. Import statements
can mention files that were omitted; those files remain outside the review scope.

Rejected replies identify Discovery or Validation and a JSON field location,
such as `$.findings[0].evidence[0].path`. Diagnostics do not echo rejected model
values or credentials. A failed AI review leaves completed static findings
available. No automatic repair or provider retry occurs. Raw provider replies
are not persisted. Earlier failed records can only show their original generic
message; a new scan uses the updated contract and diagnostics.

## Analysis and second review

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

When candidates exist, a second request reviews them against the same source.
It checks callers, guards, sanitization, scope and counterevidence. Each receives
one outcome:

- **Source-supported**: the second review supports the path in the supplied code.
- **Needs review**: an essential assumption or control needs more context.
- **Dismissed**: the candidate is contradicted, duplicated or unsupported.
- **Unvalidated**: the second review stopped before it decided. The candidate
  is kept with the reason, and never counts as source-supported.

Guards and callers often live outside the batch, so the second request also
reads related files that discovery did not see. These are project files a cited
file imports, with the imported definitions, and project files that call a cited
file, with the calling functions. They come from the scan's allowlist through the
same reader, redaction and excerpt rules as the batch, within the related
budget (12 KiB by default) and eight files, and never repeat lines the batch
already holds. Outputs list them under
**Second review context**, and the review adds a limitation naming their count.
If they cannot be read, the second review continues without them.

By default the second pass uses the same model with a separate review
instruction. **Second review** in New Scan can pick another saved connection,
which runs with its saved model; a different model is less likely to repeat the
first model's mistakes. Its usage and estimated cost are reported separately.
The second pass is not an independent detection service or runtime validation.
A refusal stops the review. Any other failure of the second pass, such as an
invalid reply, an incomplete decision set, a provider error or a limit, keeps
its candidates as Unvalidated and adds a limitation with the reason; the review
still completes. A failed discovery request fails the review. There are no
model retries. No candidates means one request. The limit per batch is two
requests, 400,000 accounted tokens and 120 seconds. Full coverage stops further
batches after a failed or refused review. Output is capped at the smaller of
the provider setting and 8,192 tokens per request.

## Explore mode

In Explore mode the model chooses what to read. Each pass is one conversation
with four read-only tools over the scan's allowlist:

| Tool | What it returns |
| --- | --- |
| `list_files` | Allowlisted paths under a prefix, with kind, lines and bytes, 300 per page |
| `read_file` | Redacted, line-numbered lines, at most 300 lines and 16 KiB per call |
| `search` | Lines that contain a literal string, on redacted text, at most 40 matches |
| `outline` | Definitions and imports of a parsed Python, JavaScript or TypeScript file |

Discovery ends by calling `submit_discovery`, the second review by calling
`submit_decisions`. Their parameters are the batch response schemas. On Claude
the submit tools are strict, so the provider holds their arguments to the
schema as it does for a batch answer; the host checks them in every case. The first
discovery message holds a repository map (up to 24 KiB), hints from the static
scan (entry points, tools, their effects and the calls the trace could not
follow), the environment notes and a first set of files packed as a batch, up
to 48 KiB. The first validation message holds the candidates and their cited
lines, a small file whole and a larger one as its cited ranges with 20 lines of
context, up to 32 KiB. Static findings are not sent.

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
  discovery, or leaves the candidates Unvalidated in the second review.

| Limit | Discovery | Second review |
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
resends the conversation, so an exploring review uses more tokens than a batch.

Explore runs one review: choose **Quick**. Reviews record `mode`, and for
Explore `exploration`: per session the stop reason, model calls, tool calls by
name, bytes returned, the files and ranges read with their digests, the
searches, and the host's reasons for any rejected submission (field locations,
never model values). The review's scope lists the files and ranges read, and its
limitations say how many files the model read and searched.

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
restart. **Scans** opens the saved job. Its **Findings** tab shows static and
non-dismissed AI findings; **Outputs** shows each batch's architecture, assets,
trust boundaries, STRIDE and source coverage. Dismissed candidates remain in the
review record. **Export JSON** includes these redacted records and usage.

Native Claude reviews retain per-request cache usage and the model's manual
price snapshot. Scan details show category costs and an estimated USD total.
Missing usage or cache-write lifetimes cannot be priced. Valid usage remains
billable even when a reply is refused, truncated or fails host validation.
See [model pricing](dashboard.md#claude-model-pricing) for configuration and
the estimate's limits.

Open a finding for its trace and second-review reason. **Fix with a coding
agent** generates instructions from the saved finding through a selected
provider. Its assumptions and review outcome accompany the evidence. Optional
REA imports can be selected for this prompt. They are not inputs to AI
discovery or validation. Workflow statuses such as Triaged or Resolved are
stored separately from the source analysis verdict.

The local service keeps scans running when you leave the page. **Cancel scan**
requests cancellation and saves the outcome. Model refusals and errors stop
without retries. All scans start manually; see [dashboard.md](dashboard.md#manual-local-scans).

Batch reviews expose no model tools. Explore reviews expose only the four
read-only tools above. Neither has a terminal, application execution, network
access or active target requests. The dashboard does not run a coding agent or apply patches. Source
review is evidence for human assessment and does not prove runtime exploitability
or establish that a repository is secure.
