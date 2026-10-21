# Evidence assessments

The public CLI no longer exposes the facts-only assess command.
Use the dashboard for source-based review, STRIDE and the second review.
See [ai-security-review.md](ai-security-review.md).

The evidence-assessment engine remains in src/assessment/assess.ts. It makes
one bounded Claude request from redacted Python, JavaScript and TypeScript scan
facts and finding snippets. It does not execute project code or expose model
tools. Its structured report has assets, trust boundaries, STRIDE threats,
evidence, mitigations and limitations.

The report schema remains
[security-assessment-v1.schema.json](../../schemas/security-assessment-v1.schema.json).
This engine is separate from the dashboard's source review. Qualification and
availability are recorded in [../STATUS.md](../STATUS.md).
