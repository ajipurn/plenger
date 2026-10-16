# AI security review

The dashboard can discover security findings from source code through a saved
model provider, including Anthropic Claude. It also produces a STRIDE threat
model. This review is separate from the offline rule scanner and from the
facts-only `assess` CLI command. See [../STATUS.md](../STATUS.md) for qualification.

## Run a review

1. Add a local folder under **Projects**.
2. Save a model connection under **Settings > Providers**.
3. Press **New Scan**, choose the project, provider, model and depth.
4. Press **Start Scan**. The job first captures an offline scan, then sends
   redacted source and context to that provider and consumes model usage.

`plenger scan` remains offline. The facts-only `assess` command has its own
[guide](assessment.md).

The host rereads Python, JavaScript and TypeScript files from the
static scan's allowlist. It reapplies current exclusions and `.gitignore`
rules. Source can change during a job. Reviews record capture time, file and
context digests, coverage, provider, model, calls and reported token usage.
The observed Git revision does not freeze a commit or working tree.

Selection follows the static scan. Files on traced paths come first: HTTP and
MCP entry points that reach an effect, tools with effects, model output that
reaches an effect, and static finding evidence. The files of one path stay
adjacent, so a batch can hold the path from end to end. Other AI components
follow, then security-related file names, then relative path order.

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
nothing was located. A function too large on its own keeps its signature and 8 lines around
each located line. Excerpts keep original line numbers and mark every omitted
stretch. The review adds a limitation when it includes an excerpt. Located lines
are ignored when a file's line count changed since the scan. Hidden and
credential-related paths, links, hard-linked files, binaries, minified files
and files that change while reading are excluded.

**Standard** uses one batch. **Deep** uses up to three independent batches.
Later batches skip files an earlier batch sent whole. A file sent as an excerpt
continues: a later batch sends its definitions that were not sent yet, with the
module imports again for context. Module-level code outside definitions is sent
only where the scan located something. A file that changed after a batch sent
part of it does not continue. Each batch has its own discovery and
validation context. Deep broadens file coverage without establishing analysis
across every batch boundary or complete repository coverage. Choose a smaller
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
impact, preconditions, mitigation and a source-to-sink trace. The host validates
all cited paths and line ranges and supplies code excerpts from captured source.

When candidates exist, a second request reviews them against the same source.
It checks callers, guards, sanitization, scope and counterevidence. Each receives
one outcome:

- **Source-supported**: the second review supports the path in the supplied code.
- **Needs review**: an essential assumption or control needs more context.
- **Dismissed**: the candidate is contradicted, duplicated or unsupported.

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
The second pass is not an independent detection service or runtime validation. A refusal,
invalid citation, incomplete decision set or provider failure stops the review.
There are no model retries. No candidates means one request. The limit per batch is
two requests, 400,000 accounted tokens and 120 seconds. A deep scan makes at
most six requests and stops further batches after a failed or refused review. Output is capped at the
smaller of the provider setting and 8,192 tokens per request.

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

Reviews expose no model tools, terminal, application execution or active target
requests. The dashboard does not run a coding agent or apply patches. Source
review is evidence for human assessment and does not prove runtime exploitability
or establish that a repository is secure.
