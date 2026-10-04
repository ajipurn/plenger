/** Prompts found in one file, de-duplicated by position, role and text, and the inputs of calls. */

import { ANONYMOUS, type DefinitionFact, type Span, type Value } from "../../facts/model.ts";
import { type DynamicPart, deref, dynamicPart, summarizeText } from "../../facts/query.ts";
import { redact, secretIn } from "../../shared/secrets.ts";
import type { Inventory, Prompt } from "../model.ts";
import type { FileScope } from "./file-scope.ts";

export class PromptCollector {
  readonly #scope: FileScope;
  readonly #inventory: Inventory;
  readonly #prompts = new Map<string, Prompt>();

  constructor(scope: FileScope, inventory: Inventory) {
    this.#scope = scope;
    this.#inventory = inventory;
  }

  /** A prompt from a value passed at `site`, a call evaluated in its `scope`. */
  prompt(
    value: Value,
    role: Prompt["role"],
    site: { span: Span; scope: string | null },
    usedBy: string | null,
    declared: string[] = [],
    braces = role === "template",
  ): Prompt | null {
    const facts = this.#scope.facts;
    const summary = summarizeText(value, facts, site.scope);
    if (summary === null || summary.text.trim() === "") return null;
    const origin = summary.origin === null ? undefined : facts.assignments[summary.origin];
    const at = origin?.span ?? site.span;
    const key = `${at.line}:${at.column}:${role}:${summary.text}`;
    let prompt = this.#prompts.get(key);
    if (prompt === undefined) {
      const variables = new Set(declared);
      for (const fixed of summary.fixed) {
        for (const match of fixed.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g))
          variables.add(match[1] as string);
        if (braces) {
          for (const match of fixed.matchAll(/(?<!\{)\{([A-Za-z_]\w*)\}(?!\})/g))
            variables.add(match[1] as string);
        }
      }
      prompt = {
        id: this.#scope.id("prompt", at),
        location: this.#scope.location(at),
        role,
        text: redact(summary.text),
        dynamic: uniqueParts(summary.dynamic),
        variables: [...variables],
        usedBy: [],
      };
      const secret = secretIn(summary.text);
      if (secret !== null) prompt.secret = secret;
      if (summary.truncated) prompt.truncated = true;
      this.#prompts.set(key, prompt);
      this.#inventory.prompts.push(prompt);
    } else {
      for (const variable of declared)
        if (!prompt.variables.includes(variable)) prompt.variables.push(variable);
    }
    if (usedBy !== null && !prompt.usedBy.includes(usedBy)) prompt.usedBy.push(usedBy);
    return prompt;
  }

  /** A system prompt produced by a function (`@agent.system_prompt`): its text is only known at run time. */
  functionPrompt(definition: DefinitionFact): Prompt {
    const name = definition.name ?? ANONYMOUS;
    const prompt: Prompt = {
      id: this.#scope.id("prompt", definition.span),
      location: this.#scope.location(definition.span),
      role: "system",
      text: `{${name}()}`,
      dynamic: [{ text: `${name}()`, source: "call", ref: definition.id }],
      variables: [],
      usedBy: [],
    };
    this.#inventory.prompts.push(prompt);
    return prompt;
  }

  /** Non-constant parts of an input passed in a call made in `scope`. */
  inputs(value: Value, scope: string | null): DynamicPart[] {
    const facts = this.#scope.facts;
    const summary = summarizeText(value, facts, scope);
    if (summary !== null) return summary.dynamic;
    const target = deref(value, facts);
    if (target.kind === "name" || target.kind === "call")
      return [dynamicPart(target, facts, scope)];
    return [];
  }
}

/**
 * Drops repeated input parts with the same source and text. (The capability analyzer's
 * `uniqueParts` also keys on the part's origin; the two are kept apart on purpose.)
 */
export function uniqueParts(parts: DynamicPart[]): DynamicPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = `${part.source}:${part.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
