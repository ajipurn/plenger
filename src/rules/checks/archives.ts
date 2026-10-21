import type { CallFact, FileFacts, Value } from "../../facts/model.ts";
import { compilePatterns } from "../../facts/pattern.ts";
import { deref, literalString, select } from "../../facts/query.ts";
import type { Location } from "../../inventory/model.ts";
import type { RuleContext } from "../context.ts";
import type { Draft } from "../model.ts";
import { code } from "../text.ts";

/** Extracting members of an archive `tarfile` opened (`tarfile.open(p).extractall(d)`). */
const EXTRACT = compilePatterns(["tarfile.{open,TarFile,TarFile.open}()**.{extractall,extract}"]);
/** The filters that refuse members outside the destination and links that leave it. */
const SAFE_FILTER = /^(?:data|tar)$/;
const SAFE_FILTER_FUNCTION = /^tarfile\.(?:data_filter|tar_filter)$/;

/**
 * PLG808: a tar archive extracted with no filter and no member selection. Its members
 * are the untrusted input, whoever passed the archive, so no source is traced. An
 * archive opened from a literal path ships with the code and is left out.
 */
export function archiveChecks(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const [path, file] of cx.project.files) {
    if (file.language !== "python") continue;
    const facts = file.facts;
    for (const call of facts.calls) {
      const name = call.ref?.name;
      if (name === undefined || !EXTRACT.test(name)) continue;
      if (filtered(call, facts) || bundled(call, facts)) continue;
      const location: Location = { path, ...call.span };
      const where = call.scope ?? path;
      const method = name.endsWith(".extract") ? "extract" : "extractall";
      const checks = memberChecks(call, facts);
      drafts.push({
        rule: "PLG808",
        title: `${code(where)} extracts a tar archive without checking its members`,
        severity: "medium",
        // A check called on the archive first is read by its name, not verified.
        confidence: checks.length > 0 ? "low" : "medium",
        location,
        subject: { kind: "code", name: where },
        evidence: [
          {
            location,
            message: `${code(method)} with no \`filter\` and no \`members\` selection`,
          },
        ],
        notes: [
          'A member named `../x`, an absolute path or a link that points outside the destination is written where it says. Python 3.12 adds `filter="data"`, which refuses them; it is the default from Python 3.14.',
          ...(checks.length > 0 ? [`Checks seen on the way: ${checks.map(code).join(", ")}.`] : []),
        ],
        exposed: false,
        key: [where, method],
      });
    }
  }
  return drafts;
}

/** A call named like a check (`check_tarfile_security`, `validate_archive`). */
const CHECK = /(?:check|valid|verif|safe|secur|saniti)/i;

/**
 * Calls named like a check that the function makes before the extraction, on the archive
 * path or the opened archive: `check_tarfile_security(archive_path)`.
 */
function memberChecks(call: CallFact, facts: FileFacts): string[] {
  const opener = openingCall(call, facts);
  const [archive] = opener === undefined ? [] : select(opener.arguments, facts, "name|#0");
  const holder = call.receiver === undefined ? undefined : facts.assignments[call.receiver];
  const names = new Set(
    [archive?.kind === "name" ? archive.text : undefined, holder?.target].filter(
      (item): item is string => item !== undefined,
    ),
  );
  const before = (other: CallFact) =>
    other.span.line < call.span.line ||
    (other.span.line === call.span.line && other.span.column < call.span.column);
  return facts.calls
    .filter(
      (other) =>
        other.scope === call.scope &&
        before(other) &&
        CHECK.test(other.callee) &&
        other.arguments.some((arg) => arg.value.kind === "name" && names.has(arg.value.text)),
    )
    .map((other) => other.callee);
}

/** Whether the call passes a filter that stops escaping members, or chooses its members. */
function filtered(call: CallFact, facts: FileFacts): boolean {
  if (call.arguments.some((arg) => arg.keyword === "members" || arg.spread)) return true;
  const [filter] = select(call.arguments, facts, "filter");
  if (filter === undefined) return false;
  const text = literalString(filter, facts);
  if (text !== null) return SAFE_FILTER.test(text);
  const target = deref(filter, facts);
  const ref = target.kind === "name" ? target.ref?.name : undefined;
  // A filter function the code chooses is its member check.
  return ref === undefined || SAFE_FILTER_FUNCTION.test(ref) || !/^tarfile\./.test(ref);
}

/** Whether the archive is opened from a literal path, a file the project ships. */
function bundled(call: CallFact, facts: FileFacts): boolean {
  const opener = openingCall(call, facts);
  const [archive] = opener === undefined ? [] : select(opener.arguments, facts, "name|#0");
  return archive !== undefined && literalString(archive, facts) !== null;
}

/** The `tarfile.open(...)` call the archive object comes from: in the chain or the variable. */
function openingCall(call: CallFact, facts: FileFacts): CallFact | undefined {
  const holder = call.receiver === undefined ? undefined : facts.assignments[call.receiver];
  const value: Value | undefined = holder?.value;
  const target = value === undefined ? undefined : deref(value, facts);
  if (target?.kind === "call") return facts.calls[target.call];
  return facts.calls.find(
    (candidate) =>
      candidate !== call &&
      candidate.span.line === call.span.line &&
      candidate.span.column === call.span.column &&
      /^tarfile\./.test(candidate.ref?.name ?? ""),
  );
}
