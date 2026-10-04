/** Short readable forms of canonical names and routes, shared by the inventory, rules and reports. */

/** The last name segment of a canonical name: `openai.OpenAI()` → `OpenAI`, `ai#generateText` → `generateText`. */
export function shortName(target: string): string {
  return /([\w$]+)(?:\(\))?$/.exec(target)?.[1] ?? target;
}

/** `openai.OpenAI().chat.completions.create` → `chat.completions.create`; `ai#generateText` → `generateText`. */
export function callLabel(target: string): string {
  const afterClient = /\(\)\.(.+)$/.exec(target)?.[1];
  return (afterClient ?? shortName(target)).replace(/\(\)/g, "");
}

/** `POST /chat`, `/health`, or `?` when the path is unknown. */
export function routeLabel(entry: { method: string | null; path: string | null }): string {
  return `${entry.method ?? ""} ${entry.path ?? "?"}`.trim();
}
