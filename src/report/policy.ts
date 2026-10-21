import { readFile, stat } from "node:fs/promises";
import { type Finding, RULE_BY_ID } from "../rules/index.ts";

export interface Baseline {
  schemaVersion: 1;
  findings: { fingerprint: string; rule: string; path: string }[];
}

export interface Suppression {
  fingerprint?: string;
  rule?: string;
  /** Root-relative path; `*` matches within a segment, `**` across segments. */
  path?: string;
  reason: string;
}

export class PolicyError extends Error {}

export async function readBaseline(path: string): Promise<Baseline> {
  const value = await readPolicy(path);
  checkObject(value, ["schemaVersion", "findings"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.findings)) invalid("expected baseline v1");
  const seen = new Set<string>();
  for (const item of value.findings) {
    checkObject(item, ["fingerprint", "rule", "path"]);
    checkFingerprint(item.fingerprint);
    if (typeof item.rule !== "string" || !/^PLG\d{3}$/.test(item.rule)) invalid("invalid rule id");
    checkPath(item.path);
    if (seen.has(item.fingerprint)) invalid("duplicate baseline fingerprint");
    seen.add(item.fingerprint);
  }
  return value as unknown as Baseline;
}

export async function readSuppressions(path: string): Promise<Suppression[]> {
  const value = await readPolicy(path);
  checkObject(value, ["schemaVersion", "suppressions"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.suppressions)) {
    invalid("expected suppressions v1");
  }
  for (const item of value.suppressions) {
    checkObject(item, ["fingerprint", "rule", "path", "reason"]);
    if (item.fingerprint === undefined && item.rule === undefined) {
      invalid("suppression needs a fingerprint or rule");
    }
    if (item.fingerprint !== undefined) checkFingerprint(item.fingerprint);
    if (item.rule !== undefined && (typeof item.rule !== "string" || !RULE_BY_ID.has(item.rule))) {
      invalid("suppression has an unknown rule");
    }
    if (item.path !== undefined) checkPath(item.path);
    if (typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 1000) {
      invalid("suppression reason must be nonempty text of at most 1000 characters");
    }
  }
  return value.suppressions as Suppression[];
}

export function matchesSuppression(item: Suppression, finding: Finding): boolean {
  return (
    (item.fingerprint === undefined || item.fingerprint === finding.fingerprint) &&
    (item.rule === undefined || item.rule === finding.rule) &&
    (item.path === undefined || glob(item.path).test(finding.location.path))
  );
}

function glob(pattern: string): RegExp {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        expression += "(?:.*/)?";
      } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

async function readPolicy(path: string): Promise<unknown> {
  if ((await stat(path)).size > 4 * 1024 * 1024) invalid("policy file exceeds 4 MiB");
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new PolicyError(`invalid JSON in ${path}`);
  }
}

function checkObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("expected object");
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid("unknown policy field");
}

function checkFingerprint(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/.test(value)) invalid("invalid fingerprint");
}

function checkPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    /[\\\r\n\0:]/.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    invalid("policy paths must be root-relative, using forward slashes");
}

function invalid(message: string): never {
  throw new PolicyError(message);
}
