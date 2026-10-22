/** HTTP entry points: route decorators and registration calls, and Next.js route files. */

import type { CallFact, Decorator, DefinitionFact, Span } from "../../facts/model.ts";
import { select } from "../../facts/query.ts";
import type { FunctionRef } from "../../project/index.ts";
import { byFamily } from "../../source/languages.ts";
import type { RouteRule } from "../detectors.ts";
import type { EntryPoint } from "../model.ts";
import type { FileDetector } from "./file-detector.ts";

/** Registration methods that mean GET when no methods are given (Flask `route`, `add_url_rule`). */
const GET_BY_DEFAULT = ["route", "add_url_rule"];
/** Registration methods that accept every HTTP method, or a WebSocket. */
const ANY_METHOD = [
  "all",
  "api_route",
  "add_api_route",
  "path",
  "re_path",
  "websocket",
  "add_api_websocket_route",
  "websocketroute",
  "view",
  "add_view",
];
/** A Next.js App Router `route.ts`, capturing the directory segments under `app/`. */
const APP_ROUTE_FILE = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/;
/** A Next.js Pages Router API route, capturing the path under `pages/api/`. */
const PAGES_API_FILE = /(?:^|\/)pages\/api\/(.+)\.[cm]?[jt]sx?$/;
/** Route groups `(marketing)` and parallel routes `@modal` do not appear in the URL. */
const HIDDEN_SEGMENT = /^\(.*\)$|^@/;
const APP_ROUTE_HANDLER = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;

export function routeDecorator(
  d: FileDetector,
  rule: RouteRule,
  definition: DefinitionFact,
  decorator: Decorator,
): void {
  const name = decorator.ref?.name ?? "";
  addRoute(
    d,
    rule,
    name,
    decorator.arguments,
    { definition: definition.id, path: d.scope.path },
    decorator.span,
    rule.prefix === undefined ? null : classPrefix(d, definition, rule.prefix),
  );
}

/** The path a decorator on a method's class puts before the method's own (`@Controller("users")`). */
function classPrefix(d: FileDetector, definition: DefinitionFact, pattern: string): string | null {
  const owner = d.facts.definitions.find(
    (candidate) => candidate.id === definition.parent && candidate.kind === "class",
  );
  const decorator = owner?.decorators.find((item) => item.ref?.name === pattern);
  return decorator === undefined
    ? null
    : (d.scope.literal(select(decorator.arguments, d.facts, "#0")) ?? "");
}

export function routeCall(d: FileDetector, rule: RouteRule, call: CallFact): void {
  const handler =
    rule.handler === undefined
      ? null
      : d.scope.functionRef(select(call.arguments, d.facts, rule.handler).at(-1));
  addRoute(d, rule, call.ref?.name ?? "", call.arguments, handler, call.span);
}

function addRoute(
  d: FileDetector,
  rule: RouteRule,
  target: string,
  args: CallFact["arguments"] | null,
  handlerRef: FunctionRef | null,
  span: Span,
  prefix: string | null = null,
): void {
  const { scope, facts } = d;
  const own = scope.literal(select(args, facts, rule.path));
  const path =
    prefix === null
      ? own
      : `/${[prefix, own ?? ""]
          .map((part) => part.replace(/^\/+|\/+$/g, ""))
          .filter(Boolean)
          .join("/")}`;
  // The method is the last name segment; an empty segment, not the whole target, when there is none.
  // aiohttp's `add_get` registers a GET.
  const segment = (/([\w$]+)(?:\(\))?$/.exec(target)?.[1]?.toLowerCase() ?? "").replace(
    /^add_(?=(?:get|post|put|patch|delete|head|options)$)/,
    "",
  );
  const explicit =
    rule.methods === undefined ? [] : scope.strings(select(args, facts, rule.methods));
  let methods: string[];
  if (explicit.length > 0) methods = explicit.map((method) => method.toUpperCase());
  else if (GET_BY_DEFAULT.includes(segment)) methods = ["GET"];
  else if (ANY_METHOD.includes(segment)) {
    methods = [segment.includes("websocket") ? "WEBSOCKET" : "*"];
  } else methods = [segment.toUpperCase()];
  for (const method of methods) {
    const entry: EntryPoint = {
      id: scope.id("route", span),
      framework: rule.framework,
      location: scope.location(span),
      kind: "http",
      method,
      path,
      ...scope.handlerFields(handlerRef),
      reaches: [],
    };
    d.inventory.entryPoints.push(entry);
  }
}

/** Next.js App Router `route.ts` handlers and Pages Router API routes. */
export function routeFiles(d: FileDetector): void {
  const { scope } = d;
  if (!byFamily(scope.language, { python: false, javascript: true, php: false })) return;
  const app = APP_ROUTE_FILE.exec(scope.path);
  const pages = PAGES_API_FILE.exec(scope.path);
  if (app === null && pages === null) return;
  const exported = d.facts.definitions.filter(
    (definition) => definition.parent === null && definition.exported,
  );
  const add = (method: string, path: string, definition: DefinitionFact) =>
    d.inventory.entryPoints.push({
      id: scope.id("route", definition.span),
      framework: "nextjs",
      location: scope.location(definition.span),
      kind: "http",
      method,
      path,
      handler: definition.id,
      reaches: [],
    });
  if (app !== null) {
    const segments = (app[1] ?? "")
      .split("/")
      .filter((segment) => segment !== "" && !HIDDEN_SEGMENT.test(segment));
    for (const definition of exported) {
      if (APP_ROUTE_HANDLER.test(definition.name ?? "")) {
        add(definition.name as string, `/${segments.join("/")}`, definition);
      }
    }
  }
  if (pages !== null) {
    const route = (pages[1] ?? "").replace(/(?:^|\/)index$/, "");
    for (const definition of exported.filter((candidate) => candidate.name === "default")) {
      add("*", `/api${route === "" ? "" : `/${route}`}`, definition);
    }
  }
  if (d.inventory.entryPoints.some((entry) => entry.framework === "nextjs")) {
    d.addFramework("nextjs");
  }
}
