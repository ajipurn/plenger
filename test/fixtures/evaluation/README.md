# Evaluation corpus

Labeled cases for `pnpm evaluate`. Each folder is one small project with a
`case.json`:

- `kind`: `vulnerable` when the labeled location has the weakness, `safe` for a
  near-miss that looks similar but is not exploitable. This is the ground truth.
- `location`: the file and inclusive lines the label covers. A finding counts
  for the case when its location or evidence overlaps them.
- `cwe`: the weakness the pair is about.
- `static`: the rules the static scanner reports at that location today. For a
  vulnerable case they are the expected detections; for a safe case they are known
  false positives. `test/evaluation.test.ts` fails when the scanner's behaviour
  drifts from them, so update the label after reviewing the change.
- `note`: why the static result differs from the ground truth, when it does.

Cases come in pairs. Keep each one small and free of unrelated issues: a finding
outside the labeled location counts as unlabeled.
