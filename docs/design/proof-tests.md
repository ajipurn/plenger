# Proof tests (M11 design)

Status: M11a, the harness and its oracles, is implemented and tested with
handwritten tests. M11b to M11d are design. The milestone is
[M11](../ROADMAP.md#m11-validation-by-execution-in-progress); the ideas come from
[strix-adoption.md](strix-adoption.md#m11-validation-by-execution). What works
and what is qualified is in [../STATUS.md](../STATUS.md).

## Goal

A finding the review supported with source is still a claim. A **proof test**
turns it into an observation: a short test, written by the model on the host,
runs the cited code with the input the finding names, inside a networkless
container. A harness in the container watches for the effect the weakness
allows. The host, not the model and not the test's own assertions, decides
the outcome:

- **Proven**: the effect happened, it came from the cited code, and the call
  went through the entry, where the input enters.
- **Not reproduced**: the test reached the entry and the effect did not happen.
  This is not evidence of safety.
- **Could not run**: with the reason, such as a missing package, an import
  error, a timeout, changed code or a test the host refused.

A proof shows that the effect happens with the input the finding names. Whether
an attacker controls that input is the review's claim, cited in the finding.
The proof test does not decide it again, and the dashboard says so.

## Principles

- **The host decides from observations.** The worker reports what it saw. The
  host checks it against what it sent and computes the outcome. A false Proven
  is worse than a missed one.
- **Explicit start, bounded cost.** A proof test starts from one finding after
  the user confirms, with its maximum cost shown, as New Scan does. Scans never
  run project code.
- **No network, no writes to the project.** The container runs with
  `--network=none` and the isolation checks of
  [worker-protocol.md](worker-protocol.md). The source is a read-only copy.
- **Measured before it grows.** Each checkpoint has an acceptance on the
  evaluation corpus, and safe twins must never be Proven.

## Eligibility

A finding can have a proof test when all of these hold. Otherwise the dashboard
names the first one that fails.

1. Its validation is `source-supported` (`findingValidation()` in
   `src/security/model.ts`).
2. Its cited files are Python, JavaScript or TypeScript. The choice is a
   `Record<LanguageFamily, …>` entry, so PHP is an explicit "not yet".
3. Its CWE is in `PROOF_WEAKNESSES`: CWE-22 and CWE-78 first.
4. The cited lines still match the current file. Otherwise the code changed
   since the scan, and the user scans again first.
5. Docker or Podman is available.

## Decision 1: dependencies

The strix-adoption page listed three options: an install stage with registry
egress, tests limited to modules without third-party imports, or an image the
user supplies. The corpus decides the first step.

Only 6 of the 150 evaluation cases import no third-party package, and none of
them is Python or TypeScript. Tests limited to dependency-free modules would
run almost nothing.

A **fixed package set** covers most of it. With 15 pinned packages
(`langchain-core`, `flask`, `fastapi`, `pydantic`, `requests`, `sqlalchemy`,
`werkzeug`, `itsdangerous`, `jinja2`, `pyyaml`, `numpy`, `openai`, `express`,
`zod`, `ai`), every import resolves in 109 of 150 cases. That includes every
Python, JavaScript and TypeScript case of CWE-22 (48) and CWE-78 (14). The
images add `httpx`, which FastAPI's test client needs.

Decision:

- **M11a to M11c** use the package set. It is baked into the proof images at
  build time from hashed lockfiles, binary wheels only and npm scripts off, as
  the Vercel image is built. Nothing is installed during a proof test. The
  `ready` frame reports each package's version.
- From M11b, a project that declares a set package with a different major
  version gets Could not run, naming both versions. Same major: the test runs
  and the record keeps both versions.
- An import outside the set fails as Could not run and names the module.
- **M11d** decides how to add a project's own dependencies, using the share of
  real projects the set leaves out. The candidates are an install from the
  project's lockfile in a build stage with scripts off, or an image the user
  supplies.

Stand-in modules for missing imports were rejected. A stand-in for a sanitizer
makes a safe function look vulnerable.

## Decision 2: images

Two images, `proof-python` and `proof-node`, under `runtimes/` and listed in
`RUNTIME_FILES`.

- They reuse the base images already pinned: Python 3.12.13 from the llmfy
  image and Node.js 22.23.4 from the Vercel image. No new base needs
  qualifying. They run with the launcher flags of the other workers, including
  256 MiB of memory and 64 processes.
- Each carries the package set and the harness. Neither contains project code,
  so both images are reusable across projects and runs, like the qualification
  fixture images. The first proof test builds them and says so.
- The Node worker links `node_modules` in the project copy to the image's
  packages. TypeScript runs through Node's type stripping, which keeps line and
  column positions for coverage. A file that needs transformation (enums,
  namespaces, parameter properties) gives Could not run; see the open questions.
- Each run uses a fresh container from the image, removed afterwards, with the
  expiry label and cleanup of the existing runtimes. Each case runs in its own
  process group inside it.

## Decision 3: weaknesses and oracles

An oracle is the harness's rule for an observed effect. M11a supports two
weaknesses whose effect a canary shows. Every name the oracles use carries the
run's marker.

| CWE | Oracle | Proven when |
| --- | --- | --- |
| CWE-22 path traversal | Two guarded folders with a canary file: `outside-<marker>` beside the test's folder, and `base-<marker>`, a sibling that shares the folder's name as a prefix | A project frame opens, lists, creates, writes, renames or deletes a path under a guarded folder. An attempt counts, even when the file does not exist |
| CWE-78 command injection | Payloads that append `echo $((a+b))>effects/<marker>` to a value, with `a` and `b` new for every run | A project frame starts a shell with a command that holds the marker, and afterwards the canary holds `a+b` |

Only a shell evaluates the arithmetic, so a command that receives the payload as
an argument cannot write the canary. Python and Node code may not touch the
canary's folder at all; the harness refuses the call.

A prefix bug on a subfolder of the test's folder (`startsWith(base)` without a
separator, for `base/downloads`) cannot be proven yet: no guarded folder shares
that subfolder's prefix.

M11d adds two more:

| CWE | Oracle | Proven when |
| --- | --- | --- |
| CWE-89 SQL injection | A recording layer on the database drivers of the package set | The payload's marker appears in a recorded statement outside a string literal or a bound parameter |
| CWE-502 unsafe deserialization | The harness builds a serialized payload (pickle, YAML tag) that creates the canary when loaded | A project frame loads it and the canary exists afterwards |

### Attribution

An effect counts only when it comes from project code reached through the
entry. The harness records the call stack of every watched operation:

- Python: `sys.addaudithook`, installed before the test loads. Events `open`,
  `os.remove`, `os.rename`, `os.mkdir`, `os.listdir`, `os.scandir`,
  `shutil.*`, `subprocess.Popen`, `os.system`, `os.posix_spawn` and `os.exec`.
  Audit hooks cannot be removed.
- Node: wrappers on `fs`, `fs/promises` and `child_process`, installed in the
  case process before the test loads, with the module's ESM exports synced.
  Stacks come from V8 call sites, async frames included.

Three rules decide whether an effect counts:

1. The innermost frame that is not the standard library, a set package or the
   harness is a project file.
2. The innermost project frame is in a file the finding cites.
3. The outermost project frame is inside an **entry** range: the body of the
   route handler or tool where the input enters. A test that calls an inner
   helper directly is not Proven, because the check may sit in the entry. In
   `py-route-ping-allowlist` the shell call is the same as in its vulnerable
   twin; only the route's allowlist differs.

The test may not start processes or touch the guarded folders, the canary, the
harness or its own file; the harness refuses those calls when the test makes
them. A callback the test passes to project code is the test's frame, so it is
refused too. Project files are read-only, and the worker compares their digest
after each case.

The test may not move the working directory either. Relative paths in the
project resolve against it, so a test that moved it next to a guarded folder
would turn an ordinary read into a traversal. The labeling review of the corpus
found this gap in the first harness, where it gave false proofs on two safe
projects; the harness now refuses the change and watches the directory.

An effect a library runs later from a callback has no project frame on its
stack. It is not attributed: Not reproduced, never Proven.

### Fresh marker

The host makes a new `PLENGER_<32 hex>` marker for every run. The model writes
the test before the marker exists. The test gets canary paths and payloads only
from the harness at run time.

### Reached lines

The harness records which lines of the entry and cited files ran during the
case call: `sys.monitoring` line events in Python 3.12, and V8 block coverage
through `node:inspector` in Node. Lines that ran while the test loaded do not
count. Proven and Not reproduced both require that a line of an entry range
ran. A test that never reaches the entry gives Could not run.

### Changed code

A test may set up inputs, but it may not change the code under test, its
checks or what they rely on. The harness watches:

- Python: the functions and classes of `os`, `posixpath`, `pathlib`, `shlex`,
  `subprocess`, `shutil`, `io`, `json` and `builtins`, the attributes of
  project modules and classes, and the environment.
- Node: the functions of `fs`, `fs/promises`, `path` and `child_process`, the
  intrinsics a check relies on (`String.prototype`, `Array.prototype`,
  `RegExp.prototype`, `Object`, `JSON` and others), the exports of project
  modules and the environment.

Python records a test that sets or deletes a module attribute at that moment.
Both harnesses also compare the watched state with the state after the test
loaded, at each recorded effect and at the end of the case, so a change undone
before the case ends still counts. A project setting or environment variable
may point inside the test's folder, and nowhere else.

Any change gives Could not run, whatever happened: changed code can create an
effect or suppress one. The harness itself uses functions it saved before the
test loaded, and when something changed it writes its result from strings
alone, so a changed `JSON.stringify` or `toJSON` cannot forge it.

## Decision 4: measurement

- `case.json` gains a `proof` field on runnable pairs: the expected outcome,
  `"proven"` on the vulnerable twin and `"not-reproduced"` on the safe twin,
  and the entry ranges. M11a labels 8 pairs, both weaknesses and both families.
  The other 46 Python, JavaScript and TypeScript cases of CWE-22 and CWE-78 are
  labeled in M11b.
- **False proofs.** The safe twin gets the vulnerable twin's finding, pointed
  at its own location: a finding the review wrongly supported. Its proof test
  must not be Proven, in every run. This is the acceptance that never relaxes.
- **Yield.** The share of runnable vulnerable cases that are Proven.
- **Retest.** The pairs model a fix: the test that proved the vulnerable twin,
  run against the safe twin, must give Not reproduced with the intended case
  passing. This works for twins with the same interface; 7 of the 8 M11a pairs
  have one.
- Also recorded: Could not run reasons, model calls, tokens and time per
  session. Live runs use three repetitions and go into
  [../qualifications/](../qualifications/).

## The test

The model writes one file with two cases. The harness runs each in its own
process, so hooks and module state start fresh.

```python
def test_intended(plenger):
    # The cited code with ordinary input; asserts the ordinary result.
    ...

def test_weakness(plenger):
    # The cited code with the input the finding names, built from plenger.
    ...
```

The Node form is an ES module that exports `testIntended(plenger)` and
`testWeakness(plenger)`, and imports the project from `/tmp/project`.

| Helper (Python, Node) | Value |
| --- | --- |
| `base()` | The test's folder and the working directory: the code may use it |
| `folder(name)`, `write(name, text)`, `read(name)` | A folder or file under `base()` |
| `canary()` | The canary file in `outside-<marker>` |
| `sibling_canary()`, `siblingCanary()` | The canary file in `base-<marker>` |
| `shell_payloads()`, `shellPayloads()` | The command payload after `;`, inside `$()` and backticks, after `\|`, `&&` and `\|\|`, and on its own line |

Rules the host checks before a run, as a second line behind attribution:

- At most 16 KiB, and the file parses with the family's grammar.
- The top level holds only imports, functions and constants of literal values
  (in Python, plain names). Nothing then runs between importing the project and
  the harness recording its state.
- No process, native, import or interpreter-hook modules and functions
  (`subprocess`, `ctypes`, `importlib`, `child_process`, `vm`, `inspector`,
  `sys.addaudithook`, `sys.modules`, stack trace hooks and others).
- No file functions (`open`, `os.remove`, `Path.read_text`, `fs`); the helpers
  cover the test's own files. A watched function handed to project code as a
  callback would run in a project frame.
- No literal that names the guarded folders, the harness or the marker.

A refused test is answered with the rule it broke and counts as a run.

## Outcome rules

`decideProof()` in `src/redteam/proof-model.ts` computes the outcome from the
`case` frames, in this order:

1. **Could not run** when the run did not complete (a refused test, a failed
   isolation check, a protocol or harness failure), the test could not load, or
   the weakness case timed out.
2. **Could not run** when the test changed watched code or settings.
3. **Could not run** when no line of an entry range ran.
4. **Proven** when the weakness case produced an attributed effect with the
   run's marker. For CWE-78 the canary must hold the expected value.
5. **Not reproduced** when the intended case passed.
6. **Could not run** otherwise: the intended case failed.

An effect with the marker that is not attributed is recorded and named in the
reason, but the run is not Proven for this finding.

The session's outcome is that of its deciding run: the first Proven run, or
else the last run.

## Session

1. **Start.** On the finding's page the user chooses a saved connection (the
   scan's by default) and sees the maximum tokens and, for priced models, USD.
2. **Source.** The host reads the current working tree with
   `readProjectFile()`: the cited files, then their imports in order, up to
   4 MiB (`SOURCE_BYTE_CAP`). It skips the paths the review excludes, such as
   environment and key files. The copy is mounted read-only. The revision and a
   digest of the copied files are recorded.
3. **First message.** The finding (title, CWE, evidence, attack path and
   validation reason), the cited files, the entry, the helper API, the package
   set and the oracle that applies.
4. **Tools.** The review's read tools (`list_files`, `read_file`, `search`,
   `outline`), `run_test {source}` and `give_up {reason}`. `run_test` returns
   the outcome, the reason, what the harness observed and up to 8 KiB of
   output. The model may revise the test and run it again.
