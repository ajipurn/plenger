import type { DataStore, Prompt } from "./model.ts";

/**
 * Detector rules. `calls`, `decorators` and `bases` are patterns over canonical
 * names (see facts/pattern.ts); field values are argument paths (see `select` in facts/query.ts).
 * Rules are data so that supporting a framework means adding entries, not code.
 */
export type DetectorRule =
  | AgentRunRule
  | ToolBuiltinRule
  | PromptDecoratorRule
  | ModelRule
  | LlmCallRule
  | AgentRule
  | ToolDecoratorRule
  | ToolClassRule
  | ToolFactoryRule
  | ToolBindingRule
  | GraphNodeRule
  | McpServerRule
  | McpMemberRule
  | McpTransportRule
  | McpClientRule
  | RouteRule
  | DataStoreRule
  | PromptRule;

interface RuleBase {
  /** Framework id from frameworks.ts. */
  framework: string;
  /** Match only when the argument at `path` is one of these strings (`boto3.client("bedrock-runtime")`). */
  where?: { path: string; equals: string[] };
}

/** Constructs a model client or model object. */
export interface ModelRule extends RuleBase {
  kind: "model";
  calls: string[];
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Sends a request to a model. */
export interface LlmCallRule extends RuleBase {
  kind: "llm_call";
  calls: string[];
  model?: string;
  system?: string[];
  user?: string[];
  tools?: string;
  /** Keyword arguments are template variables filled into the instance's prompt (llmfy `invoke`). */
  keywordInputs?: boolean;
}

/** Constructs an agent, a graph or a tool-using LLM wrapper. */
export interface AgentRule extends RuleBase {
  kind: "agent";
  calls: string[];
  name?: string;
  model?: string;
  system?: string[];
  tools?: string;
  /** Template variables declared up front (llmfy `input_variables`). */
  variables?: string;
  /** `{name}` placeholders in the system prompt are template variables (CrewAI `goal`). */
  braces?: boolean;
  /** Calls that run the agent; matched by name, and by method on the same instance. */
  invoke?: string[];
  invokeMethods?: string[];
  /** Input of a run call (paths into the run call's arguments). */
  input?: string[];
  /** Agents this agent hands off to or coordinates. */
  delegates?: string;
  /** MCP clients (or toolsets) the agent uses. */
  mcp?: string;
}

/** A call that runs an agent passed as an argument (`Runner.run(agent, input)`). */
export interface AgentRunRule extends RuleBase {
  kind: "agent_run";
  calls: string[];
  agent: string;
  input?: string[];
}

/** A tool the framework provides, constructed by a call (`WebSearchTool()`). */
export interface ToolBuiltinRule extends RuleBase {
  kind: "tool_builtin";
  calls: string[];
  name?: string;
}

/** A function whose return value becomes an agent's system prompt (`@agent.system_prompt`). */
interface PromptDecoratorRule extends RuleBase {
  kind: "prompt_decorator";
  decorators: string[];
}

export interface ToolDecoratorRule extends RuleBase {
  kind: "tool_decorator";
  decorators: string[];
  /** Paths into the decorator's arguments. */
  name?: string;
  description?: string;
}

export interface ToolClassRule extends RuleBase {
  kind: "tool_class";
  bases: string[];
  /** Methods that run the tool. */
  methods: string[];
}

export interface ToolFactoryRule extends RuleBase {
  kind: "tool_factory";
  calls: string[];
  handler: string;
  name?: string;
  description?: string;
}

/** Attaches tools to the instance the call is made on (`bind_tools`, `register_tool`). */
export interface ToolBindingRule extends RuleBase {
  kind: "tool_binding";
  calls: string[];
  tools: string;
}

/** Adds a node to an agent graph. */
export interface GraphNodeRule extends RuleBase {
  kind: "graph_node";
  calls: string[];
  name: string;
  handler: string;
}

interface McpServerRule extends RuleBase {
  kind: "mcp_server";
  calls: string[];
  name?: string;
}

/** Registers a tool, resource or prompt on an MCP server, by decorator or call. */
export interface McpMemberRule extends RuleBase {
  kind: "mcp_member";
  member: "tool" | "resource" | "prompt";
  decorators?: string[];
  calls?: string[];
  name?: string;
  description?: string;
  handler?: string;
}

/** Starts an MCP server on a transport. */
export interface McpTransportRule extends RuleBase {
  kind: "mcp_transport";
  calls: string[];
  /** Path to the transport argument; a string, or a call to a transport class. */
  transport?: string;
  /** Transport when the call fixes it, or when `transport` is absent. */
  fixed: string;
}

export interface McpClientRule extends RuleBase {
  kind: "mcp_client";
  calls: string[];
  command?: string;
  args?: string;
  url?: string;
  /** For clients configured with several servers: the server configs, each with `command`, `args` or `url`. */
  servers?: string;
}

/** An HTTP route, by decorator or registration call; the method is the last name segment. */
export interface RouteRule extends RuleBase {
  kind: "route";
  decorators?: string[];
  calls?: string[];
  path: string;
  handler?: string;
  /** Path to an explicit list of methods (`methods=["POST"]`). */
  methods?: string;
  /** A class decorator whose first argument prefixes the paths of its methods (NestJS `@Controller("users")`). */
  prefix?: string;
}

interface DataStoreRule extends RuleBase {
  kind: "data_store";
  calls: string[];
  store: DataStore["kind"];
}

/** A call that builds a prompt (`SystemMessage(...)`, `ChatPromptTemplate.from_messages`). */
interface PromptRule extends RuleBase {
  kind: "prompt";
  calls: string[];
  text: string;
  role: Prompt["role"];
  /** `{name}` placeholders are template variables (LangChain prompt templates). */
  braces?: boolean;
}

export const AGENT_METHODS = ["invoke", "ainvoke", "stream", "astream", "batch", "abatch"];
