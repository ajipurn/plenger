import type { McpClient, McpServer } from "../../inventory/model.ts";
import {
  ACTION_PHRASE,
  actionKinds,
  code,
  listed,
  NETWORK_TRANSPORT,
  type RuleContext,
} from "../context.ts";
import type { Draft, Evidence } from "../model.ts";

const LOCAL_HOST =
  /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|host\.docker\.internal|[\w-]+\.local|[\w-]+\.localhost)$/i;

/** PLG601–PLG603: how MCP servers are exposed and how clients reach them. */
export function mcpChecks(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const server of cx.inventory.mcpServers) {
    const draft = unauthenticated(cx, server);
    if (draft !== null) drafts.push(draft);
  }
  for (const client of cx.inventory.mcpClients) {
    const unpinned = unpinnedServer(client);
    if (unpinned !== null) drafts.push(unpinned);
    const plaintext = plaintextTransport(client);
    if (plaintext !== null) drafts.push(plaintext);
  }
  return drafts;
}

/** PLG601: a network MCP server with high-impact tools and no authentication seen in its file. */
function unauthenticated(cx: RuleContext, server: McpServer): Draft | null {
  if (server.transport === null || !NETWORK_TRANSPORT.test(server.transport)) return null;
  if (cx.serverAuth(server) !== null) return null;
  const evidence: Evidence[] = [];
  const actions = server.tools.flatMap((id) => {
    const tool = cx.tools.get(id);
    const found = (tool?.capabilities ?? []).filter((capability) => cx.isAction(capability));
    if (tool !== undefined && found.length > 0) {
      evidence.push({
        location: tool.location,
        message: `tool ${code(tool.name)} can ${listed(actionKinds(found).map((kind) => ACTION_PHRASE[kind]))}`,
      });
    }
    return found;
  });
  if (actions.length === 0) return null;
  const name = server.name ?? "unnamed";
  const kinds = actionKinds(actions);
  return {
    rule: "PLG601",
    title: `MCP server ${code(name)} serves tools that ${listed(kinds.map((kind) => ACTION_PHRASE[kind]))} over ${server.transport} with no authentication`,
    severity: "high",
    confidence: "medium",
    location: server.location,
    subject: { kind: "mcp_server", name, id: server.id },
    evidence: [
      {
        location: server.location,
        message: `MCP server ${code(name)} served over ${server.transport}`,
      },
      ...evidence.slice(0, 5),
    ],
    notes: [
      "No authentication option or MCP auth import was seen in the server's file. Authentication done by a proxy or by middleware elsewhere is not visible to plenger.",
    ],
    exposed: true,
    key: [name],
  };
}

/** PLG602: `npx`, `uvx`, `pipx run` or `docker run` without a pinned version. */
function unpinnedServer(client: McpClient): Draft | null {
  if (client.command === null) return null;
  const tokens = client.command.split(/\s+/).filter((token) => token !== "");
  const spec = packageSpec(tokens);
  if (spec === null || spec.pinned) return null;
  return {
    rule: "PLG602",
    title: `MCP server ${code(spec.name)} is started from an unpinned ${spec.registry}`,
    severity: "medium",
    confidence: "high",
    location: client.location,
    subject: { kind: "mcp_client", name: spec.name, id: client.id },
    evidence: [{ location: client.location, message: `starts ${code(client.command)}` }],
    notes: [],
    exposed: false,
    key: [spec.name],
  };
}

/** The package or image a launcher command starts, and whether its version is pinned. */
export function packageSpec(
  tokens: string[],
): { name: string; pinned: boolean; registry: string } | null {
  const [runner, ...rest] = tokens;
  if (runner === undefined) return null;
  const program = runner.replace(/^.*[\\/]/, "").replace(/\.(?:cmd|exe)$/, "");
  const args = (skip: number) => rest.slice(skip).filter((token) => !token.startsWith("-"));
  let spec: string | undefined;
  if (program === "npx" || program === "bunx") {
    const package_ = rest.indexOf("--package");
    const short = rest.indexOf("-p");
    const flag = package_ !== -1 ? package_ : short;
    spec = flag !== -1 ? rest[flag + 1] : args(0)[0];
    if (spec === undefined) return null;
    const version = /^(@?[^@]+)@(.+)$/.exec(spec);
    return { name: version?.[1] ?? spec, pinned: npmPinned(version?.[2]), registry: "npm package" };
  }
  if ((program === "pnpm" || program === "yarn") && rest[0] === "dlx") {
    spec = args(1)[0];
    if (spec === undefined) return null;
    const version = /^(@?[^@]+)@(.+)$/.exec(spec);
    return { name: version?.[1] ?? spec, pinned: npmPinned(version?.[2]), registry: "npm package" };
  }
  if (
    program === "uvx" ||
    (program === "uv" && rest[0] === "tool") ||
    (program === "pipx" && rest[0] === "run")
  ) {
    const from = rest.indexOf("--from");
    spec =
      from !== -1 ? rest[from + 1] : args(program === "uvx" ? 0 : rest[0] === "tool" ? 2 : 1)[0];
    if (spec === undefined) return null;
    const version = /^([\w.[\]-]+?)(?:==|@)([\w.!+-]+)$/.exec(spec);
    return {
      name: version?.[1] ?? spec.replace(/[<>=~!].*$/, ""),
      pinned: version !== null && version[2] !== "latest",
      registry: "Python package",
    };
  }
  if (program === "docker" || program === "podman") {
    const run = rest.indexOf("run");
    if (run === -1) return null;
    const image = imageOf(rest.slice(run + 1));
    if (image === undefined) return null;
    const digest = image.includes("@sha256:");
    const tag = /:([\w.-]+)$/.exec(image.replace(/^[^/]*:\d+\//, ""))?.[1];
    return {
      name: image.replace(/@sha256:.*$/, "").replace(/:[\w.-]+$/, ""),
      pinned: digest || (tag !== undefined && tag !== "latest"),
      registry: "container image",
    };
  }
  return null;
}

/** An exact npm version, not a range, tag or `latest`. */
function npmPinned(version: string | undefined): boolean {
  return version !== undefined && /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(version);
}

/** Docker flags that take a value as the next token. */
const DOCKER_VALUE_FLAGS = new Set([
  "-e",
  "--env",
  "-v",
  "--volume",
  "-p",
  "--publish",
  "-w",
  "--workdir",
  "-u",
  "--user",
  "--name",
  "--network",
  "--mount",
  "--env-file",
  "--entrypoint",
  "-l",
  "--label",
  "--platform",
]);

function imageOf(tokens: string[]): string | undefined {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (token.startsWith("-")) {
      if (DOCKER_VALUE_FLAGS.has(token)) index++;
      continue;
    }
    return token;
  }
  return undefined;
}

/** PLG603: a remote MCP server reached over plain HTTP. */
function plaintextTransport(client: McpClient): Draft | null {
  if (client.url === null) return null;
  let url: URL;
  try {
    url = new URL(client.url);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || LOCAL_HOST.test(url.hostname)) return null;
  return {
    rule: "PLG603",
    title: `MCP client connects to ${code(client.url)} over plain HTTP`,
    severity: "low",
    confidence: "high",
    location: client.location,
    subject: { kind: "mcp_client", name: client.url, id: client.id },
    evidence: [{ location: client.location, message: `connects to ${code(client.url)}` }],
    notes: [],
    exposed: false,
    key: [client.url],
  };
}
