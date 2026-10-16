/**
 * The agent inventory: what an agentic project is made of, built from code facts.
 * Every item cites the code it came from. Items are static observations; they say
 * nothing about whether the code runs.
 */

import type { Credential, DynamicPart } from "../facts/query.ts";

export type { Credential, DynamicPart };

export interface Location {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** What code can do outside the program. */
export type CapabilityKind =
  /** Runs operating system commands. */
  | "process"
  /** Evaluates code: `eval`, code-executing agents and interpreters. */
  | "code"
  | "file_read"
  | "file_write"
  | "file_delete"
  /** Outbound HTTP, sockets and web search. */
  | "network"
  | "database"
  /** Email, chat and SMS. */
  | "message"
  | "payment"
  /** Reads environment variables or a secret store. */
  | "secret"
  /** Loads data that can execute code (pickle, unsafe YAML). */
  | "deserialize"
  | "browser"
  /** Calls a model. */
  | "llm"
  /** Runs an agent. */
  | "agent"
  /** Uses the tools of an MCP server whose code plenger cannot see. */
  | "mcp";

export interface Capability {
  kind: CapabilityKind;
  /** The call with the effect, by canonical name; for `agent`, the agent id. */
  target: string;
  location: Location;
  /** Call sites from the analysed function down to the effect; empty when the effect is in the function itself. */
  via: Location[];
  /** Non-constant parts of the effect's main argument (command, path, URL, query, code, recipient). */
  inputs: DynamicPart[];
  /** The effect runs at the model provider, not in this code (hosted web search, code interpreter). */
  hosted?: true;
  /** For an agent's capabilities: the tool that provides it; absent when it is the agent's own. */
  tool?: string;
  /**
   * For `process`: how the input reaches the command. `shell`: a shell runs it, so
   * input can add commands; `program`: input can name the program; `arguments`: input
   * reaches only the arguments of a fixed program.
   */
  command?: "shell" | "program" | "arguments";
  /** For `database`: the input is a query (SQL), not data. */
  query?: true;
  /** The SQL statement's effect, when a literal query can be classified. */
  operation?: "read" | "write" | "unknown";
  /** Values bound to a prepared SQL statement, separate from the query text. */
  dataInputs?: DynamicPart[];
  /**
   * For `network` and `browser`: the inputs that decide the URL's scheme and host (all
   * of them when the whole URL is one value); absent when the host is fixed.
   */
  host?: DynamicPart[];
  /** For `code`: where model-written code runs, when plenger can tell. */
  sandbox?: "none" | "container" | "remote";
  /** For `llm`: non-constant parts of the system prompt, template variables filled by the call included. */
  systemInputs?: DynamicPart[];
  /** Checks of the input seen on the way to the effect (`os.path.realpath`, `shlex.quote`). */
  guards?: string[];
}

export interface Prompt {
  id: string;
  location: Location;
  role: "system" | "user" | "template";
  /** Fixed text with dynamic parts shown as `{expression}`, and secrets as `<redacted>`. */
  text: string;
  /** The kind of secret the prompt contains (`OpenAI API key`, `credential`), which the text hides. */
  secret?: string;
  truncated?: true;
  dynamic: DynamicPart[];
  /** Template variables filled later (`{{info}}` in llmfy, `{question}` in LangChain templates). */
  variables: string[];
  /** Ids of the LLM calls and agents that use this prompt. */
  usedBy: string[];
}

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
  /** Non-constant parts of the system prompt, template variables filled by the call included. */
  systemInputs: DynamicPart[];
  /** Effects whose input is the call's output: model output used as a command, code, query, path or URL. */
  outputEffects: Capability[];
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
  nodes: { name: string; handler: string | null; handlerPath?: string }[];
  /** Ids of agents this one hands off to or coordinates (handoffs, crew and team members). */
  delegates: string[];
  /** Ids of the MCP clients whose tools the agent can call. */
  mcpClients: string[];
  /** Calls that run the agent, with the non-constant parts of their input. */
  invocations: Invocation[];
  /** What the agent can do: its tools' capabilities, code execution and MCP servers. */
  capabilities: Capability[];
  /** Effects whose input is the output of a run of the agent. */
  outputEffects: Capability[];
  /** A human approval step plenger saw for the whole agent (`interrupt_before`, `HumanInTheLoopMiddleware`). */
  approval?: string;
}

interface Invocation {
  location: Location;
  inputs: DynamicPart[];
}

export interface Tool {
  id: string;
  framework: string;
  location: Location;
  name: string;
  description: string | null;
  /** Definition id of the function that runs the tool. */
  handler: string | null;
  /** The file the handler is in, when it is not the tool's own file. */
  handlerPath?: string;
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
  /** What the tool can do, found by following its handler through the project. */
  capabilities: Capability[];
  /** Calls the handler's trace could not follow, so `capabilities` may be incomplete. */
  trace?: TraceGaps;
  /** A human approval step plenger saw for the tool: the option that requires it (`needs_approval`) or the call that asks (`input`). */
  approval?: string;
  /** Id of the MCP server the tool belongs to. */
  server: string | null;
}

/** Calls a handler's trace could not follow; present only when there are some. */
export interface TraceGaps {
  /** Calls into project functions past the call depth limit. */
  depthLimited: number;
  /** Calls whose target is chosen at run time: a parameter, a subscript or a call's result. */
  dynamic: number;
  /** Up to ten of those calls, depth-limited ones first. */
  locations: Location[];
}

export interface McpServer {
  id: string;
  framework: string;
  location: Location;
  name: string | null;
  /** `stdio`, `streamable-http`, `sse`, or null when plenger saw no transport. */
  transport: string | null;
  tools: string[];
  resources: McpMember[];
  prompts: McpMember[];
}

interface McpMember {
  name: string;
  handler: string | null;
  handlerPath?: string;
  location: Location;
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
  kind: "vector_store" | "embeddings" | "retriever" | "checkpointer" | "memory" | "database";
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
  /** Definition id of the handler. */
  handler: string | null;
  /** The file the handler is in, when it is not the entry point's own file. */
  handlerPath?: string;
  /** What the handler reaches: models, agents and effects, through project functions. */
  reaches: Capability[];
  /** Calls the handler's trace could not follow, so `reaches` may be incomplete. */
  trace?: TraceGaps;
}

interface FrameworkUse {
  id: string;
  name: string;
  files: string[];
}

/** An AI library the project imports whose usage plenger does not understand. */
interface Unrecognised {
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
