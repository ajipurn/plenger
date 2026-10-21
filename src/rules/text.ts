/** Wording shared by the rule checks: inline code, lists, labels and the verbs for capabilities. */

import { MAX_DEPTH } from "../capabilities/effects.ts";
import type { CapabilityKind, DynamicPart, TraceGaps } from "../inventory/model.ts";

/** How an MCP server with no name is referred to in titles. */
export const UNNAMED = "unnamed";

/** Text as inline code: whitespace collapsed, clipped to 60 characters. */
export function code(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `\`${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat}\``;
}

/** `a`, `a and b`, `a, b and c`. */
export function listed(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The texts of input parts, as code, for titles and messages. */
export function inputList(parts: DynamicPart[]): string {
  return listed([...new Set(parts.map((part) => part.text))].slice(0, 3).map(code));
}

/** A readable name for a constructor or function: `openai.OpenAI` → `OpenAI`, `openai#default` → `openai`, `FAISS.load_local` stays. */
export function clientLabel(target: string): string {
  const name = target.replace(/\(\)/g, "");
  const module = /^(.+)#default$/.exec(name)?.[1];
  if (module !== undefined) return module;
  const parts = name.split(/[.#]/);
  const last = parts.at(-1) ?? name;
  const previous = parts.at(-2);
  return previous !== undefined && /^[A-Z]/.test(previous) ? `${previous}.${last}` : last;
}

/** What capability kinds let an agent do, as verb phrases for finding titles. */
export const ACTION_PHRASE: Record<CapabilityKind, string> = {
  process: "run commands",
  code: "execute code",
  file_write: "write files",
  file_delete: "delete files",
  file_read: "read files",
  network: "make network requests",
  database: "change databases",
  message: "send messages",
  payment: "make payments",
  secret: "read secrets",
  deserialize: "load unsafe data",
  browser: "drive a browser",
  mcp: "use MCP servers",
  agent: "run other agents",
  llm: "call models",
};

/** What a handler's trace did not follow: "1 call past the depth limit of 6, 2 calls through ...". */
export function traceGapText(trace: Pick<TraceGaps, "depthLimited" | "dynamic">): string {
  const calls = (count: number) => `${count} ${count === 1 ? "call" : "calls"}`;
  return [
    trace.depthLimited ? `${calls(trace.depthLimited)} past the depth limit of ${MAX_DEPTH}` : "",
    trace.dynamic ? `${calls(trace.dynamic)} through a callback, subscript or call result` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
