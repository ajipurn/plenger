import { AGENT_METHODS, type Rule } from "../rules.ts";

const OPENAI_CLIENTS = "openai.{OpenAI,AsyncOpenAI,AzureOpenAI,AsyncAzureOpenAI}";
const ANTHROPIC_CLIENTS =
  "anthropic.{Anthropic,AsyncAnthropic,AnthropicBedrock,AsyncAnthropicBedrock,AnthropicVertex,AsyncAnthropicVertex}";
const CHAT_MODELS = [
  "langchain_*.Chat*",
  "langchain_*.AzureChatOpenAI",
  "langchain_community.chat_models.Chat*",
  "langchain_community.chat_models.*.Chat*",
  "langchain.chat_models.init_chat_model",
  "langchain.chat_models.Chat*",
];
const LLMFY_MODELS =
  "{OpenAIChatModel,OpenAIResponsesModel,AnthropicMessagesModel,BedrockConverseModel,GoogleAIGenerateModel}";
const LLMFY_METHODS =
  "{invoke,invoke_with_tools,invoke_stream,chat,chat_with_tools,chat_stream,ainvoke,ainvoke_with_tools,ainvoke_stream,achat,achat_with_tools,achat_stream}";
const RUN_METHODS = `{${AGENT_METHODS.join(",")}}`;
const FASTMCP = ["mcp.server.fastmcp.FastMCP()", "fastmcp.FastMCP()"];
const HTTP_METHODS = "{get,post,put,patch,delete,head,options}";

const members = (base: string[], suffixes: string[]) =>
  base.flatMap((prefix) => suffixes.map((suffix) => `${prefix}.${suffix}`));

