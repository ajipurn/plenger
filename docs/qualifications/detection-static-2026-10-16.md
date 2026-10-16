# Detection evaluation 2026-10-16

Corpus: 16 labeled cases in `test/fixtures/evaluation`, 8 vulnerable and 8 safe near-misses. A finding counts for a case when it overlaps the labeled lines; AI findings dismissed by the second review do not count. The corpus is small and synthetic: these figures describe it, not arbitrary projects.

## Static rules

| TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| 7 | 2 | 1 | 6 | 0.78 | 0.88 |

| Rule | Vulnerable cases | Safe cases | Precision |
| --- | --- | --- | --- |
| PLG101 | 1 | 1 | 0.50 |
| PLG104 | 1 | 0 | 1.00 |
| PLG105 | 1 | 1 | 0.50 |
| PLG106 | 1 | 0 | 1.00 |
| PLG302 | 1 | 0 | 1.00 |
| PLG401 | 1 | 0 | 1.00 |
| PLG501 | 1 | 0 | 1.00 |

| Case | Truth | Static rules at the location |
| --- | --- | --- |
| py-eval-output | vulnerable | PLG401 |
| py-eval-output-literal | safe | none |
| py-hardcoded-key | vulnerable | PLG501 |
| py-key-from-env | safe | none |
| py-path-tool | vulnerable | PLG104 |
| py-path-tool-confined | safe | none |
| py-shell-tool | vulnerable | PLG101 |
| py-shell-tool-allowlist | safe | PLG101 |
| py-sql-tool | vulnerable | PLG106 |
| py-sql-tool-param | safe | none |
| py-system-prompt-injection | vulnerable | PLG302 |
| py-system-prompt-safe | safe | none |
| ts-idor-route | vulnerable | none |
| ts-idor-route-scoped | safe | none |
| ts-ssrf-tool | vulnerable | PLG105 |
| ts-ssrf-tool-allowlist | safe | PLG105 |
