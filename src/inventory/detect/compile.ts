/** Detector rules with their patterns compiled, and the phases that run them. */

import { compilePatterns } from "../../facts/pattern.ts";
import { familyOf, type Language, type LanguageFamily } from "../../source/languages.ts";
import { JAVASCRIPT_RULES } from "../detectors/javascript.ts";
import { PYTHON_RULES } from "../detectors/python.ts";
import type { DetectorRule } from "../detectors.ts";

export interface Compiled {
  rule: DetectorRule;
  calls: RegExp | null;
  decorators: RegExp | null;
  bases: RegExp | null;
  invoke: RegExp | null;
}

const RULES_OF: Record<LanguageFamily, DetectorRule[]> = {
  python: PYTHON_RULES,
  javascript: JAVASCRIPT_RULES,
};

const compiledRules = new Map<LanguageFamily, Compiled[]>();

/** The rules for a language, compiled once per process. */
export function rulesFor(language: Language): Compiled[] {
  const family = familyOf(language);
  let compiled = compiledRules.get(family);
  if (compiled === undefined) {
    compiled = RULES_OF[family].map((rule) => ({
      rule,
      calls: "calls" in rule && rule.calls !== undefined ? compilePatterns(rule.calls) : null,
      decorators:
        "decorators" in rule && rule.decorators !== undefined
          ? compilePatterns(rule.decorators)
          : null,
      bases: "bases" in rule ? compilePatterns(rule.bases) : null,
      invoke:
        rule.kind === "agent" && rule.invoke !== undefined ? compilePatterns(rule.invoke) : null,
    }));
    compiledRules.set(family, compiled);
  }
  return compiled;
}

/**
 * A match of an agent rule's `invoke` or `invokeMethods` pattern. It has no rule kind
 * of its own: the agent rule constructs in one phase and its run calls relate in another.
 */
export const AGENT_INVOCATION = "agent_invocation";

/** What a call or definition can match: a rule kind, or an agent invocation. */
export type MatchKind = DetectorRule["kind"] | typeof AGENT_INVOCATION;

/** Rules that construct something other rules attach to; they run first. */
const CONSTRUCTORS = new Set<MatchKind>([
  "model",
  "agent",
  "mcp_server",
  "tool_factory",
  "prompt",
  "data_store",
  "mcp_client",
  "tool_builtin",
]);

/**
 * The passes over every file's calls, in order: tools and other constructors, then
 * agents (which list tools), then tool bindings (which graph nodes and LLM calls read),
 * then everything that relates components to each other.
 */
export type Phase = "construct_tools" | "construct_agents" | "bind_tools" | "relate";

/** Whether a phase handles matches of a kind. */
export function inPhase(phase: Phase, kind: MatchKind): boolean {
  switch (phase) {
    case "construct_tools":
      return CONSTRUCTORS.has(kind) && kind !== "agent";
    case "construct_agents":
      return kind === "agent";
    case "bind_tools":
      return kind === "tool_binding";
    case "relate":
      return !CONSTRUCTORS.has(kind) && kind !== "tool_binding";
  }
}
