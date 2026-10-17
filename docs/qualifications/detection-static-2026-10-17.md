# Detection evaluation 2026-10-17

Corpus: 72 labeled cases in `test/fixtures/evaluation`, 36 vulnerable and 36 safe near-misses. A finding counts for a case when it overlaps the labeled lines; AI findings dismissed by the second review do not count. The corpus is small and synthetic: these figures describe it, not arbitrary projects.

## Static rules

| TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| 35 | 0 | 1 | 36 | 1.00 | 0.97 |

| Rule | Vulnerable cases | Safe cases | Precision |
| --- | --- | --- | --- |
| PLG101 | 3 | 0 | 1.00 |
| PLG102 | 1 | 0 | 1.00 |
| PLG103 | 1 | 0 | 1.00 |
| PLG104 | 7 | 0 | 1.00 |
| PLG105 | 2 | 0 | 1.00 |
| PLG106 | 1 | 0 | 1.00 |
| PLG107 | 1 | 0 | 1.00 |
| PLG108 | 1 | 0 | 1.00 |
| PLG201 | 2 | 0 | 1.00 |
| PLG202 | 2 | 0 | 1.00 |
| PLG203 | 1 | 0 | 1.00 |
| PLG301 | 1 | 0 | 1.00 |
| PLG302 | 1 | 0 | 1.00 |
| PLG303 | 1 | 0 | 1.00 |
| PLG401 | 1 | 0 | 1.00 |
| PLG501 | 1 | 0 | 1.00 |
| PLG502 | 1 | 0 | 1.00 |
| PLG503 | 1 | 0 | 1.00 |
| PLG601 | 1 | 0 | 1.00 |
| PLG602 | 1 | 0 | 1.00 |
| PLG603 | 1 | 0 | 1.00 |
| PLG701 | 1 | 0 | 1.00 |
| PLG702 | 1 | 0 | 1.00 |
| PLG703 | 1 | 0 | 1.00 |
| PLG704 | 1 | 0 | 1.00 |
| PLG705 | 1 | 0 | 1.00 |

| Case | Truth | Static rules at the location |
| --- | --- | --- |
| py-agent-approved-delete | safe | none |
| py-agent-unapproved-delete | vulnerable | PLG201 |
| py-aws-key-docs-example | safe | none |
| py-aws-key-in-source | vulnerable | PLG502 |
| py-calc-tool-eval | vulnerable | PLG103 |
| py-calc-tool-literal-eval | safe | none |
| py-command-tool-lookup | safe | none |
| py-command-tool-lookup-fallback | vulnerable | PLG101 |
| py-copy-tool-name-pattern | safe | none |
| py-copy-tool-path-pattern | vulnerable | PLG104 |
| py-crew-agent-safe-code | safe | none |
| py-crew-agent-unsafe-code | vulnerable | PLG202 |
| py-delete-tool-guarded | safe | none |
| py-delete-tool-late-check | vulnerable | PLG104 |
| py-eval-output | vulnerable | PLG401 |
| py-eval-output-literal | safe | none |
| py-faiss-dangerous-load | vulnerable | PLG702 |
| py-faiss-rebuild | safe | none |
| py-fetch-tool-host-allowlist | safe | none |
| py-fetch-tool-scheme-check | vulnerable | PLG105 |
| py-hardcoded-key | vulnerable | PLG501 |
| py-hf-no-remote-code | safe | none |
| py-hf-trust-remote-code | vulnerable | PLG703 |
| py-key-from-env | safe | none |
| py-mcp-local-http | safe | none |
| py-mcp-pinned-uvx | safe | none |
| py-mcp-remote-http | vulnerable | PLG603 |
| py-mcp-unpinned-uvx | vulnerable | PLG602 |
| py-path-tool | vulnerable | PLG104 |
| py-path-tool-confined | safe | none |
| py-prompt-refuses-password | safe | none |
| py-prompt-with-password | vulnerable | PLG503 |
| py-rag-context-system | vulnerable | PLG303 |
| py-rag-context-user | safe | none |
| py-read-tool-confined | safe | none |
| py-read-tool-unresolved-prefix | vulnerable | PLG104 |
| py-requests-toolkit-dangerous | vulnerable | PLG705 |
| py-requests-toolkit-disabled | safe | none |
| py-restore-tool-json | safe | none |
| py-restore-tool-pickle | vulnerable | PLG107 |
| py-shell-tool | vulnerable | PLG101 |
| py-shell-tool-allowlist | safe | none |
| py-smolagents-any-import | vulnerable | PLG202, PLG701 |
| py-smolagents-docker-imports | safe | none |
| py-sql-tool | vulnerable | PLG106 |
| py-sql-tool-param | safe | none |
| py-system-prompt-injection | vulnerable | PLG302 |
| py-system-prompt-safe | safe | none |
| py-team-max-messages | safe | none |
| py-team-no-termination | vulnerable | PLG203 |
| py-write-tool-allowlist | safe | none |
| py-write-tool-unchecked-guard | vulnerable | PLG104 |
| py-write-tool-unpacked | vulnerable | PLG104 |
| py-write-tool-unpacked-confined | safe | none |
| ts-command-tool-allowlist | safe | none |
| ts-command-tool-model-allowlist | vulnerable | PLG101 |
| ts-email-tool-fixed-recipient | safe | none |
| ts-email-tool-recipient | vulnerable | PLG108 |
| ts-git-tool-argument | vulnerable | PLG102 |
| ts-git-tool-argument-allowlist | safe | none |
| ts-idor-route | vulnerable | none |
| ts-idor-route-scoped | safe | none |
| ts-mcp-http-bearer-auth | safe | none |
| ts-mcp-http-no-auth | vulnerable | PLG601 |
| ts-openai-browser | vulnerable | PLG704 |
| ts-openai-server | safe | none |
| ts-read-tool-no-separators | safe | none |
| ts-read-tool-slash-only | vulnerable | PLG104 |
| ts-route-agent-clock-tool | safe | none |
| ts-route-agent-shell-tool | vulnerable | PLG201, PLG301 |
| ts-ssrf-tool | vulnerable | PLG105 |
| ts-ssrf-tool-allowlist | safe | none |

