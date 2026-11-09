/** MCP members (tools, resources, prompts) registered on a server, and the server's transport. */

import {
  ANONYMOUS,
  type CallFact,
  type Decorator,
  type DefinitionFact,
  type Span,
} from "../../facts/model.ts";
import { deref, select } from "../../facts/query.ts";
import type { FunctionRef } from "../../project/index.ts";
import type { McpMemberRule, McpTransportRule } from "../detectors.ts";
import type { McpServer } from "../model.ts";
import type { FileDetector } from "./file-detector.ts";
import { withoutReceiver } from "./tools.ts";

export function mcpMemberDecorator(
  d: FileDetector,
  rule: McpMemberRule,
  definition: DefinitionFact,
  decorator: Decorator,
): void {
  const { scope, facts } = d;
  const server = serverFor(d, decorator.receiver, decorator.ref);
  const name =
    (rule.name === undefined
      ? null
      : scope.literal(select(decorator.arguments, facts, rule.name))) ??
    definition.name ??
    ANONYMOUS;
  const description =
    (rule.description === undefined
      ? null
      : scope.literal(select(decorator.arguments, facts, rule.description))) ?? definition.doc;
  addMember(
    d,
    rule,
    server,
    name,
    description,
    { definition: definition.id, path: scope.path },
    definition.span,
    withoutReceiver(definition),
  );
}

export function mcpMemberCall(d: FileDetector, rule: McpMemberRule, call: CallFact): void {
  const { scope, facts } = d;
  const server = serverFor(d, call.receiver, call.ref);
  const handlerRef =
    rule.handler === undefined
      ? null
      : scope.functionRef(select(call.arguments, facts, rule.handler)[0]);
  const handler = handlerRef === null ? undefined : d.project.definition(handlerRef);
  const name =
    (rule.name === undefined ? null : scope.literal(select(call.arguments, facts, rule.name))) ??
    handler?.name ??
    rule.label ??
    ANONYMOUS;
  const description =
    (rule.description === undefined
      ? null
      : scope.literal(select(call.arguments, facts, rule.description))) ??
    handler?.doc ??
    null;
  addMember(
    d,
    rule,
    server,
    name,
    description,
    handlerRef,
    call.span,
    handler === undefined ? [] : withoutReceiver(handler),
  );
}

/** The server a member or transport call belongs to: its receiver, or the file's only server. */
function serverFor(
  d: FileDetector,
  receiver: number | undefined,
  ref: CallFact["ref"],
): McpServer | undefined {
  const instance = d.instances.instanceOf(receiver) ?? d.project.instanceAt(ref?.origin);
  return instance?.kind === "mcp_server"
    ? instance.component
    : d.instances.soleInstance("mcp_server")?.component;
}

function addMember(
  d: FileDetector,
  rule: McpMemberRule,
  server: McpServer | undefined,
  name: string,
  description: string | null,
  handlerRef: FunctionRef | null,
  span: Span,
  params: string[],
): void {
  const { scope } = d;
  if (rule.member === "tool") {
    const tool = d.tools.add({
      id: scope.id("tool", span),
      framework: rule.framework,
      location: scope.location(span),
      name,
      description,
      ...scope.handlerFields(handlerRef),
      params,
      via: "mcp",
      server: server?.id ?? null,
    });
    server?.tools.push(tool.id);
    return;
  }
  const member = { name, ...scope.handlerFields(handlerRef), location: scope.location(span) };
  if (rule.member === "resource") server?.resources.push(member);
  else server?.prompts.push(member);
}

export function mcpTransport(d: FileDetector, rule: McpTransportRule, call: CallFact): void {
  const { scope, facts } = d;
  const server = serverFor(d, call.receiver, call.ref);
  if (server === undefined) return;
  let transport = rule.fixed;
  if (rule.transport !== undefined) {
    const [value] = select(call.arguments, facts, rule.transport);
    const target = value === undefined ? undefined : deref(value, facts);
    const text =
      target?.kind === "call"
        ? (facts.calls[target.call]?.ref?.name ?? "")
        : (scope.literal(value === undefined ? [] : [value]) ?? "");
    if (/stdio/i.test(text)) transport = "stdio";
    else if (/streamable|http/i.test(text)) transport = "streamable-http";
    else if (/sse/i.test(text)) transport = "sse";
  }
  server.transport = transport;
}
