import { familyOf, type Language, type LanguageFamily } from "../source/languages.ts";

interface FrameworkInfo {
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
    id: "openai-agents",
    name: "OpenAI Agents SDK",
    python: ["agents"],
    javascript: ["@openai/agents", "@openai/agents-*"],
  },
  { id: "crewai", name: "CrewAI", python: ["crewai", "crewai_tools"] },
  { id: "pydantic-ai", name: "Pydantic AI", python: ["pydantic_ai"] },
  { id: "smolagents", name: "smolagents", python: ["smolagents"] },
  {
    id: "autogen",
    name: "AutoGen",
    python: ["autogen_agentchat", "autogen_core", "autogen_ext", "autogen", "ag2"],
  },
  { id: "llamaindex", name: "LlamaIndex", python: ["llama_index"] },
  { id: "litellm", name: "LiteLLM", python: ["litellm"] },
  {
    id: "google-genai",
    name: "Google GenAI",
    python: ["google.genai", "google.generativeai"],
    javascript: ["@google/genai", "@google/generative-ai"],
  },
  { id: "bedrock", name: "AWS Bedrock", javascript: ["@aws-sdk/client-bedrock-runtime"] },
  { id: "ollama", name: "Ollama", python: ["ollama"], javascript: ["ollama"] },
  { id: "mastra", name: "Mastra", javascript: ["@mastra/*"] },
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
  { id: "sqlite", name: "SQLite", javascript: ["better-sqlite3", "node:sqlite"] },
  /** Tool classes built on a base class the project defines itself. */
  { id: "project-tools", name: "Project tool classes" },
];

/**
 * AI libraries plenger recognises by import but has no detectors for yet. Importing
 * one is reported as unrecognised usage rather than dropped silently.
 */
const UNSUPPORTED_AI_MODULES: Record<LanguageFamily, string[]> = {
  python: [
    "vertexai",
    "cohere",
    "mistralai",
    "groq",
    "together",
    "haystack",
    "dspy",
    "semantic_kernel",
    "instructor",
    "transformers",
    "agno",
    "strands",
  ],
  javascript: [
    "llamaindex",
    "@mistralai/mistralai",
    "groq-sdk",
    "cohere-ai",
    "@huggingface/*",
    "@voltagent/*",
  ],
};

/**
 * Whether `module` is `prefix` or below it. Python modules nest with `.`, JS
 * packages with `/`; a trailing `*` in the prefix matches any name continuation
 * (`langchain_*` covers `langchain_openai`).
 */
function moduleMatches(module: string, prefix: string, language: Language): boolean {
  if (prefix.endsWith("*")) return module.startsWith(prefix.slice(0, -1));
  const separator = language === "python" ? "." : "/";
  return module === prefix || module.startsWith(prefix + separator);
}

export function frameworkOfModule(module: string, language: Language): FrameworkInfo | undefined {
  const family = familyOf(language);
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
  return UNSUPPORTED_AI_MODULES[familyOf(language)].find((prefix) =>
    moduleMatches(module, prefix, language),
  );
}
