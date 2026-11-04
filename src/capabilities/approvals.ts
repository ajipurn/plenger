/**
 * Human approval steps: options on tools and agents (`needs_approval`,
 * `interrupt_before`), approval middleware, and calls in handlers that ask a person.
 */

import type { Argument, CallFact, FileFacts } from "../facts/model.ts";
import { deref, isEnabled, literalString, provenanceOf, select } from "../facts/query.ts";
import type { Agent, Location, Tool } from "../inventory/model.ts";
import { MODULE_SCOPE, type ProjectIndex } from "../project/index.ts";
import type { Project } from "../project/project.ts";
import { sameStart } from "../shared/location.ts";
import { shortName } from "../shared/text.ts";
import { compiledSinks } from "./catalog.ts";
import { MAX_DEPTH } from "./effects.ts";
import { APPROVAL_OPTIONS } from "./sinks.ts";

const INTERRUPT_OPTIONS = [
  "interrupt_before",
  "interrupt_after",
  "interruptBefore",
  "interruptAfter",
];

/** Finds approval steps, remembering the answer for every function it has searched. */
export class ApprovalFinder {
  readonly #project: Project;
  readonly #index: ProjectIndex;
  readonly #approvals = new Map<string, string | null>();

  constructor(project: Project, index: ProjectIndex) {
    this.#project = project;
    this.#index = index;
  }

  /** An approval option on the tool's declaration, or a call in its handler that asks a person. */
  toolApproval(tool: Tool): string | null {
    const file = this.#project.files.get(tool.location.path);
    if (file !== undefined) {
      const options: (Argument[] | null)[] = [];
      for (const call of this.#index.callsAt(tool.location)?.calls ?? [])
        options.push(call.arguments);
      const definition = file.facts.definitions.find((candidate) =>
        sameStart(candidate.span, tool.location),
      );
      for (const decorator of definition?.decorators ?? []) options.push(decorator.arguments);
      for (const args of options) {
        const option = approvalOption(args, file.facts);
        if (option !== null) return option;
      }
    }
    if (tool.via === "builtin") return this.approvalInArguments(tool.location);
    if (tool.handler === null) return null;
    return this.approvalIn(tool.handlerPath ?? tool.location.path, tool.handler, 0);
  }

  /**
   * A built-in tool given a project object that asks a person before acting
   * (`ApplyPatchTool(editor=WorkspaceEditor(...))` whose methods prompt for approval).
   */
  approvalInArguments(location: Location): string | null {
    const site = this.#index.callAt(location);
    if (site === undefined) return null;
    const { file, call } = site;
    for (const arg of call.arguments) {
      for (const index of provenanceOf(arg.value, file.facts, call.scope).calls) {
        const ref = file.facts.calls[index]?.ref;
        if (ref?.kind !== "local" || (ref.path !== "" && ref.path !== "()")) continue;
        const path = ref.file ?? file.path;
        const methods = (this.#project.files.get(path)?.facts.definitions ?? []).filter(
          (definition) => definition.parent === ref.definition,
        );
        for (const method of methods) {
          const found = this.approvalIn(path, method.id, 0);
          if (found !== null) return found;
        }
      }
    }
    return null;
  }

  /** Approval for a whole agent: graph interrupts, approval middleware, a human in the loop, or a node that asks. */
  agentApproval(agent: Agent): string | null {
    const site = this.#index.callAt(agent.location, agent.target);
    if (site !== undefined) {
      const { call } = site;
      const facts = site.file.facts;
      for (const option of INTERRUPT_OPTIONS) {
        if (isEnabled(select(call.arguments, facts, option)[0], facts)) return option;
      }
      if (literalString(select(call.arguments, facts, "human_input_mode")[0], facts) === "ALWAYS")
        return 'human_input_mode="ALWAYS"';
      for (const value of select(call.arguments, facts, "middleware[*]")) {
        const target = deref(value, facts);
        const name = target.kind === "call" ? facts.calls[target.call]?.ref?.name : undefined;
        if (name !== undefined && /HumanInTheLoopMiddleware$/i.test(name)) return shortName(name);
      }
      // `builder.compile(interrupt_before=[...])` on a graph built in the same file.
      for (const candidate of facts.calls) {
        if (!/\.compile$/.test(candidate.callee)) continue;
        const provenance = provenanceOf(
          { kind: "call", call: facts.calls.indexOf(candidate) },
          facts,
          candidate.scope,
        );
        if (!provenance.calls.has(facts.calls.indexOf(call))) continue;
        for (const option of INTERRUPT_OPTIONS) {
          if (isEnabled(select(candidate.arguments, facts, option)[0], facts)) return option;
        }
      }
      const option = approvalOption(call.arguments, facts);
      if (option !== null) return option;
    }
    for (const node of agent.nodes) {
      if (node.handler === null) continue;
      const found = this.approvalIn(node.handlerPath ?? agent.location.path, node.handler, 0);
      if (found !== null) return found;
    }
    return null;
  }

  /** The first call that asks a person, in a function or the project functions it calls. */
  approvalIn(path: string, definition: string, depth: number): string | null {
    const memoKey = `${path}|${definition}`;
    const cached = this.#approvals.get(memoKey);
    if (cached !== undefined) return cached;
    const file = this.#project.files.get(path);
    if (file === undefined || depth > MAX_DEPTH) return null;
    this.#approvals.set(memoKey, null);
    const scopes = this.#index.scopesOf(file, definition);
    let found: string | null = null;
    for (const call of file.facts.calls) {
      if (!scopes.has(call.scope ?? MODULE_SCOPE)) continue;
      const name = call.ref?.name;
      if (
        name !== undefined &&
        call.ref?.kind !== "local" &&
        compiledSinks().approvals.test(name) &&
        decides(call, name, file.facts)
      ) {
        found = name;
        break;
      }
      const target = this.#index.calledFunction(file, call);
      if (target !== null) {
        found = this.approvalIn(target.path, target.definition, depth + 1);
        if (found !== null) break;
      }
    }
    this.#approvals.set(memoKey, found);
    return found;
  }
}

/**
 * Approval calls that decide while their result goes unused: an interrupt pauses the
 * graph and `question` answers through its callback.
 */
const DECIDES_UNUSED = /(?:[.#]interrupt|\.question)$/;

/**
 * Whether an approval call can stop what follows: its answer is used, or it decides
 * without one, as `click.confirm(..., abort=True)` raises on a no. A prompt whose
 * answer is thrown away (`input("Press enter")`) approves nothing.
 */
function decides(call: CallFact, name: string, facts: FileFacts): boolean {
  return (
    call.discarded !== true ||
    DECIDES_UNUSED.test(name) ||
    isEnabled(select(call.arguments, facts, "abort")[0], facts)
  );
}

/** An approval option set to anything but false or never. */
function approvalOption(args: Argument[] | null, facts: FileFacts): string | null {
  for (const option of APPROVAL_OPTIONS) {
    const [value] = select(args, facts, option);
    if (isEnabled(value, facts)) return option;
  }
  return null;
}
