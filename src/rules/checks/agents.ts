import type { Argument, FileFacts } from "../../facts/model.ts";
import type { Capability, Location } from "../../inventory/model.ts";
import { deref, select } from "../../inventory/values.ts";
import {
  ACTION_PHRASE,
  actionKinds,
  callLabel,
  clientLabel,
  code,
  listed,
  type RuleContext,
} from "../context.ts";
import type { Draft, Evidence } from "../model.ts";

const SEVERE = new Set(["process", "code", "payment", "file_delete"]);
const MAX_ACTION_EVIDENCE = 6;

/** Options that cap how long an agent or team runs, by framework convention. */
const LIMIT_OPTIONS = [
  "max_iterations",
  "max_iter",
  "max_turns",
  "max_steps",
  "max_round",
  "max_rounds",
  "recursion_limit",
  "maxIterations",
  "maxTurns",
  "maxSteps",
  "recursionLimit",
  "config.recursion_limit",
  "config.recursionLimit",
];
/** AutoGen AgentChat teams, which run until a termination condition or `max_turns` stops them. */
const OPEN_ENDED_TEAM =
  /^autogen_agentchat\.teams\.(?:RoundRobinGroupChat|SelectorGroupChat|Swarm)$/;
const UNLIMITED =
  /^(?:None|null|undefined|Infinity|Number\.POSITIVE_INFINITY|math\.inf|float\(["']inf["']\)|sys\.maxsize)$/;
const UNLIMITED_COUNT = 1000;

/** PLG201–PLG203: what agents may do on their own. */
export function agentChecks(cx: RuleContext): Draft[] {
  return [...unapprovedActions(cx), ...localCodeExecution(cx), ...unboundedLoops(cx)];
}

/** PLG201: high-impact tools with no human approval, per agent and per tool-using model call. */
function unapprovedActions(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const agent of cx.inventory.agents) {
    if (agent.approval !== undefined) continue;
    const actions = agent.capabilities.filter(
      (capability) =>
        capability.tool !== undefined && cx.isAction(capability) && !cx.approved(capability),
    );
    if (actions.length === 0) continue;
    const name = cx.agentName(agent);
    drafts.push(
      unapproved(cx, actions, {
        subject: { kind: "agent", name, id: agent.id },
        label: `Agent ${code(name)}`,
        location: agent.location,
        created: `agent ${code(name)} with ${agent.tools.length === 1 ? "1 tool" : `${agent.tools.length} tools`}`,
        exposedBy: cx.exposure.get(agent.id),
        key: [name],
      }),
    );
  }
  for (const call of cx.inventory.llmCalls) {
    // A call made through an agent, or inside a graph whose agent lists the same tools, is covered by the agent's finding.
    if (call.client !== null && cx.agents.has(call.client)) continue;
    const covered = cx.inventory.agents.some(
      (agent) =>
        agent.location.path === call.location.path &&
        call.tools.length > 0 &&
        call.tools.every((id) => agent.tools.includes(id)),
    );
    if (covered) continue;
    const actions = call.tools.flatMap((id) =>
      (cx.tools.get(id)?.capabilities ?? [])
        .map((capability) => ({ ...capability, tool: id }))
        .filter((capability) => cx.isAction(capability) && !cx.approved(capability)),
    );
    if (actions.length === 0) continue;
    const label = callLabel(call.target);
    drafts.push(
      unapproved(cx, actions, {
        subject: { kind: "llm_call", name: label, id: call.id },
        label: `Model call ${code(label)}`,
        location: call.location,
        created: `model call ${code(label)} with tools`,
        exposedBy: cx.exposure.get(call.id),
        key: [label],
      }),
    );
  }
  return drafts;
}

function unapproved(
  cx: RuleContext,
  actions: Capability[],
  site: {
    subject: Draft["subject"];
    label: string;
    location: Location;
    created: string;
    exposedBy: string | undefined;
    key: string[];
  },
): Draft {
  const kinds = actionKinds(actions);
  const evidence: Evidence[] = [{ location: site.location, message: site.created }];
  const seen = new Set<string>();
  for (const capability of actions) {
    const tool = capability.tool === undefined ? undefined : cx.tools.get(capability.tool);
    const id = `${tool?.id}|${capability.kind}`;
    if (tool === undefined || seen.has(id) || evidence.length > MAX_ACTION_EVIDENCE) continue;
    seen.add(id);
    evidence.push({
      location: tool.location,
      message: `tool ${code(tool.name)} can ${ACTION_PHRASE[capability.kind]}`,
    });
  }
  const notes = [
    "No approval option (`needs_approval`, `interrupt_before`, `HumanInTheLoopMiddleware`, `needsApproval`) or prompt to a person was seen for these tools.",
  ];
  if (site.exposedBy !== undefined) notes.push(`Reachable from ${code(site.exposedBy)}.`);
  return {
    rule: "PLG201",
    title: `${site.label} can ${listed(kinds.map((kind) => ACTION_PHRASE[kind]))} with no human approval`,
    severity: kinds.some((kind) => SEVERE.has(kind)) ? "high" : "medium",
    confidence: "medium",
    location: site.location,
    subject: site.subject,
    evidence,
    notes,
    exposed: site.exposedBy !== undefined,
    key: site.key,
  };
}

/** PLG202: agents that run the code the model writes without a sandbox. */
function localCodeExecution(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const agent of cx.inventory.agents) {
    const capability = agent.capabilities.find(
      (item) => item.kind === "code" && item.tool === undefined,
    );
    if (
      capability === undefined ||
      (capability.sandbox !== undefined && capability.sandbox !== "none")
    )
      continue;
    const name = cx.agentName(agent);
    const exposedBy = cx.exposure.get(agent.id);
    const known = capability.sandbox === "none";
    const inner = /\((.+)\)$/.exec(capability.target)?.[1] ?? capability.target;
    const setting = inner.includes("=") ? inner : clientLabel(inner);
    const notes = known
      ? []
      : ["plenger could not tell which code executor is used; check that it is sandboxed."];
    if (exposedBy !== undefined) notes.push(`Reachable from ${code(exposedBy)}.`);
    drafts.push({
      rule: "PLG202",
      title: known
        ? `Agent ${code(name)} runs model-written code on the host (${code(setting)})`
        : `Agent ${code(name)} runs model-written code with an unidentified executor`,
      severity: exposedBy !== undefined ? "critical" : "high",
      confidence: known ? "high" : "low",
      location: agent.location,
      subject: { kind: "agent", name, id: agent.id },
      evidence: [
        {
          location: agent.location,
          message: `agent ${code(name)} executes code with ${code(setting)}`,
        },
      ],
      notes,
      exposed: exposedBy !== undefined,
      key: [name],
    });
  }
  return drafts;
}

/** PLG203: limits switched off, or teams that never stop on their own. */
function unboundedLoops(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const agent of cx.inventory.agents) {
    const name = cx.agentName(agent);
    const site = cx.callAt(agent.location, agent.target);
    const sites = [
      ...(site === undefined ? [] : [{ ...site, location: agent.location }]),
      ...agent.invocations.flatMap((run) => {
        const found = cx.callAt(run.location);
        return found === undefined ? [] : [{ ...found, location: run.location }];
      }),
    ];
    let reason: { message: string; location: Location } | null = null;
    for (const { file, call, location } of sites) {
      const option = unlimitedOption(call.arguments, file.facts);
      if (option !== null) {
        reason = { message: `${code(option)} removes the limit`, location };
        break;
      }
    }
    if (reason === null && OPEN_ENDED_TEAM.test(agent.target) && site !== undefined) {
      const { call, file } = site;
      const limited = ["termination_condition", "max_turns"].some(
        (option) => select(call.arguments, file.facts, option).length > 0,
      );
      if (!limited)
        reason = {
          message: "team created with no `termination_condition` and no `max_turns`",
          location: agent.location,
        };
    }
    if (reason === null) continue;
    drafts.push({
      rule: "PLG203",
      title: `Agent ${code(name)} runs with no iteration limit`,
      severity: "low",
      confidence: "high",
      location: reason.location,
      subject: { kind: "agent", name, id: agent.id },
      evidence: [{ location: reason.location, message: reason.message }],
      notes: [],
      exposed: cx.exposure.has(agent.id),
      key: [name],
    });
  }
  return drafts;
}

/** A limit option set to no limit (`None`, `Infinity`) or to a very large number. */
function unlimitedOption(args: Argument[], facts: FileFacts): string | null {
  for (const option of LIMIT_OPTIONS) {
    const [value] = select(args, facts, option);
    if (value === undefined) continue;
    const target = deref(value, facts);
    const text = target.kind === "literal" || target.kind === "other" ? target.text : null;
    if (text === null) continue;
    const count = Number(text.replace(/_/g, ""));
    if (UNLIMITED.test(text) || (Number.isFinite(count) && count >= UNLIMITED_COUNT))
      return `${option.replace(/^config\./, "")}=${text}`;
  }
  return null;
}
