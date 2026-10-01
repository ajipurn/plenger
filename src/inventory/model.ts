/**
 * The agent inventory: what an agentic project is made of, built from code facts.
 * Every item cites the code it came from. Items are static observations; they say
 * nothing about whether the code runs.
 */

export interface Location {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** A part of a prompt or input that is not fixed text. */
export interface DynamicPart {
  /** The expression as written. */
  text: string;
  /** `param`: a parameter of the enclosing function, the usual way outside input arrives. */
  source: "param" | "name" | "call" | "other";
  /** Resolved target, when there is one (`ai#generateText().text`, `os.getenv`). */
  ref?: string;
}

export interface Prompt {
  id: string;
  location: Location;
  role: "system" | "user" | "template";
  /** Fixed text with dynamic parts shown as `{expression}`. */
  text: string;
  truncated?: true;
  dynamic: DynamicPart[];
  /** Template variables filled later (`{{info}}` in llmfy, `{question}` in LangChain templates). */
  variables: string[];
  /** Ids of the LLM calls and agents that use this prompt. */
  usedBy: string[];
}

export type Credential = "literal" | "environment" | "parameter" | "default" | "other";

export interface Model {
  id: string;
  framework: string;
  location: Location;
  /** The constructor or factory: `openai.OpenAI`, `@ai-sdk/openai#openai`. */
  target: string;
  model: string | null;
  baseUrl: string | null;
  /** Where the API key comes from. A literal key is reported, never stored. */
  credential: Credential;
}

export interface LlmCall {
  id: string;
  framework: string;
  location: Location;
  target: string;
  /** Definition id of the enclosing function. */
  scope: string | null;
  model: string | null;
  /** Id of the `Model` the call is made through, when plenger can tell. */
  client: string | null;
  prompts: string[];
  tools: string[];
  /** Entries in the call's tool list that plenger could not match to a tool. */
  unresolvedTools: number;
  /** Non-constant parts of the user message, prompt or input. */
  inputs: DynamicPart[];
}

export interface Agent {
  id: string;
  framework: string;
  location: Location;
  target: string;
  name: string | null;
  model: string | null;
  tools: string[];
  unresolvedTools: number;
  prompts: string[];
  /** Graph nodes and their handlers (LangGraph `add_node`, llmfy `FlowEngine.add_node`). */
  nodes: { name: string; handler: string | null }[];
  /** Ids of agents this one hands off to or coordinates (handoffs, crew and team members). */
  delegates: string[];
  /** Ids of the MCP clients whose tools the agent can call. */
  mcpClients: string[];
  /** Calls that run the agent, with the non-constant parts of their input. */
  invocations: Invocation[];
}

export interface Invocation {
  location: Location;
  inputs: DynamicPart[];
}

export interface Tool {
  id: string;
  framework: string;
  location: Location;
  name: string;
  description: string | null;
  /** Definition id of the function that runs the tool, in the same file. */
  handler: string | null;
  params: string[];
  /**
   * How the tool is declared. `function`: a plain function passed as a tool;
   * `builtin`: a tool the framework provides (web search, code interpreter);
   * `agent`: another agent exposed as a tool (`agent.as_tool()`);
   * `schema`: a JSON tool schema with no handler attached.
   */
  via: "decorator" | "class" | "factory" | "function" | "builtin" | "agent" | "mcp" | "schema";
  /** For `via: "agent"`: the agent the tool runs. */
  agent?: string;
  /** Id of the MCP server the tool belongs to. */
  server: string | null;
}

export interface McpServer {
  id: string;
  framework: string;
  location: Location;
  name: string | null;
  /** `stdio`, `streamable-http`, `sse`, or null when plenger saw no transport. */
  transport: string | null;
  tools: string[];
  resources: { name: string; handler: string | null; location: Location }[];
  prompts: { name: string; handler: string | null; location: Location }[];
}

export interface McpClient {
  id: string;
  framework: string;
  location: Location;
  target: string;
  /** Command line of a stdio server the client starts. */
  command: string | null;
  url: string | null;
}

export interface DataStore {
  id: string;
  framework: string;
  location: Location;
  kind: "vector_store" | "embeddings" | "retriever" | "checkpointer" | "memory";
  target: string;
}

export interface EntryPoint {
  id: string;
  framework: string;
  location: Location;
  kind: "http" | "mcp";
  /** HTTP method in upper case, `*` for all methods. */
  method: string | null;
  path: string | null;
  /** Definition id of the handler in the same file. */
  handler: string | null;
}

export interface FrameworkUse {
  id: string;
  name: string;
  files: string[];
}

/** An AI library the project imports whose usage plenger does not understand. */
export interface Unrecognised {
  module: string;
  files: string[];
}

export interface Inventory {
  frameworks: FrameworkUse[];
  models: Model[];
  llmCalls: LlmCall[];
  agents: Agent[];
  tools: Tool[];
  mcpServers: McpServer[];
  mcpClients: McpClient[];
  prompts: Prompt[];
  dataStores: DataStore[];
  entryPoints: EntryPoint[];
  unrecognised: Unrecognised[];
}

export function emptyInventory(): Inventory {
  return {
    frameworks: [],
    models: [],
    llmCalls: [],
    agents: [],
    tools: [],
    mcpServers: [],
    mcpClients: [],
    prompts: [],
    dataStores: [],
    entryPoints: [],
    unrecognised: [],
  };
}
