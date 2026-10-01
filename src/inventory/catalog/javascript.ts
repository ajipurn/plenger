import type { Rule } from "../rules.ts";

// `openai#default` (default import), `openai#OpenAI` (named) and `openai` (require).
const OPENAI = "openai{#default,#OpenAI,#AzureOpenAI,}";
const ANTHROPIC = "@anthropic-ai/sdk{#default,#Anthropic,}";
const ANTHROPIC_CLOUD =
  "@anthropic-ai/{bedrock-sdk,vertex-sdk}{#default,#AnthropicBedrock,#AnthropicVertex,}";
const CHAT_MODELS = [
  "@langchain/*#Chat*",
  "@langchain/*#AzureChatOpenAI",
  "langchain/chat_models/universal#initChatModel",
  "langchain#initChatModel",
];
const RUNS = "{invoke,stream,batch,streamEvents}";
const MCP_SERVER = [
  "@modelcontextprotocol/sdk/server/{mcp.js,mcp}#McpServer()",
  "@modelcontextprotocol/server#McpServer()",
];
const MCP_LOW_LEVEL = "@modelcontextprotocol/sdk/server/{index.js,index}#Server";
const HTTP = "{get,post,put,patch,delete,head,options,all}";
const AI_SDK_PROVIDERS =
  "@ai-sdk/{openai,anthropic,google,google-vertex,azure,amazon-bedrock,mistral,groq,xai,deepseek,cohere,togetherai,fireworks,perplexity,cerebras,openai-compatible,gateway}";

const members = (base: string[], suffixes: string[]) =>
  base.flatMap((prefix) => suffixes.map((suffix) => `${prefix}.${suffix}`));

