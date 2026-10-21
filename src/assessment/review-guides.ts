import { createHash } from "node:crypto";
import type { Inventory } from "../inventory/model.ts";
import { SECURITY_REVIEW_LIMITS } from "./review-model.ts";

/**
 * Short notes for source review, one per framework: where its controls attach, which
 * calls are safe by default and which mistakes are common. They tell the model where to
 * look; they are never evidence. Web frameworks come first: a route's guards decide most
 * candidates.
 */
export const REVIEW_GUIDES: readonly { id: string; frameworks: readonly string[]; text: string }[] =
  [
    {
      id: "fastapi",
      frameworks: ["fastapi", "starlette"],
      text: "FastAPI and Starlette: authentication attaches as a dependency (Depends, Security) on the route, on APIRouter(dependencies=...) or on include_router(..., dependencies=...), or as middleware; check the router and include_router call, not only the handler signature. A dependency that returns the current user does not authorize a record: look for the owner or tenant filter in the query. Pydantic types constrain shape, not authority. FileResponse serves any path it is given; StaticFiles stays inside its directory. SQLAlchemy select() and bound parameters are safe; text() or execute() with f-strings is not. A response_model limits returned fields; returning ORM objects without one can expose all of them.",
    },
    {
      id: "flask",
      frameworks: ["flask"],
      text: "Flask: authentication attaches through before_request on the app or a blueprint, or decorators such as login_required placed below the route decorator; a decorator above @app.route does not wrap the registered view. send_from_directory confines the name to its directory; send_file and open(os.path.join(...)) do not. render_template escapes .html templates; render_template_string with request text, Markup() and |safe do not. request.args, form, json and files are untrusted. The session cookie is signed, not encrypted, and SECRET_KEY in source is a credential. SQLAlchemy text() with string formatting is injectable.",
    },
    {
      id: "django",
      frameworks: ["django"],
      text: "Django: authentication attaches as login_required or permission_required, LoginRequiredMixin and PermissionRequiredMixin on class views, Django REST framework permission_classes or DEFAULT_PERMISSION_CLASSES in settings, and middleware in settings.MIDDLEWARE. get_object_or_404(Model, pk=pk) alone is not authorization; object access needs a queryset filtered by request.user or the tenant. The ORM's filter() and parameters are safe; raw(), extra(), RawSQL and cursor.execute() with formatted strings are not. Templates escape by default; mark_safe, |safe and autoescape off do not. csrf_exempt removes CSRF checks. safe_join and FileSystemStorage confine paths.",
    },
    {
      id: "aiohttp",
      frameworks: ["aiohttp"],
      text: "aiohttp: authentication attaches as middlewares on the Application or a sub-application; a route added to another app does not get them. request.match_info, query and post data are untrusted. add_static stays inside its directory; web.FileResponse serves any path it is given. aiohttp_jinja2 escapes only when autoescape is on.",
    },
    {
      id: "express",
      frameworks: ["express"],
      text: "Express: authentication is middleware passed to app.use, router.use, the mount call (app.use('/admin', auth, router)) or the route itself. Order matters: middleware registered after a route does not protect it. req.params, query and body are untrusted, and with the default query parser a query value can be an array or object, which defeats string checks. res.sendFile with a root option and express.static stay inside their directory; path.join(base, name) without that check does not. EJS <%- %> and Pug != do not escape. child_process.exec runs a shell; execFile and spawn with an argument array do not.",
    },
    {
      id: "fastify",
      frameworks: ["fastify"],
      text: "Fastify: authentication attaches as onRequest or preHandler hooks on the instance or route. Plugins are encapsulated: a hook registered inside a plugin applies only to routes registered in it, unless the plugin uses fastify-plugin. A route schema constrains shape, not authority. @fastify/static and reply.sendFile with its root stay inside the directory.",
    },
    {
      id: "koa",
      frameworks: ["koa"],
      text: "Koa: middleware runs in app.use order and router.use order; a route registered on a router without the auth middleware, or before it in another router, is open. ctx.params, ctx.query and ctx.request.body are untrusted. koa-send and koa-static with a root stay inside it.",
    },
    {
      id: "hono",
      frameworks: ["hono"],
      text: "Hono: middleware attaches with app.use(path, ...) and applies to routes matched by that path, in registration order; app.route() mounts sub-apps that carry their own middleware. c.req.param(), query() and json() are untrusted. serveStatic stays inside its root.",
    },
    {
      id: "nestjs",
      frameworks: ["nestjs"],
      text: "NestJS: authorization is a guard: @UseGuards on the controller or method, or a global APP_GUARD; a custom decorator such as @Public() can skip a global guard, so check what it does. ValidationPipe with whitelist strips unknown fields; DTO types alone do not validate at runtime. TypeORM and Prisma queries with parameters are safe; query() or $queryRawUnsafe with interpolated text is not. Ownership checks belong in the service query, not only in the route.",
    },
    {
      id: "nextjs",
      frameworks: ["nextjs"],
      text: "Next.js: route handlers (app/**/route.ts), pages/api handlers and server actions are public endpoints unless they check the session themselves. middleware.ts runs only for paths its matcher config selects; a path outside the matcher is not protected by it. Server action arguments and search params are untrusted. dangerouslySetInnerHTML does not escape. Prisma's $queryRaw template literal is parameterized; $queryRawUnsafe and $executeRawUnsafe with interpolation are not.",
    },
    {
      id: "langchain",
      frameworks: ["langchain", "langgraph"],
      text: "LangChain and LangGraph: a tool's arguments come from the model, so whoever can steer the model, through user text, retrieved documents or tool results, chooses them. Shell, Python REPL, requests, file management and SQL database toolkits act with the process's privileges. Human approval attaches as interrupt_before or interrupt nodes in a graph, or HumanInTheLoopMiddleware; check that the effect runs only after it. Retrieved documents and tool output are untrusted text in the model's context. A prompt template that fills the system message from request data lets the caller rewrite instructions.",
    },
    {
      id: "mcp",
      frameworks: ["mcp"],
      text: "MCP: every tool a server registers can be called by any client that connects. A stdio server runs with the launching user's privileges; an HTTP or SSE server needs authentication on its transport. Tool arguments are untrusted. On the client side, tool descriptions and results from a server enter the model's context, and a server started through npx or uvx without a pinned version runs whatever that package resolves to.",
    },
    {
      id: "openai-agents",
      frameworks: ["openai-agents", "openai"],
      text: "OpenAI SDK and Agents SDK: function_tool arguments come from the model. Input and output guardrails check content; they are not authorization. Handoffs pass the conversation to another agent with its own tools. Hosted tools run at the provider. dangerouslyAllowBrowser exposes the API key to every visitor.",
    },
    {
      id: "crewai",
      frameworks: ["crewai"],
      text: "CrewAI: allow_code_execution with code_execution_mode 'unsafe' runs model-written code on the host; 'safe' uses a Docker sandbox. Tools act with the process's privileges, and allow_delegation lets an agent hand work to others with their tools.",
    },
    {
      id: "smolagents",
      frameworks: ["smolagents"],
      text: "smolagents: CodeAgent runs model-written Python in the local process unless executor_type names a sandbox (e2b, docker, modal, wasm). additional_authorized_imports widens what that code can import; '*' allows any module.",
    },
    {
      id: "vercel-ai",
      frameworks: ["vercel-ai", "mastra"],
      text: "Vercel AI SDK and Mastra: a tool's execute function runs on the server with arguments the model chooses. A route handler that calls streamText or generateText is a public endpoint unless it checks the session, and maxSteps or stopWhen bounds tool loops.",
    },
    {
      id: "agent-frameworks",
      frameworks: ["autogen", "llamaindex", "pydantic-ai", "llmfy"],
      text: "Agent frameworks (AutoGen, LlamaIndex, Pydantic AI, llmfy): tool arguments come from the model, and retrieved or tool-produced text is untrusted. Code executors run model-written code with the executor's privileges; a local executor is not a sandbox. A team or loop without a termination condition or turn limit can run without end.",
    },
  ];

export interface SelectedGuide {
  id: string;
  text: string;
}

/**
 * The guides for the frameworks the static inventory found, in guide order, within
 * `SECURITY_REVIEW_LIMITS.guideBytes`. The choice depends only on the scan.
 */
export function selectGuides(inventory: Inventory): SelectedGuide[] {
  const found = new Set(inventory.frameworks.map((framework) => framework.id));
  const selected: SelectedGuide[] = [];
  let bytes = 0;
  for (const guide of REVIEW_GUIDES) {
    if (!guide.frameworks.some((framework) => found.has(framework))) continue;
    const size = Buffer.byteLength(guide.text);
    if (bytes + size > SECURITY_REVIEW_LIMITS.guideBytes) continue;
    bytes += size;
    selected.push({ id: guide.id, text: guide.text });
  }
  return selected;
}

/** What a review records about its guides: ids and the SHA-256 of their text. */
export function guideDigests(guides: readonly SelectedGuide[]) {
  return guides.map((guide) => ({
    id: guide.id,
    digest: createHash("sha256").update(guide.text).digest("hex"),
  }));
}