5. **End.** On the first Proven run, `give_up`, or a limit.

Initial limits, tuned by the evaluation: 10 model calls, 4 test runs,
400,000 tokens and 10 minutes per session; 60 seconds per run.

Output and error text are redacted with `redact()` and capped before they reach
the model or storage. The host environment is never passed to the container.

## Retest

Retest is offered once a proof test is Proven. After the user changes the code,
it runs the deciding test again against the current source, with a fresh marker
and no model call. A retest has the same three outcomes. Not reproduced
requires the intended case to pass, the gate from Strix's fix verification. A
retest never changes the finding's status; the user resolves it.

## Worker protocol

The frames, limits and order are in
[worker-protocol.md](worker-protocol.md#proof-runtime). The proof workers call
no model. Their frames are new and change no existing frame, so
`WORKER_PROTOCOL_VERSION` stays at 2.

## Records and dashboard

- A `proof_tests` table (`id`, `finding_id`, `repository_id`, `started_at`,
  `payload`), like `security_findings`. The payload holds the kind (proof
  test or retest), outcome, reason, the test text, each run, the revision and
  source digest, the image digest, package versions, the connection, model
  calls, tokens and cost.
- The finding's page gets a **Proof test** section: the button **Run proof
  test**, then the outcome, the test, the observed effect and the output,
  with **Retest** and **Copy test**. The findings list can filter on Proven.
- UI copy uses "proof test" for the feature everywhere. "Validation" already
  means the second review, so the dashboard does not say "verify".
- The fix prompt includes the deciding test when one is Proven, so a coding
  agent knows the input that must stop working.

## Where the code lives

Execution stays in `src/redteam/`, as the scan rules require.

- `src/redteam/proof-model.ts`: outcomes, case records, the test rules and
  `decideProof()`, with no `node:` imports, so the dashboard bundle can import
  it. Pins, the supported CWEs and limits are in `src/redteam/constants.ts`.
- `src/redteam/proof-run.ts`: checks a test and runs it once through
  `runWorker()`. `runtime.ts` builds the images with `prepareProofRuntime()`.
- From M11b, `src/redteam/proof-session.ts`: the session loop. `redteam` may
  not import `assessment`, so the session receives the read tools as a
  parameter. The generic turn loop of `exploreSession()` (limits, closing
  notice, cut replies) moves to `src/redteam/` so both sessions share it.
- `src/security/` maps a `SecurityFinding` to the session's input and stores
  records through a new `storage` repository. The dashboard adds its API paths
  to `src/dashboard/contract.ts`.

## Threats

| Threat | Mitigation |
| --- | --- |
| Project code harms the host | Networkless container, non-root, read-only root, resource and time limits, the isolation checks, expiry labels |
| Project code sends data out | No network; environment and key files not copied; host environment not passed; output redacted before the model sees it |
| The test fakes the effect | Attribution to cited project frames through the entry, a fresh marker per run, refused test calls, changed-code detection, test rules |
| The test changes a check and restores it before the case ends | Python records module changes when they happen; both harnesses compare the watched state at each effect |
| Text in the project steers the model toward a cheating test | The same checks; the test is shown in full; safe twins in every measurement |
| A test passes a crafted object that defeats a check, such as a string subclass whose methods lie | Not prevented. Safe twins measure it; see the open questions |
| A test written to evade the text rules, such as one that passes a standard-library method as a callback through `getattr`, or reaches the harness through the module table | Not prevented: the harness shares a process with the test. The rules and checks stop a test that cheats by accident or on a hint, not one written to defeat the harness. The test is shown in full |
| A proof is read as a statement about safety | Not reproduced says it is not evidence of safety; Proven names the effect and the input |
| Cost | Explicit start, maximum shown, enforced by `ModelBudget` |

## Checkpoints

| Checkpoint | Deliverable | Acceptance |
| --- | --- | --- |
| M11a Harness and oracles | Both images with the package set, the harness, CWE-22 and CWE-78 oracles, the run frames and handwritten tests. No model | For 8 pairs (both weaknesses, both families) the handwritten test is Proven on the vulnerable twin and Not reproduced on the safe twin. Adversarial tests are never Proven: a test that creates the effect, passes a callback that does, or changes a setting, a project function, the standard library or an intrinsic, also when it restores it. Every isolation check reports. Container tests skip unless `PLENGER_TEST_PROOF_PYTHON_IMAGE` and `PLENGER_TEST_PROOF_NODE_IMAGE` are set |
| M11b Proof session | The model session, limits, cost before start, records, the dashboard section and a scripted-model integration test | Three live runs on the labeled pairs: no safe twin Proven; yield, Could not run reasons, tokens and time recorded |
| M11c Retest | Retest, the intended-case gate and the test in the fix prompt | Each proving test from M11b is Not reproduced against its safe twin with the intended case passing |
| M11d Coverage | CWE-89 and CWE-502 oracles; the dependency decision for packages outside the set | Runnable share on the corpus and on two named projects recorded; no safe twin Proven |

## Open questions

- Where M11b takes a finding's entry ranges: the routes and tools of the static
  inventory that reach the cited file, or the finding's first evidence range.
  The model must not choose them, or it could pick an inner helper.
- Project dependencies outside the package set: lockfile install in a build
  stage or an image the user supplies. Measure first how many imports of real
  projects the set leaves out.
- TypeScript that needs transformation, and mapping its coverage back to the
  cited lines.
- A guarded folder for prefix bugs on subfolders of the test's folder, without
  letting a test place a canary where the code may legitimately read.
- Whether **Copy test** should give a pytest or `node:test` version that runs
  without the harness, as a regression test for the repository.
- Whether payload inputs should be limited to plain values (strings, numbers,
  lists, maps) to close the crafted-object gap.
- Whether a proof test may run on a `needs-review` finding to settle it.
- Whether Proven should change how findings are sorted.
