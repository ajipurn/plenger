import type { APIRoute } from "astro";
import { SITE } from "../site.ts";

/** A plain summary for AI agents, in the llms.txt format. Claims follow docs/STATUS.md. */
export const GET: APIRoute = ({ site }) => {
  const docs = new URL("/docs/", site).href;
  const body = `# ${SITE.name}

> Security review that runs locally. One npm package starts a dashboard on your machine
> for an AI source review, a second skeptical review and STRIDE threat modeling.

- Static triage reads Python, JavaScript and TypeScript without running project code. It
  traces where request input and model output reach a shell, a file, SQL or a tool.
- The AI source review reads text files in any language, with the model connection you
  choose: Claude, ChatGPT, OpenAI, Gemini or a local Ollama.
- A separate second review rereads each candidate with its imports and callers.
- Source leaves the machine only for the chosen provider, redacted and within a budget.
- Requires Node.js 22.23.4+, 24.22.1+ or 26.12.1+. Start it with \`npx plenger@latest\`.

## Docs

- [Documentation](${docs}): install, dashboard, reports and CI
- [Status](${SITE.repository}/blob/main/docs/STATUS.md): what is available today and what is pending
- [Source](${SITE.repository}): Apache License 2.0
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
