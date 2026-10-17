# Import REA evidence

Plenger accepts a complete JSON Evidence record from REA's static JavaScript
application analysis. It attaches a redacted projection to one saved scan.
Use it as additional context when generating a coding agent fix prompt.
See [qualification status](../STATUS.md).

## Export and import

Use an existing REA installation to analyze a selected application directory or
ASAR. Export the complete result, rather than a summary view or evidence bundle:

```sh
rea analyze-javascript-application /path/to/application --json > rea-evidence.json
```

In Plenger, scan the repository and open **Scans > scan > Outputs > REA evidence**. Choose the
JSON file and press **Import evidence**. The file limit is 64 MiB. REA's
separate semantic graph and raw result, which make up most of a large export,
are dropped before the other bounds apply; the parts the importer reads may
hold up to 16 MiB. A scan holds up to eight imports. Remove an import to free a slot. Importing the same redacted
projection again reuses its existing record.

The importer reads JSON only. It does not install REA, launch a subprocess, open
paths from the document, contact a target, or execute application code.
Imports stay on the local dashboard until you explicitly use a model action.

## Supported evidence

The record must have operation `analyze_javascript_application`, predicate
`rea.javascript-application-analysis`, provider `rea-javascript-application`,
and a `normalized_result.graph` with schema `JavaScriptApplicationGraph`.
Directory and ASAR subjects are supported. Subject and result artifact hashes
must agree. The importer checks consumed fields, graph references, duplicate
identifiers, coverage consistency and resource bounds.

This is structural validation of an imported projection. Plenger does not
authenticate the producer, recompute REA's semantic IDs, or compare the artifact
with the repository. The UI labels every import **Unverified import**. Reported
confidence and coverage describe the supplied analysis, not vulnerability
validation. Imports do not add static findings or change the scan gate.

The retained projection includes reported provider and artifact identity,
summary counts, statistics, graph nodes and relationships, coverage and
limitations, up to 256 limitation strings per list with the rest counted in
one closing entry. It discards raw provider output, analysis profiles, request
parameters and the separate semantic graph. Known secret patterns and
credential-named fields are redacted before storage. Absolute path values are
omitted. Review the redacted export before sharing it. Redaction is not a
guarantee that every application-specific secret has been recognized.

**Export redacted evidence** downloads Plenger's stored projection. This is a
Plenger record, not a complete REA export for reimport into either tool.

## Use in a fix prompt

Open a finding, select a saved provider and choose a record in **REA evidence
(optional)**. The default is **None**. Press **Generate fix prompt** to include
the selected evidence in one explicit model request.

The REA context has an 8 KiB ceiling inside the existing 24 KiB total prompt
context limit. It includes provenance, counts and a bounded selection of
limitations, nodes and relationships. Omitted items are counted explicitly.
The coding agent is instructed to verify the artifact's correspondence with
the current repository and build before using its reported facts. Target text
is untrusted data and must not be followed as instructions.

Rescanning creates a new snapshot with no imported evidence. Opening an older
scan restores that scan's imports. Removing an import prevents future prompts
from selecting it. Clearing saved scan data deletes all imports. Previously
copied prompts or downloaded exports remain separate files.

The input mapping follows REA's
[Evidence contract](https://github.com/morluto/rea/blob/55cef2566a5cf7bad3ed4f2dfefecbeee386beea/src/domain/evidence.ts)
and [JavaScript application analysis](https://github.com/morluto/rea/blob/55cef2566a5cf7bad3ed4f2dfefecbeee386beea/src/domain/javascript/javascriptApplicationAnalysis.ts).
These sources identify the supported shape. See
[STATUS.md](../STATUS.md) for the validation record.