export const JAVASCRIPT_RULES: Rule[] = [
  // OpenAI SDK
  { kind: "model", framework: "openai", calls: [OPENAI], baseUrl: "baseURL", apiKey: "apiKey" },
  {
    kind: "llm_call",
    framework: "openai",
    calls: [
      `${OPENAI}().chat.completions.{create,parse,stream}`,
      `${OPENAI}().beta.chat.completions.{create,parse,stream}`,
      `${OPENAI}().completions.create`,
    ],
    model: "model",
    system: ["messages[role=system].content", "messages[role=developer].content"],
    user: ["messages[role=user].content", "prompt", "messages"],
    tools: "tools",
  },
  {
    kind: "llm_call",
    framework: "openai",
    calls: [`${OPENAI}().responses.{create,parse,stream}`],
    model: "model",
    system: ["instructions", "input[role=system].content", "input[role=developer].content"],
    user: ["input", "input[role=user].content"],
    tools: "tools",
  },

  // Anthropic SDK
  {
    kind: "model",
    framework: "anthropic",
    calls: [ANTHROPIC, ANTHROPIC_CLOUD],
    baseUrl: "baseURL",
    apiKey: "apiKey",
  },
  {
    kind: "llm_call",
    framework: "anthropic",
    calls: [
      `${ANTHROPIC}().messages.{create,stream}`,
      `${ANTHROPIC}().beta.messages.{create,stream}`,
      `${ANTHROPIC_CLOUD}().messages.{create,stream}`,
    ],
    model: "model",
    system: ["system", "system[*].text"],
    user: ["messages[role=user].content", "messages[role=user].content[*].text", "messages"],
    tools: "tools",
  },

  // Vercel AI SDK
  {
    kind: "model",
    framework: "vercel-ai",
    calls: [
      `${AI_SDK_PROVIDERS}#*`,
      `${AI_SDK_PROVIDERS}#create*()`,
      `${AI_SDK_PROVIDERS}#*.{chat,responses,languageModel}`,
      "ollama-ai-provider{,-v2}#ollama",
    ],
    model: "#0",
    baseUrl: "baseURL",
    apiKey: "apiKey",
  },
  {
    kind: "llm_call",
    framework: "vercel-ai",
    calls: ["ai#{generateText,streamText,generateObject,streamObject}"],
    model: "model",
    system: ["system", "messages[role=system].content"],
    user: ["prompt", "messages[role=user].content", "messages"],
    tools: "tools",
  },
  {
    kind: "tool_factory",
    framework: "vercel-ai",
    calls: ["ai#{tool,dynamicTool}"],
    handler: "execute",
    description: "description",
  },
  {
    kind: "agent",
    framework: "vercel-ai",
    calls: ["ai#{Agent,Experimental_Agent,ToolLoopAgent}"],
    name: "name",
    model: "model",
    system: ["system", "instructions"],
    tools: "tools",
    invokeMethods: ["generate", "stream"],
    input: ["prompt", "messages[role=user].content", "messages"],
  },

  // LangChain.js
  {
    kind: "model",
    framework: "langchain",
    calls: CHAT_MODELS,
    model: "model|modelName|#0",
    apiKey: "apiKey|openAIApiKey|anthropicApiKey",
    baseUrl: "configuration.baseURL|baseUrl",
  },
  {
    kind: "llm_call",
    framework: "langchain",
    calls: CHAT_MODELS.map((model) => `${model}()**.${RUNS}`),
    system: ["#0[role=system].content", "#0[0=system].1"],
    user: ["#0", "#0[role=user].content", "#0[0=user].1", "#0[0=human].1"],
  },
  {
    kind: "tool_binding",
    framework: "langchain",
    calls: CHAT_MODELS.map((model) => `${model}()**.bindTools`),
    tools: "#0",
  },
  {
    kind: "tool_factory",
    framework: "langchain",
    calls: ["@langchain/core/tools#tool", "langchain#tool"],
    handler: "#0",
    name: "#1.name",
    description: "#1.description",
  },
  {
    kind: "tool_factory",
    framework: "langchain",
    calls: ["@langchain/core/tools#{DynamicStructuredTool,DynamicTool}"],
    handler: "func",
    name: "name",
    description: "description",
  },
  {
    kind: "tool_class",
    framework: "langchain",
    bases: ["@langchain/core/tools#{StructuredTool,Tool}"],
    methods: ["_call"],
  },
  {
    kind: "prompt",
    framework: "langchain",
    calls: ["@langchain/core/messages#SystemMessage", "langchain#SystemMessage"],
    text: "#0|content",
    role: "system",
  },
  {
    kind: "prompt",
    framework: "langchain",
    calls: ["@langchain/core/prompts#ChatPromptTemplate.fromMessages"],
    text: "#0[0=system].1",
    role: "system",
    braces: true,
  },
  {
    kind: "prompt",
    framework: "langchain",
    calls: ["@langchain/core/prompts#{PromptTemplate,ChatPromptTemplate}.fromTemplate"],
    text: "#0|template",
    role: "template",
    braces: true,
  },
  {
    kind: "data_store",
    framework: "langchain",
    calls: [
      "@langchain/**/vectorstores/*#*",
      "@langchain/**/vectorstores/*#*.{fromDocuments,fromTexts,fromExistingIndex}",
      "@langchain/{pinecone,qdrant,mongodb,weaviate,redis}#*Store",
      "@langchain/{pinecone,qdrant,mongodb,weaviate,redis}#*Store.{fromDocuments,fromTexts,fromExistingIndex}",
      "langchain/vectorstores/memory#MemoryVectorStore{,.fromDocuments,.fromTexts}",
    ],
    store: "vector_store",
  },
  {
    kind: "data_store",
    framework: "langchain",
    calls: ["@langchain/*#*Embeddings"],
    store: "embeddings",
  },
  { kind: "data_store", framework: "langchain", calls: ["**.asRetriever"], store: "retriever" },

  // LangGraph.js
  {
    kind: "agent",
    framework: "langgraph",
    calls: ["@langchain/langgraph/prebuilt#createReactAgent"],
    name: "name",
    model: "llm|model",
    system: ["prompt", "messageModifier", "stateModifier"],
    tools: "tools",
    invoke: [`@langchain/langgraph/prebuilt#createReactAgent()**.${RUNS}`],
    invokeMethods: ["invoke", "stream", "batch", "streamEvents"],
    input: ["#0.messages[role=user].content", "#0.messages[0=user].1", "#0.messages", "#0"],
  },
  {
    kind: "agent",
    framework: "langchain",
    calls: ["langchain#createAgent"],
    name: "name",
    model: "model",
    system: ["systemPrompt", "prompt"],
    tools: "tools",
    invoke: [`langchain#createAgent()**.${RUNS}`],
    invokeMethods: ["invoke", "stream", "batch", "streamEvents"],
    input: ["#0.messages[role=user].content", "#0.messages[0=user].1", "#0.messages", "#0"],
  },
  {
    kind: "agent",
    framework: "langgraph",
    calls: ["@langchain/langgraph#StateGraph"],
    invoke: [`@langchain/langgraph#StateGraph()**.compile()**.${RUNS}`],
    invokeMethods: ["invoke", "stream", "batch", "streamEvents"],
    input: ["#0.messages[role=user].content", "#0.messages[0=user].1", "#0.messages", "#0"],
  },
  {
    kind: "graph_node",
    framework: "langgraph",
    calls: ["@langchain/langgraph#StateGraph()**.addNode"],
    name: "#0",
    handler: "#1",
  },
  {
    kind: "tool_binding",
    framework: "langgraph",
    calls: ["@langchain/langgraph/prebuilt#ToolNode"],
    tools: "#0",
  },
  {
    kind: "data_store",
    framework: "langgraph",
    calls: [
      "@langchain/langgraph#{MemorySaver,InMemoryStore}",
      "@langchain/langgraph-checkpoint-*#*{Saver,Store}{,.fromConnString}",
    ],
    store: "checkpointer",
  },

  // MCP TypeScript SDK and fastmcp
  {
    kind: "mcp_server",
    framework: "mcp",
    calls: [...MCP_SERVER.map((server) => server.slice(0, -2)), MCP_LOW_LEVEL, "fastmcp#FastMCP"],
    name: "#0.name|name",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "tool",
    calls: members(MCP_SERVER, ["tool"]),
    name: "#0",
    description: "#1",
    handler: "#-1",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "tool",
    calls: members(MCP_SERVER, ["registerTool"]),
    name: "#0",
    description: "#1.description",
    handler: "#-1",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "tool",
    calls: ["fastmcp#FastMCP().addTool"],
    name: "#0.name",
    description: "#0.description",
    handler: "#0.execute",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "resource",
    calls: members(MCP_SERVER, ["resource", "registerResource"]),
    name: "#1|#0",
    handler: "#-1",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "prompt",
    calls: members(MCP_SERVER, ["prompt", "registerPrompt"]),
    name: "#0",
    handler: "#-1",
  },
  {
    kind: "mcp_transport",
    framework: "mcp",
    calls: [...members(MCP_SERVER, ["connect"]), `${MCP_LOW_LEVEL}().connect`],
    transport: "#0",
    fixed: "stdio",
  },
  {
    kind: "mcp_transport",
    framework: "mcp",
    calls: ["fastmcp#FastMCP().start"],
    transport: "transportType",
    fixed: "stdio",
  },
  {
    kind: "mcp_client",
    framework: "mcp",
    calls: ["@modelcontextprotocol/sdk/client/{stdio.js,stdio}#StdioClientTransport"],
    command: "command",
    args: "args",
  },
  {
    kind: "mcp_client",
    framework: "mcp",
    calls: [
      "@modelcontextprotocol/sdk/client/{streamableHttp.js,streamableHttp}#StreamableHTTPClientTransport",
      "@modelcontextprotocol/sdk/client/{sse.js,sse}#SSEClientTransport",
    ],
    url: "#0",
  },
  {
    kind: "mcp_client",
    framework: "mcp",
    calls: ["@langchain/mcp-adapters#MultiServerMCPClient"],
    servers: "mcpServers|#0",
  },

  // OpenAI Agents SDK
  {
    kind: "agent",
    framework: "openai-agents",
    calls: ["@openai/agents{,-core}#Agent"],
    name: "name",
    model: "model",
    system: ["instructions"],
    tools: "tools",
    delegates: "handoffs",
    mcp: "mcpServers",
  },
  {
    kind: "agent_run",
    framework: "openai-agents",
    calls: ["@openai/agents{,-core}#run", "@openai/agents{,-core}#Runner().run"],
    agent: "#0",
    input: ["#1"],
  },
  {
    kind: "tool_factory",
    framework: "openai-agents",
    calls: ["@openai/agents{,-core}#tool"],
    handler: "execute",
    name: "name",
    description: "description",
  },
  {
    kind: "tool_builtin",
    framework: "openai-agents",
    calls: [
      "@openai/agents{,-core,-openai}#{webSearchTool,fileSearchTool,codeInterpreterTool,computerTool,shellTool,applyPatchTool,hostedMcpTool,imageGenerationTool}",
    ],
  },
  {
    kind: "mcp_client",
    framework: "openai-agents",
    calls: ["@openai/agents{,-core}#MCPServerStdio"],
    command: "fullCommand|command",
    args: "args",
  },
  {
    kind: "mcp_client",
    framework: "openai-agents",
    calls: ["@openai/agents{,-core}#{MCPServerStreamableHttp,MCPServerSSE}"],
    url: "url",
  },

  // Mastra
  {
    kind: "agent",
    framework: "mastra",
    calls: ["@mastra/core{/agent,}#Agent"],
    name: "name",
    model: "model",
    system: ["instructions"],
    tools: "tools",
    invokeMethods: ["generate", "stream", "generateVNext", "streamVNext"],
    input: ["#0"],
  },
  {
    kind: "tool_factory",
    framework: "mastra",
    calls: ["@mastra/core{/tools,}#createTool"],
    handler: "execute",
    name: "id",
    description: "description",
  },
  { kind: "mcp_client", framework: "mastra", calls: ["@mastra/mcp#MCPClient"], servers: "servers" },
  { kind: "mcp_server", framework: "mastra", calls: ["@mastra/mcp#MCPServer"], name: "name" },

  // Google GenAI
  {
    kind: "model",
    framework: "google-genai",
    calls: ["@google/genai#GoogleGenAI"],
    apiKey: "apiKey",
  },
  {
    kind: "llm_call",
    framework: "google-genai",
    calls: ["@google/genai#GoogleGenAI()**.models.{generateContent,generateContentStream}"],
    model: "model",
    system: ["config.systemInstruction"],
    user: ["contents"],
    tools: "config.tools",
  },

  // AWS Bedrock
  {
    kind: "model",
    framework: "bedrock",
    calls: ["@aws-sdk/client-bedrock-runtime#BedrockRuntimeClient"],
  },
  {
    kind: "llm_call",
    framework: "bedrock",
    calls: ["@aws-sdk/client-bedrock-runtime#BedrockRuntimeClient().send"],
    model: "#0.modelId",
    system: ["#0.system[*].text"],
    user: ["#0.messages[role=user].content[*].text", "#0.messages"],
  },

  // Ollama
  { kind: "model", framework: "ollama", calls: ["ollama#Ollama"], baseUrl: "host" },
  {
    kind: "llm_call",
    framework: "ollama",
    calls: ["ollama#default.{chat,generate}", "ollama#Ollama().{chat,generate}"],
    model: "model",
    system: ["messages[role=system].content", "system"],
    user: ["messages[role=user].content", "prompt", "messages"],
    tools: "tools",
  },

  // Vector databases used directly
  {
    kind: "data_store",
    framework: "vector-db",
    calls: [
      "chromadb#ChromaClient",
      "@pinecone-database/pinecone#Pinecone",
      "@qdrant/js-client-rest#QdrantClient",
    ],
    store: "vector_store",
  },

  // Web entry points
  {
    kind: "route",
    framework: "express",
    calls: [
      `express{#default,}(){,.Router()}.${HTTP}`,
      `express{#default,}.Router().${HTTP}`,
      `express#Router().${HTTP}`,
    ],
    path: "#0",
    handler: "#-1",
  },
  { kind: "route", framework: "hono", calls: [`hono#Hono().${HTTP}`], path: "#0", handler: "#-1" },
  {
    kind: "route",
    framework: "fastify",
    calls: [`fastify{#default,}().${HTTP}`],
    path: "#0",
    handler: "#-1",
  },
];
