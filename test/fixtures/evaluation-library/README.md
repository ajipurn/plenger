# Library evaluation corpus

Labeled cases for `pnpm evaluate -- --corpus test/fixtures/evaluation-library`. Each
folder is one small package, scanned as `plenger scan --library` scans one: the
parameters of its public functions and methods count as untrusted input. The labels
follow the [evaluation corpus](../evaluation/README.md) format, with `library: true`.

A vulnerable case is a public function that hands a caller's value to a dangerous
effect the caller may not expect: a key joined below the package's own directory, a
path or URL read from inside a configuration or a message, text put into a shell
command or SQL, or code, a template or data evaluated as such. Its safe twin confines
the value, checks it, or keeps it out of the effect. A function that opens the path or
URL its caller passes whole is the caller's choice, and the rules leave it alone.

The pairs were written alongside the rules. They show the rules do what they were built
to do, not how precise they are on real packages; the
[advisory benchmark](../../../docs/qualifications/detection-static-2026-10-20-library.md)
measures that.