export const PYTHON_RULES: Rule[] = [
  // OpenAI SDK
  {
    kind: "model",
    framework: "openai",
    calls: [OPENAI_CLIENTS],
    baseUrl: "base_url|azure_endpoint",
    apiKey: "api_key",
  },
  {
    kind: "llm_call",
    framework: "openai",
    calls: [
      `${OPENAI_CLIENTS}().chat.completions.{create,parse,stream}`,
      `${OPENAI_CLIENTS}().beta.chat.completions.{create,parse,stream}`,
      `${OPENAI_CLIENTS}().completions.create`,
      "openai.ChatCompletion.create",
    ],
    model: "model",
    system: ["messages[role=system].content", "messages[role=developer].content"],
    user: ["messages[role=user].content", "prompt", "messages"],
    tools: "tools",
  },
  {
    kind: "llm_call",
    framework: "openai",
    calls: [`${OPENAI_CLIENTS}().responses.{create,parse,stream}`],
    model: "model",
    system: ["instructions", "input[role=system].content", "input[role=developer].content"],
    user: ["input", "input[role=user].content"],
    tools: "tools",
  },

  // Anthropic SDK
  {
    kind: "model",
    framework: "anthropic",
    calls: [ANTHROPIC_CLIENTS],
    baseUrl: "base_url",
    apiKey: "api_key",
  },
  {
    kind: "llm_call",
    framework: "anthropic",
    calls: [
      `${ANTHROPIC_CLIENTS}().messages.{create,stream}`,
      `${ANTHROPIC_CLIENTS}().beta.messages.{create,stream}`,
    ],
    model: "model",
    system: ["system", "system[*].text"],
    user: ["messages[role=user].content", "messages[role=user].content[*].text", "messages"],
    tools: "tools",
  },

  // LangChain
  {
    kind: "model",
    framework: "langchain",
    calls: CHAT_MODELS,
    model: "model|model_name|#0",
    baseUrl: "base_url|openai_api_base|azure_endpoint",
    apiKey: "api_key|openai_api_key|anthropic_api_key|google_api_key",
  },
  {
    kind: "llm_call",
    framework: "langchain",
    calls: CHAT_MODELS.map((model) => `${model}()**.${RUN_METHODS}`),
    system: ["#0[role=system].content", "#0[0=system].1"],
    user: ["#0", "#0[role=user].content", "#0[0=user].1", "#0[0=human].1"],
  },
  {
    kind: "tool_binding",
    framework: "langchain",
    calls: CHAT_MODELS.map((model) => `${model}()**.bind_tools`),
    tools: "#0|tools",
  },
  {
    kind: "tool_decorator",
    framework: "langchain",
    decorators: [
      "langchain_core.tools.tool",
      "langchain_core.tools.tool()",
      "langchain.tools.tool",
      "langchain.tools.tool()",
      "langchain.agents.tool",
      "langchain.agents.tool()",
    ],
    name: "#0",
    description: "description",
  },
  {
    kind: "tool_class",
    framework: "langchain",
    bases: [
      "langchain_core.tools.BaseTool",
      "langchain.tools.BaseTool",
      "langchain_core.tools.base.BaseTool",
    ],
    methods: ["_run", "_arun"],
  },
  {
    kind: "tool_factory",
    framework: "langchain",
    calls: [
      "langchain_core.tools.{StructuredTool,Tool}.from_function",
      "langchain.tools.{StructuredTool,Tool}.from_function",
      "langchain_core.tools.Tool",
      "langchain.tools.Tool",
      "langchain.agents.Tool",
    ],
    handler: "func|#0",
    name: "name",
    description: "description",
  },
  {
    kind: "prompt",
    framework: "langchain",
    calls: ["langchain_core.messages.SystemMessage", "langchain.schema.SystemMessage"],
    text: "content|#0",
    role: "system",
  },
  {
    kind: "prompt",
    framework: "langchain",
    calls: [
      "langchain_core.prompts.ChatPromptTemplate.from_messages",
      "langchain.prompts.ChatPromptTemplate.from_messages",
    ],
    text: "#0[0=system].1",
    role: "system",
    braces: true,
  },
  {
    kind: "prompt",
    framework: "langchain",
    calls: [
      "langchain_core.prompts.{PromptTemplate,ChatPromptTemplate}.from_template",
      "langchain.prompts.{PromptTemplate,ChatPromptTemplate}.from_template",
      "langchain_core.prompts.PromptTemplate",
    ],
    text: "template|#0",
    role: "template",
    braces: true,
  },
  {
    kind: "data_store",
    framework: "langchain",
    calls: [
      "langchain_community.vectorstores.*",
      "langchain_community.vectorstores.*.{from_documents,from_texts}",
      "langchain_{chroma,pinecone,qdrant,postgres,milvus,weaviate,mongodb,elasticsearch}.*",
      "langchain_{chroma,pinecone,qdrant,postgres,milvus,weaviate,mongodb,elasticsearch}.*.{from_documents,from_texts}",
    ],
    store: "vector_store",
  },
  {
    kind: "data_store",
    framework: "langchain",
    calls: ["langchain_*.*Embeddings", "langchain_community.embeddings.*"],
    store: "embeddings",
  },
  { kind: "data_store", framework: "langchain", calls: ["**.as_retriever"], store: "retriever" },

  // LangGraph
  {
    kind: "agent",
    framework: "langgraph",
    calls: ["langgraph.prebuilt.create_react_agent"],
    name: "name",
    model: "model|#0",
    system: ["prompt", "state_modifier", "messages_modifier"],
    tools: "tools|#1",
    invoke: [`langgraph.prebuilt.create_react_agent()**.${RUN_METHODS}`],
    invokeMethods: AGENT_METHODS,
  },
  {
    kind: "agent",
    framework: "langchain",
    calls: ["langchain.agents.create_agent"],
    name: "name",
    model: "model|#0",
    system: ["system_prompt", "prompt"],
    tools: "tools|#1",
    invoke: [`langchain.agents.create_agent()**.${RUN_METHODS}`],
    invokeMethods: AGENT_METHODS,
  },
  {
    kind: "agent",
    framework: "langchain",
    calls: ["langchain.agents.AgentExecutor", "langchain.agents.initialize_agent"],
    model: "llm|#1",
    tools: "tools|#0",
    invoke: [
      `langchain.agents.{AgentExecutor,initialize_agent}()**.{${AGENT_METHODS.join(",")},run}`,
    ],
    invokeMethods: [...AGENT_METHODS, "run"],
  },
  {
    kind: "agent",
    framework: "langgraph",
    calls: [
      "langgraph.graph.StateGraph",
      "langgraph.graph.state.StateGraph",
      "langgraph.graph.MessageGraph",
    ],
    invoke: [`langgraph.graph{,.state}.{StateGraph,MessageGraph}().compile()**.${RUN_METHODS}`],
    invokeMethods: AGENT_METHODS,
  },
  {
    kind: "graph_node",
    framework: "langgraph",
    calls: ["langgraph.graph{,.state}.{StateGraph,MessageGraph}().add_node"],
    name: "#0",
    handler: "#1",
  },
  {
    kind: "tool_binding",
    framework: "langgraph",
    calls: ["langgraph.prebuilt.ToolNode", "langgraph.prebuilt.tool_node.ToolNode"],
    tools: "#0|tools",
  },
  {
    kind: "data_store",
    framework: "langgraph",
    calls: [
      "langgraph.checkpoint.**Saver",
      "langgraph.checkpoint.**Saver.from_conn_string",
      "langgraph.store.**Store",
    ],
    store: "checkpointer",
  },

  // MCP
  {
    kind: "mcp_server",
    framework: "mcp",
    calls: [
      "mcp.server.fastmcp.FastMCP",
      "fastmcp.FastMCP",
      "mcp.server.Server",
      "mcp.server.lowlevel.Server",
    ],
    name: "name|#0",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "tool",
    decorators: members(FASTMCP, ["tool", "tool()"]),
    name: "name|#0",
    description: "description",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "tool",
    calls: members(FASTMCP, ["add_tool"]),
    handler: "fn|#0",
    name: "name",
    description: "description",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "tool",
    calls: ["mcp.types.Tool", "mcp.Tool"],
    name: "name",
    description: "description",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "resource",
    decorators: members(FASTMCP, ["resource()"]),
    name: "uri|#0",
  },
  {
    kind: "mcp_member",
    framework: "mcp",
    member: "prompt",
    decorators: members(FASTMCP, ["prompt", "prompt()"]),
    name: "name|#0",
  },
  {
    kind: "mcp_transport",
    framework: "mcp",
    calls: members(FASTMCP, ["run", "run_async"]),
    transport: "transport|#0",
    fixed: "stdio",
  },
  {
    kind: "mcp_transport",
    framework: "mcp",
    calls: members(FASTMCP, ["run_stdio_async"]),
    fixed: "stdio",
  },
  {
    kind: "mcp_transport",
    framework: "mcp",
    calls: members(FASTMCP, ["sse_app", "run_sse_async"]),
    fixed: "sse",
  },
  {
    kind: "mcp_transport",
    framework: "mcp",
    calls: members(FASTMCP, ["streamable_http_app", "http_app", "run_streamable_http_async"]),
    fixed: "streamable-http",
  },
  {
    kind: "mcp_transport",
    framework: "mcp",
    calls: ["mcp.server.stdio.stdio_server"],
    fixed: "stdio",
  },
  {
    kind: "mcp_client",
    framework: "mcp",
    calls: ["mcp.StdioServerParameters", "mcp.client.stdio.StdioServerParameters"],
    command: "command|#0",
    args: "args",
  },
  {
    kind: "mcp_client",
    framework: "mcp",
    calls: [
      "mcp.client.streamable_http.streamablehttp_client",
      "mcp.client.sse.sse_client",
      "fastmcp.Client",
    ],
    url: "url|#0",
  },
  {
    kind: "mcp_client",
    framework: "mcp",
    calls: ["langchain_mcp_adapters.client.MultiServerMCPClient"],
    servers: "connections|#0",
  },

  // llmfy
  {
    kind: "model",
    framework: "llmfy",
    calls: [`llmfy.${LLMFY_MODELS}`, `llmfy.**.${LLMFY_MODELS}`],
    model: "model|#0",
    baseUrl: "base_url",
    apiKey: "api_key",
  },
  {
    kind: "agent",
    framework: "llmfy",
    calls: ["llmfy.LLMfy", "llmfy.**.LLMfy"],
    model: "llm|#0",
    system: ["system_message"],
    variables: "input_variables",
    invokeMethods: LLMFY_METHODS.slice(1, -1).split(","),
  },
  {
    kind: "llm_call",
    framework: "llmfy",
    calls: [`llmfy.LLMfy().${LLMFY_METHODS}`, `llmfy.**.LLMfy().${LLMFY_METHODS}`],
    user: ["#0", "content", "messages"],
    keywordInputs: true,
  },
  {
    kind: "tool_binding",
    framework: "llmfy",
    calls: ["llmfy.LLMfy().register_tool", "llmfy.**.LLMfy().register_tool", "llmfy.ToolRegistry"],
    tools: "#0|tools",
  },
  {
    kind: "tool_decorator",
    framework: "llmfy",
    decorators: ["llmfy.Tool()", "llmfy.**.Tool()"],
  },
  {
    kind: "agent",
    framework: "llmfy",
    calls: ["llmfy.FlowEngine", "llmfy.**.FlowEngine"],
    invoke: ["llmfy{,.**}.FlowEngine().build().{invoke,stream,ainvoke,astream}"],
    invokeMethods: ["invoke", "stream"],
  },
  {
    kind: "graph_node",
    framework: "llmfy",
    calls: ["llmfy.FlowEngine().add_node", "llmfy.**.FlowEngine().add_node"],
    name: "#0",
    handler: "#1",
  },
  {
    kind: "data_store",
    framework: "llmfy",
    calls: ["llmfy{,.**}.{InMemoryCheckpointer,RedisCheckpointer,SQLCheckpointer}"],
    store: "checkpointer",
  },
  {
    kind: "data_store",
    framework: "llmfy",
    calls: ["llmfy{,.**}.{BedrockEmbedding,GoogleAIEmbedding,OpenAIEmbedding}"],
    store: "embeddings",
  },

  // Vector databases used directly
  {
    kind: "data_store",
    framework: "vector-db",
    calls: [
      "chromadb.{Client,PersistentClient,HttpClient,EphemeralClient,AsyncHttpClient}",
      "pinecone.Pinecone",
      "qdrant_client.{QdrantClient,AsyncQdrantClient}",
      "weaviate.connect_to_*",
      "faiss.Index*",
    ],
    store: "vector_store",
  },

  // Web entry points
  {
    kind: "route",
    framework: "fastapi",
    decorators: [
      `fastapi.{FastAPI,APIRouter}().{${HTTP_METHODS.slice(1, -1)},api_route,websocket}()`,
    ],
    path: "path|#0",
    methods: "methods",
  },
  {
    kind: "route",
    framework: "fastapi",
    calls: ["fastapi.{FastAPI,APIRouter}().{add_api_route,add_api_websocket_route}"],
    path: "path|#0",
    handler: "endpoint|#1",
    methods: "methods",
  },
  {
    kind: "route",
    framework: "flask",
    decorators: [`flask.{Flask,Blueprint}().{route,${HTTP_METHODS.slice(1, -1)}}()`],
    path: "rule|#0",
    methods: "methods",
  },
  {
    kind: "route",
    framework: "flask",
    calls: ["flask.{Flask,Blueprint}().add_url_rule"],
    path: "rule|#0",
    handler: "view_func|#2",
    methods: "methods",
  },
  {
    kind: "route",
    framework: "django",
    calls: ["django.urls.{path,re_path}"],
    path: "route|#0",
    handler: "view|#1",
  },
];
