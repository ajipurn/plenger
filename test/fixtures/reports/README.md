`sarif-2.1.0.schema.json` is the unmodified official OASIS SARIF 2.1.0 schema,
downloaded from:
https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json

It is kept locally so tests validate against the actual standard without network
access. Ajv uses non-Unicode regex mode for this schema because its published
language-tag pattern contains a legacy unescaped `]`.
