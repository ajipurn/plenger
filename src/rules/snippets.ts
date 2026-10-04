import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../shared/secrets.ts";
import type { Finding } from "./model.ts";

const SNIPPET_WIDTH = 160;

/**
 * Adds the source line of each finding and evidence location, trimmed, with anything
 * that looks like a secret replaced by `<redacted>`. Files that cannot be read are skipped.
 */
export async function attachSnippets(root: string, findings: Finding[]): Promise<void> {
  const lines = new Map<string, string[] | null>();
  const lineAt = async (path: string, line: number): Promise<string | undefined> => {
    let file = lines.get(path);
    if (file === undefined) {
      try {
        file = (await readFile(join(root, path), "utf8")).split(/\r?\n/);
      } catch {
        file = null;
      }
      lines.set(path, file);
    }
    const text = file?.[line - 1]?.trim();
    return text === undefined || text === "" ? undefined : clip(redact(text));
  };
  for (const finding of findings) {
    const snippet = await lineAt(finding.location.path, finding.location.line);
    if (snippet !== undefined) finding.snippet = snippet;
    for (const step of finding.evidence) {
      const text = await lineAt(step.location.path, step.location.line);
      if (text !== undefined) step.snippet = text;
    }
  }
}

function clip(text: string): string {
  return text.length <= SNIPPET_WIDTH ? text : `${text.slice(0, SNIPPET_WIDTH - 1)}…`;
}
