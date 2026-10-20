import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../shared/secrets.ts";
import type { Finding } from "./model.ts";

const SNIPPET_WIDTH = 160;
/** Reasons longer than this are cut, as suppression reasons in files are limited. */
const REASON_WIDTH = 1000;
/**
 * `# plenger-ignore PLG802 reviewed: files come from a fixed list` in any comment
 * style: the rule ids, then the reason.
 */
const IGNORE =
  /(?:#|\/\/|\/\*|<!--)\s*plenger-ignore\s+(PLG\d{3}(?:\s*,\s*PLG\d{3})*)\b[\s:-]*(.*?)\s*(?:\*\/|-->)?\s*$/;

/**
 * Adds the source line of each finding and evidence location, trimmed, with anything
 * that looks like a secret replaced by `<redacted>`, and the `plenger-ignore` comment
 * for the finding's rule on its line or the line above. Files that cannot be read are
 * skipped.
 */
export async function attachSnippets(root: string, findings: Finding[]): Promise<void> {
  const lines = new Map<string, string[] | null>();
  const rawLine = async (path: string, line: number): Promise<string | undefined> => {
    let file = lines.get(path);
    if (file === undefined) {
      try {
        file = (await readFile(join(root, path), "utf8")).split(/\r?\n/);
      } catch {
        file = null;
      }
      lines.set(path, file);
    }
    return file?.[line - 1];
  };
  const lineAt = async (path: string, line: number): Promise<string | undefined> => {
    const text = (await rawLine(path, line))?.trim();
    return text === undefined || text === "" ? undefined : clip(redact(text));
  };
  for (const finding of findings) {
    const snippet = await lineAt(finding.location.path, finding.location.line);
    if (snippet !== undefined) finding.snippet = snippet;
    for (const line of [finding.location.line, finding.location.line - 1]) {
      const match = IGNORE.exec((await rawLine(finding.location.path, line)) ?? "");
      const rules = match?.[1]?.split(/\s*,\s*/) ?? [];
      if (match === null || !rules.includes(finding.rule)) continue;
      finding.inline = { line, reason: redact(match[2] ?? "").slice(0, REASON_WIDTH) };
      break;
    }
    for (const step of finding.evidence) {
      const text = await lineAt(step.location.path, step.location.line);
      if (text !== undefined) step.snippet = text;
    }
  }
}

function clip(text: string): string {
  return text.length <= SNIPPET_WIDTH ? text : `${text.slice(0, SNIPPET_WIDTH - 1)}…`;
}
