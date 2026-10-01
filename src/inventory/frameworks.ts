import type { Language } from "../languages.ts";

export interface FrameworkInfo {
  id: string;
  name: string;
  /** Import modules that mean the framework is used: exact, or a parent of the module. */
  python?: string[];
  javascript?: string[];
}

/** Frameworks plenger has detectors for. */
export const FRAMEWORKS: FrameworkInfo[] = [
  { id: "openai", name: "OpenAI SDK", python: ["openai"], javascript: ["openai"] },
  {
    id: "anthropic",
    name: "Anthropic SDK",
    python: ["anthropic"],
    javascript: ["@anthropic-ai/sdk", "@anthropic-ai/bedrock-sdk", "@anthropic-ai/vertex-sdk"],
  },
  { id: "vercel-ai", name: "Vercel AI SDK", javascript: ["ai", "@ai-sdk"] },
  {
    id: "langchain",
    name: "LangChain",
    python: ["langchain", "langchain_core", "langchain_community", "langchain_*"],
    javascript: ["langchain", "@langchain/core", "@langchain/community", "@langchain/*"],
  },
  {
    id: "langgraph",
    name: "LangGraph",
    python: ["langgraph"],
    javascript: ["@langchain/langgraph"],
  },
  {
    id: "mcp",
    name: "MCP",
    python: ["mcp", "fastmcp", "langchain_mcp_adapters"],
    javascript: ["@modelcontextprotocol", "fastmcp", "@langchain/mcp-adapters"],
  },
  { id: "llmfy", name: "llmfy", python: ["llmfy"] },
  {
    id: "vector-db",
    name: "Vector database",
    python: ["chromadb", "pinecone", "qdrant_client", "weaviate", "faiss"],
    javascript: ["chromadb", "@pinecone-database/pinecone", "@qdrant/js-client-rest"],
  },
  { id: "fastapi", name: "FastAPI", python: ["fastapi"] },
  { id: "flask", name: "Flask", python: ["flask"] },
  { id: "django", name: "Django", python: ["django"] },
  { id: "express", name: "Express", javascript: ["express"] },
  { id: "hono", name: "Hono", javascript: ["hono"] },
  { id: "fastify", name: "Fastify", javascript: ["fastify"] },
  { id: "nextjs", name: "Next.js", javascript: ["next"] },
];

/**
 * AI libraries plenger recognises by import but has no detectors for yet. Importing
 * one is reported as unrecognised usage rather than dropped silently.
 */
export const UNSUPPORTED_AI_MODULES: Record<Language, string[]> = {
  python: [
    "google.genai",
    "google.generativeai",
    "vertexai",
    "litellm",
    "ollama",
    "cohere",
    "mistralai",
    "groq",
    "together",
    "crewai",
    "autogen",
    "autogen_agentchat",
    "autogen_core",
    "autogen_ext",
    "pydantic_ai",
    "smolagents",
    "llama_index",
    "haystack",
    "dspy",
    "semantic_kernel",
    "instructor",
    "transformers",
  ],
  javascript: [
    "@openai/agents",
    "@mastra/*",
    "llamaindex",
    "@google/genai",
    "@google/generative-ai",
    "ollama",
    "@mistralai/mistralai",
    "groq-sdk",
    "cohere-ai",
    "@huggingface/*",
    "@aws-sdk/client-bedrock-runtime",
  ],
  typescript: [],
};

/**
 * Whether `module` is `prefix` or below it. Python modules nest with `.`, JS
 * packages with `/`; a trailing `*` in the prefix matches any name continuation
 * (`langchain_*` covers `langchain_openai`).
 */
export function moduleMatches(module: string, prefix: string, language: Language): boolean {
  if (prefix.endsWith("*")) return module.startsWith(prefix.slice(0, -1));
  const separator = language === "python" ? "." : "/";
  return module === prefix || module.startsWith(prefix + separator);
}

export function frameworkOfModule(module: string, language: Language): FrameworkInfo | undefined {
  const family = language === "python" ? "python" : "javascript";
  // More specific frameworks first: LangGraph's JS package lives under @langchain.
  let best: { info: FrameworkInfo; length: number } | undefined;
  for (const info of FRAMEWORKS) {
    for (const prefix of info[family] ?? []) {
      if (
        moduleMatches(module, prefix, language) &&
        (best === undefined || prefix.length > best.length)
      ) {
        best = { info, length: prefix.length };
      }
    }
  }
  return best?.info;
}

export function unsupportedModule(module: string, language: Language): string | undefined {
  const family = language === "python" ? "python" : "javascript";
  return UNSUPPORTED_AI_MODULES[family].find((prefix) => moduleMatches(module, prefix, language));
}
