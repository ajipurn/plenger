import { sinkOf } from "../../capabilities/catalog.ts";
import type {
  Agent,
  Capability,
  DynamicPart,
  EntryPoint,
  LlmCall,
  Prompt,
} from "../../inventory/model.ts";
import { locationKey } from "../../shared/location.ts";
import { callLabel, routeLabel } from "../../shared/text.ts";
import type { Language } from "../../source/languages.ts";
import { actionKinds, type RuleContext } from "../context.ts";
import type { Draft, Evidence } from "../model.ts";
import { ACTION_PHRASE, code, inputList, listed } from "../text.ts";

const MAX_ACTION_EVIDENCE = 5;
const RETRIEVAL =
  /\.(?:similarity_search\w*|max_marginal_relevance_search|a?get_relevant_documents|retrieve|aretrieve|as_retriever\(\)\.a?invoke|asRetriever\(\)\.invoke|similaritySearch\w*)$/;

/** PLG301–PLG303: outside text that reaches agents and system prompts. */
export function promptChecks(cx: RuleContext): Draft[] {
  const covered = new Set<string>();
  const drafts = [...requestsToAgents(cx), ...requestsToSystemPrompts(cx, covered)];
  drafts.push(...systemPromptInputs(cx, covered));
  return drafts;
}

/** PLG301: request input passed to an agent or model call with high-impact tools. */
function requestsToAgents(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const entry of cx.inventory.entryPoints) {
    const seen = new Set<string>();
    for (const capability of entry.reaches) {
      if (capability.kind !== "agent" && capability.kind !== "llm") continue;
      const agent = capability.kind === "agent" ? cx.agents.get(capability.target) : undefined;
      const call =
        capability.kind === "llm" ? cx.llmCalls.get(locationKey(capability.location)) : undefined;
      if (agent === undefined && call === undefined) continue;
      const target = agent?.id ?? call?.client ?? call?.id ?? "";
      if (seen.has(target)) continue;
      const actions = (
        agent === undefined ? cx.callActions(call as LlmCall) : cx.agentActions(agent)
      ).filter((action) => !cx.approved(action, agent));
      const inputs = capability.inputs;
      if (actions.length === 0 || inputs.length === 0) continue;
      seen.add(target);
      drafts.push(requestToAgent(cx, entry, capability, actions, { agent, call }));
    }
  }
  return drafts;
}

function requestToAgent(
  cx: RuleContext,
  entry: EntryPoint,
  capability: Capability,
  actions: Capability[],
  target: { agent: Agent | undefined; call: LlmCall | undefined },
): Draft {
  const route = routeLabel(entry);
  const request = cx.requestInputs(capability.inputs);
  const name =
    target.agent !== undefined
      ? `agent ${code(cx.agentName(target.agent))}`
      : `model call ${code(callLabel(target.call?.target ?? ""))}`;
  const kinds = actionKinds(actions);
  const injectable = actions.some(
    (action) =>
      (action.kind === "process" || action.kind === "code") &&
      (action.inputs.some((part) => part.from !== undefined) || action.via.length === 0),
  );
  const evidence: Evidence[] = [
    { location: entry.location, message: `route ${code(route)}` },
    ...cx.via(capability.via),
    {
      location: capability.location,
      message: `passes ${inputList(request.length > 0 ? request : capability.inputs)} to ${name}`,
    },
  ];
  const seen = new Set<string>();
  for (const action of actions) {
    const tool = action.tool === undefined ? undefined : cx.tools.get(action.tool);
    const id = `${tool?.id ?? action.node ?? action.target}|${action.kind}`;
    if (seen.has(id) || seen.size >= MAX_ACTION_EVIDENCE) continue;
    seen.add(id);
    const actor =
      tool !== undefined
        ? `tool ${code(tool.name)}`
        : action.node !== undefined
          ? `graph node ${code(action.node)}`
          : "the agent";
    evidence.push({
      location: tool?.location ?? action.location,
      message: `${actor} can ${ACTION_PHRASE[action.kind]}`,
    });
  }
  const notes =
    request.length > 0
      ? [`Request input traced: ${inputList(request)}.`]
      : ["The input could not be traced to the request; check where it comes from."];
  return {
    rule: "PLG301",
    title: `${code(route)} passes request input to ${name}, which can ${listed(kinds.map((kind) => ACTION_PHRASE[kind]))}`,
    severity: injectable ? "critical" : "high",
    confidence: request.length > 0 ? "high" : "medium",
    location: capability.location,
    subject: { kind: "entry_point", name: route, id: entry.id },
    evidence,
    notes,
    exposed: true,
    key: [
      route,
      target.agent !== undefined
        ? cx.agentName(target.agent)
        : callLabel(target.call?.target ?? ""),
    ],
  };
}

/** PLG302 (traced): request input that ends up in a system prompt. */
function requestsToSystemPrompts(cx: RuleContext, covered: Set<string>): Draft[] {
  const drafts: Draft[] = [];
  for (const entry of cx.inventory.entryPoints) {
    for (const capability of entry.reaches) {
      if (capability.kind !== "llm") continue;
      const request = cx.requestInputs(capability.systemInputs);
      const call = cx.llmCalls.get(locationKey(capability.location));
      if (request.length === 0 || call === undefined) continue;
      covered.add(call.id);
      const route = routeLabel(entry);
      const label = callLabel(call.target);
      const prompt = systemPrompts(cx, call)[0];
      drafts.push({
        rule: "PLG302",
        title: `${code(route)} puts request input into the system prompt of ${code(label)}`,
        severity: "high",
        confidence: "high",
        location: prompt?.location ?? call.location,
        subject: { kind: "llm_call", name: label, id: call.id },
        evidence: [
          { location: entry.location, message: `route ${code(route)}` },
          ...cx.via(capability.via),
          {
            location: call.location,
            message: `model call fills the system prompt with ${inputList(request)}`,
          },
          ...(prompt === undefined
            ? []
            : [{ location: prompt.location, message: `system prompt ${code(prompt.text)}` }]),
        ],
        notes: [`Request input traced: ${inputList(request)}.`],
        exposed: true,
        key: [route, label],
      });
    }
  }
  return drafts;
}

