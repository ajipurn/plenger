# Evaluation corpus

Labeled cases for `pnpm evaluate`. Each folder is one small project with a
`case.json`:

- `kind`: `vulnerable` when the labeled location has the weakness, `safe` for a
  near-miss that looks similar but is not exploitable. This is the ground truth.
- `location`: the file and inclusive lines the label covers. A finding counts
  for the case when its location or evidence overlaps them.
- `cwe`: the weakness the pair is about.
- `severity`: vulnerable cases only. The level the discovery rubric in
  `src/assessment/security-review.ts` gives the labeled weakness. `pnpm evaluate`
  compares it with the severity the review reports. Labels follow these rules:
  - An HTTP caller reaching code execution, or SQL over all data, is critical.
  - An HTTP caller reaching another tenant's data, a privileged action, or a file
    or host outside its bounds is high. A limited effect (one folder up, one file
    type, a sibling folder) is medium.
  - Input the model chooses and content from a remote service need the attacker
    to steer the model or control that service. Code execution, deserialization,
    SQL, and writes or deletes outside a base are high. Reads, requests and
    actions are medium, or low when limited.
  - Credentials in source or in a browser bundle are high.
  - Plain transport, unpinned servers, and prompts that hold a secret or
    untrusted text are medium. A missing loop limit is low.
- `static`: the rules the static scanner reports at that location today. For a
  vulnerable case they are the expected detections; for a safe case they are known
  false positives. `test/evaluation.test.ts` fails when the scanner's behaviour
  drifts from them, so update the label after reviewing the change.
- `note`: why the static result differs from the ground truth, when it does.
- `proof`: on pairs a proof test can run (docs/design/proof-tests.md). `expected` is
  `proven` for the vulnerable twin and `not-reproduced` for the safe one. `entry`
  holds the function bodies where the input enters; a proof must go through them.
  `test/proof-runtime.test.ts` runs the handwritten test of each labeled case from
  `test/fixtures/proof/`.

Cases come in pairs. Keep each one small and free of unrelated issues: a finding
outside the labeled location counts as unlabeled. When a pair needs more than one
file (a guard in another module, middleware mounted elsewhere), label the route
or handler a finding would cite, the matching lines in both cases, and keep comments
from giving the answer away. Pairs in a language without a parser (Go, Java) have
no static result; only the AI review reads them.

Three pairs are mid-size projects instead: a FastAPI helpdesk (`py-invoice-number-*`,
`py-ticket-file-path-*`, on one shared core) and an Express time tracker
(`ts-exports-mount-*`). Their deciding file (a repository, a path helper, the router
that mounts the exports) sits after enough other modules that neither the largest
batch nor Explore's first message holds it, so a review must read it to tell the
twins apart. `test/evaluation.test.ts` checks that it stays out. Keep their other
modules free of weaknesses, and change both twins of a pair together.