## Against the previous scanner

The same 72 cases, scanned by commit `ddb28b0` (before guards, fixed tables and
unpacking were followed) and by this change:

| Scanner | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| `ddb28b0` | 34 | 11 | 2 | 25 | 0.76 | 0.94 |
| This change | 35 | 0 | 1 | 36 | 1.00 | 0.97 |

The 11 false positives were safe cases whose check the rules did not read: fixed
allowlists and equality checks before an effect, lookups into fixed tables, host
allowlists, name patterns, `/` and `..` checks, and resolved paths checked against a
base. The extra true positive is `py-write-tool-unpacked`, whose path came from tuple
unpacking. The remaining false negative is `ts-idor-route`: no static rule covers
authorization.

The corpus was written alongside the change, 56 of its 72 cases on this date, so
these figures show that each pattern behaves as intended. They do not measure
arbitrary projects.

## Open-source projects

Six projects, shallow clones scanned read-only on 2026-10-17. Nothing was installed or
run.

| Project | Commit | Files | Agents | Tools | Findings before | Findings after |
| --- | --- | --- | --- | --- | --- | --- |
| openai/openai-agents-python | `9abc918` | 1,034 | 0 | 1 | 0 | 0 |
| assafelovic/gpt-researcher | `3582a68` | 454 | 10 | 2 | 0 | 0 |
| vercel/ai-chatbot | `c2f8235` | 155 | 0 | 5 | 0 | 0 |
| Mintplex-Labs/anything-llm | `d7d68e7` | 1,247 | 0 | 0 | 0 | 0 |
| crewAIInc/crewAI-examples | `da94a91` | 116 | 102 | 57 | 1 | 0 |
| TransformerOptimus/SuperAGI | `c3c1982` | 517 | 0 | 0 | 0 | 0 |

The one finding before was a false positive: PLG104 at high confidence on a crewAI tool
that copies a template only after a name pattern, `/` and `..` checks and a resolved
path prefix check. A second crewAI tool, which writes a file at a path split from its
input, was traced for the first time and is not reported.

Correction, later on 2026-10-17: that write tool's prefix check,
`str(resolved_path).startswith(str(workdir))`, has no separator, so a sibling such as
`workdir_old` would pass it, and the scanner here accepted it. What confines the tool
is its rejection of `..` and of paths starting with `/`. The scanner now requires a
separator or `is_relative_to` for a prefix check and reads the `..` and absolute-path
checks together; the tool is still not reported, for that reason.

Gaps the scans showed, not changed here:

- Agents and tools built on a project's own framework are not inventoried: anything-llm's
  `aibitat` plugins and SuperAGI's `BaseTool` subclasses. The AI review reads them.
- Scanning a framework's own repository misses its examples: in openai-agents-python,
  `from agents import Agent` resolves to the project's own module.
- 28 files fail to parse with tree-sitter-javascript 0.25.0: 27 frontend components,
  on JSX tags such as `<Skeleton.default>`, and one build script, on the legacy
  `assert { type: "json" }` import syntax. None of them holds agent code.
- A method called on a parenthesized expression, `(base / name).resolve()`, does not
  carry where its object comes from.