/**
 * PLG302 (untraced) and PLG303: system prompts partly built from function arguments,
 * framework request objects, retrieved documents or fetched pages.
 */
function systemPromptInputs(cx: RuleContext, covered: Set<string>): Draft[] {
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  const check = (
    prompt: Prompt,
    parts: DynamicPart[],
    subject: Draft["subject"],
    language: Language,
    site: Evidence | null,
  ) => {
    // A system prompt that is a parameter as a whole is a wrapper's argument, not a template.
    const whole = /^\{[^{}]*\}$/.test(prompt.text.trim());
    for (const part of parts) {
      const source = untrustedSource(cx, part, language);
      if (source === null || (source === "parameter" && whole)) continue;
      const id = `${prompt.id}|${source}`;
      if (seen.has(id)) continue;
      seen.add(id);
      drafts.push(promptDraft(cx, prompt, part, source, subject, site));
    }
  };
  for (const call of cx.inventory.llmCalls) {
    if (covered.has(call.id)) continue;
    const language = cx.project.files.get(call.location.path)?.language ?? "python";
    const label = callLabel(call.target);
    const [prompt] = systemPrompts(cx, call);
    if (prompt === undefined) continue;
    check(prompt, call.systemInputs, { kind: "llm_call", name: label, id: call.id }, language, {
      location: call.location,
      message: `model call ${code(label)} fills the system prompt`,
    });
  }
  for (const agent of cx.inventory.agents) {
    const language = cx.project.files.get(agent.location.path)?.language ?? "python";
    const name = cx.agentName(agent);
    for (const id of agent.prompts) {
      const prompt = cx.inventory.prompts.find((candidate) => candidate.id === id);
      if (prompt?.role !== "system") continue;
      // Calls made through the agent already reported this prompt's parts.
      if (prompt.usedBy.some((user) => covered.has(user))) continue;
      check(prompt, prompt.dynamic, { kind: "agent", name, id: agent.id }, language, null);
    }
  }
  return drafts;
}

type Source = "request" | "parameter" | "retrieval" | "web";

/** Where a system prompt part comes from, when that is outside the application's control. */
function untrustedSource(cx: RuleContext, part: DynamicPart, language: Language): Source | null {
  for (const name of part.calls ?? []) {
    if (
      RETRIEVAL.test(name) ||
      cx.inventory.dataStores.some((store) => name.startsWith(`${store.target}()`))
    )
      return "retrieval";
    const sink = sinkOf(name, language);
    if (sink?.kind === "network" || sink?.kind === "browser") return "web";
  }
  if (part.from?.some((name) => name.includes("."))) return "request";
  if (part.from !== undefined && part.from.length > 0) return "parameter";
  return null;
}

function promptDraft(
  cx: RuleContext,
  prompt: Prompt,
  part: DynamicPart,
  source: Source,
  subject: Draft["subject"],
  site: Evidence | null,
): Draft {
  const owner = `${subject.kind === "agent" ? "agent" : "model call"} ${code(subject.name)}`;
  const value = code(part.text);
  const evidence: Evidence[] = [
    { location: prompt.location, message: `system prompt ${code(prompt.text)}` },
    ...(site === null ? [] : [site]),
  ];
  // Untraced parameters say nothing about the routes that reach the call; traced ones are reported by route.
  const exposed = source !== "parameter" && subject.id !== undefined && cx.exposure.has(subject.id);
  const base = {
    location: prompt.location,
    subject,
    evidence,
    exposed,
    key: [subject.name, part.text, source],
  };
  switch (source) {
    case "retrieval":
    case "web":
      return {
        ...base,
        rule: "PLG303",
        title:
          source === "retrieval"
            ? `Retrieved documents are placed in the system prompt of ${owner}`
            : `Fetched web content is placed in the system prompt of ${owner}`,
        severity: "medium",
        confidence: "medium",
        notes: [`${value} comes from ${listed((part.calls ?? []).slice(0, 2).map(code))}.`],
      };
    case "request":
      return {
        ...base,
        rule: "PLG302",
        title: `Request data is placed in the system prompt of ${owner}`,
        severity: "high",
        confidence: "high",
        notes: [
          `${value} is read from ${listed((part.from ?? []).filter((name) => name.includes(".")).map(code))}.`,
        ],
      };
    default: {
      const params = (part.from ?? []).map(code);
      return {
        ...base,
        rule: "PLG302",
        title: `System prompt of ${owner} is filled from ${params.length === 1 ? "parameter" : "parameters"} ${listed(params)}`,
        severity: "low",
        confidence: "medium",
        notes: [
          "plenger did not trace who calls this function; if the value can come from a user or a document, the rating is higher.",
        ],
      };
    }
  }
}

function systemPrompts(cx: RuleContext, call: LlmCall): Prompt[] {
  return call.prompts
    .map((id) => cx.inventory.prompts.find((prompt) => prompt.id === id))
    .filter((prompt): prompt is Prompt => prompt?.role === "system");
}
