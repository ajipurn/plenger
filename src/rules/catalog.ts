import type { Rule } from "./model.ts";

/**
 * The risk rules. OWASP ids refer to the Top 10 for LLM Applications 2025 (`LLMxx:2025`)
 * and the Top 10 for Agentic Applications 2026 (`ASIxx`).
 */
export const RULES: Rule[] = [
  // Tools: what the model can make a tool do.
  {
    id: "PLG101",
    name: "tool-command-injection",
    title: "Tool runs a command the model controls",
    description:
      "A tool builds a shell command, or names the program to run, from arguments the model chooses. Anyone who can influence the model, directly or through content it reads, can run commands with the agent's privileges.",
    severity: "critical",
    owasp: ["LLM06:2025", "LLM05:2025", "ASI02", "ASI05"],
    cwe: [78, 77],
    remediation:
      "Do not let the model write commands. Expose narrow tools that run a fixed program with an argument list and no shell, validate each argument against an allow-list, and run anything broader in a sandbox without credentials and behind human approval.",
  },
  {
    id: "PLG102",
    name: "tool-argument-injection",
    title: "Tool passes model input to a program's arguments",
    description:
      "A tool runs a fixed program without a shell but passes arguments the model chooses. A value that starts with `-` can turn into an option (`--output=...`, `-c ...`) and change what the program does.",
    severity: "medium",
    owasp: ["LLM06:2025", "ASI02"],
    cwe: [88],
    remediation:
      "Validate arguments against an allow-list or a strict pattern, reject values that start with `-`, and put `--` before positional arguments where the program supports it.",
  },
  {
    id: "PLG103",
    name: "tool-code-execution",
    title: "Tool evaluates code the model controls",
    description:
      "A tool evaluates model-chosen input as code (`eval`, `exec`, `Function`, `vm`, a Python REPL tool) in the agent's own process.",
    severity: "critical",
    owasp: ["LLM05:2025", "LLM06:2025", "ASI05"],
    cwe: [94, 95],
    remediation:
      "Replace evaluation with a parser for the narrow language the tool needs (an arithmetic parser, `ast.literal_eval`, JSON). If the tool must run code, run it in an isolated sandbox (container or remote) with no credentials or network.",
  },
  {
    id: "PLG104",
    name: "tool-path-traversal",
    title: "Tool accesses a file path the model controls",
    description:
      "A tool reads, writes or deletes a file at a path built from model-chosen arguments. Without confinement the model can reach files outside the intended directory (`../../.env`, `/etc/passwd`).",
    severity: "high",
    owasp: ["LLM06:2025", "LLM02:2025", "ASI02"],
    cwe: [22, 73],
    remediation:
      "Resolve the path (`os.path.realpath`, `path.resolve`), check that it stays inside an allowed base directory, refuse symlinks out of it, and prefer read-only access.",
  },
  {
    id: "PLG105",
    name: "tool-ssrf",
    title: "Tool requests a URL the model controls",
    description:
      "A tool fetches or opens a URL whose scheme or host the model chooses. The model can be steered to internal services and cloud metadata endpoints, or to send data to an outside server.",
    severity: "medium",
    owasp: ["LLM06:2025", "LLM02:2025", "ASI02"],
    cwe: [918],
    remediation:
      "Allow only known hosts, resolve the host and reject private, loopback and link-local addresses, disable redirects to other hosts, and keep credentials out of requests the model shapes.",
  },
  {
    id: "PLG106",
    name: "tool-sql-injection",
    title: "Tool runs a database query the model controls",
    description:
      "A tool runs a SQL query written by the model or built from its arguments. The model can read or change any data the connection can reach.",
    severity: "high",
    owasp: ["LLM06:2025", "LLM05:2025", "ASI02"],
    cwe: [89],
    remediation:
      "Use parameterised queries with fixed SQL. If the model must write queries, use a read-only connection limited to the tables it needs, with a statement timeout, and review writes before they run.",
  },
  {
    id: "PLG107",
    name: "tool-unsafe-deserialization",
    title: "Tool deserializes data the model controls",
    description:
      "A tool loads model-chosen data, or data from a model-chosen location, with a deserializer that can run code (`pickle`, `yaml.unsafe_load`, `torch.load`).",
    severity: "high",
    owasp: ["LLM05:2025", "ASI05"],
    cwe: [502],
    remediation:
      "Use a data-only format (JSON, `yaml.safe_load`, `safetensors`, `torch.load(weights_only=True)`) and never load files from locations the model chooses.",
  },
  {
    id: "PLG108",
    name: "tool-outbound-action",
    title: "Tool sends messages or payments the model directs",
    description:
      "A tool sends a message to a recipient, or makes a payment of an amount, that the model chooses. Injected instructions can make the agent contact or pay anyone.",
    severity: "high",
    owasp: ["LLM06:2025", "ASI02", "ASI09"],
    cwe: [],
    remediation:
      "Restrict recipients and amounts to allow-lists or limits set by the application, not the model, and require human approval for each send or payment.",
  },

  // Agents: what an agent is allowed to do on its own.
  {
    id: "PLG201",
    name: "agent-unapproved-actions",
    title: "Agent can take high-impact actions with no human approval",
    description:
      "An agent can run commands, execute code, change files, databases or money, or send messages through its tools, and plenger saw no human approval step for those tools or the agent.",
    severity: "high",
    owasp: ["LLM06:2025", "ASI02", "ASI09"],
    cwe: [],
    remediation:
      "Require approval for high-impact tools (`needs_approval`, `interrupt_before`, `HumanInTheLoopMiddleware`, `needsApproval`), give the agent the fewest tools it needs, and log every action.",
  },
  {
    id: "PLG202",
    name: "agent-local-code-execution",
    title: "Agent runs model-written code on the host",
    description:
      'An agent executes the code the model writes in the application\'s own environment (a local executor, `code_execution_mode="unsafe"`, `use_docker=False`).',
    severity: "critical",
    owasp: ["LLM05:2025", "LLM06:2025", "ASI05"],
    cwe: [94],
    remediation:
      "Run generated code in a container or remote sandbox (Docker, E2B, Modal) with no credentials, no access to the host file system and restricted network.",
  },
  {
    id: "PLG203",
    name: "agent-unbounded-loop",
    title: "Agent runs with no iteration limit",
    description:
      "An agent or multi-agent team has its turn, step or recursion limit removed, or has no termination condition, so a confused or manipulated model can loop without end and run up cost.",
    severity: "low",
    owasp: ["LLM10:2025", "ASI08"],
    cwe: [770, 834],
    remediation:
      "Set a turn or step limit (`max_turns`, `max_iterations`, `recursion_limit`, `stopWhen`) and a termination condition, plus a token or cost budget per request.",
  },

  // Prompts: outside text that steers the model.
  {
    id: "PLG301",
    name: "request-to-dangerous-agent",
    title: "HTTP input reaches an agent with high-impact tools",
    description:
      "An HTTP route passes request input to an agent or model call that can run commands, execute code or change files, data or money. Prompt injection in the request turns into those actions.",
    severity: "critical",
    owasp: ["LLM01:2025", "LLM06:2025", "ASI01", "ASI02"],
    cwe: [1427],
    remediation:
      "Authenticate and rate-limit the route, separate untrusted input from instructions, remove high-impact tools from agents that serve untrusted users, and require human approval for the rest.",
  },
  {
    id: "PLG302",
    name: "system-prompt-injection",
    title: "Outside input is placed in the system prompt",
    description:
      "Text from a request or a function argument is placed into the system prompt (an f-string, or a template variable such as llmfy's `{{var}}` filled at the call). Instructions in that text get system-level authority.",
    severity: "high",
    owasp: ["LLM01:2025", "ASI01"],
    cwe: [1427],
    remediation:
      "Keep the system prompt fixed. Pass user and retrieved text in user messages, clearly delimited, and validate values that must go into the system prompt (an enum, a known name).",
  },
  {
    id: "PLG303",
    name: "untrusted-content-in-system-prompt",
    title: "Retrieved or fetched content is placed in the system prompt",
    description:
      "Documents from a retriever or vector store, or content fetched from the web, are placed into the system prompt. Anyone who can write those documents or pages can inject instructions (indirect prompt injection).",
    severity: "medium",
    owasp: ["LLM01:2025", "LLM08:2025", "ASI06"],
    cwe: [1427],
    remediation:
      "Pass retrieved content in a user or tool message, delimited and labelled as data, control who can write to the indexed sources, and limit what the agent can do after reading them.",
  },

  // Output: model output used as code, commands or targets.
  {
    id: "PLG401",
    name: "model-output-to-sink",
    title: "Model output is used as a command, code, query, path or URL",
    description:
      "The output of a model call or agent run flows into a command, code evaluation, query, file path, URL or deserializer without validation. Whoever steers the model controls that effect.",
    severity: "critical",
    owasp: ["LLM05:2025", "ASI05"],
    cwe: [1426, 78, 94, 89, 22, 918],
    remediation:
      "Treat model output as untrusted input: parse it into a strict schema, check values against allow-lists, and never pass it to a shell, `eval` or a query string.",
  },

  // Secrets.
  {
    id: "PLG501",
    name: "hardcoded-model-key",
    title: "Model API key written in the code",
    description:
      "A model client is created with an API key written in the source. Anyone with access to the code, its history or a built artefact can use the key.",
    severity: "high",
    owasp: ["ASI03"],
    cwe: [798],
    remediation:
      "Revoke the key, load it from the environment or a secret manager, and remove it from version control history.",
  },
  {
    id: "PLG502",
    name: "secret-in-source",
    title: "Secret in source code",
    description: "A string in the source has the format of a known API key, token or private key.",
    severity: "high",
    owasp: ["ASI03"],
    cwe: [798],
    remediation:
      "Revoke the secret, load it from the environment or a secret manager, and remove it from version control history.",
  },
  {
    id: "PLG503",
    name: "secret-in-prompt",
    title: "Secret in a prompt",
    description:
      "A prompt contains an API key, token or password. Models repeat their prompts when asked the right way, so the secret can leak to users.",
    severity: "high",
    owasp: ["LLM07:2025", "LLM02:2025", "ASI03"],
    cwe: [200, 798],
    remediation:
      "Remove the secret from the prompt and revoke it. Let tools use credentials on the server side; the model should never see them.",
  },

  // MCP.
  {
    id: "PLG601",
    name: "mcp-server-no-auth",
    title: "MCP server exposes high-impact tools over HTTP with no authentication",
    description:
      "An MCP server served over HTTP (streamable HTTP or SSE) offers tools that run commands, execute code or change files or data, and plenger saw no authentication for it. Anyone who can reach the port can call them.",
    severity: "high",
    owasp: ["LLM06:2025", "ASI02", "ASI03"],
    cwe: [306],
    remediation:
      "Require authentication (`auth=`, `token_verifier=`, `requireBearerAuth`), bind to localhost when only local clients need it, and authorise each tool call.",
  },
  {
    id: "PLG602",
    name: "mcp-unpinned-server",
    title: "MCP server started from an unpinned package",
    description:
      "An MCP client starts a stdio server with `npx`, `uvx`, `pipx run` or `docker run` without a pinned version, so each start can run whatever the registry serves at that moment.",
    severity: "medium",
    owasp: ["LLM03:2025", "ASI04"],
    cwe: [829, 1357],
    remediation:
      "Pin an exact version (`pkg@1.2.3`, `pkg==1.2.3`, an image digest), or install the server as a locked dependency and start it from there.",
  },
  {
    id: "PLG603",
    name: "mcp-plaintext-transport",
    title: "MCP client connects to a remote server over plain HTTP",
    description:
      "An MCP client connects to a non-local server with `http://`. Tool calls, results and any credentials travel unencrypted and can be read or changed on the way.",
    severity: "low",
    owasp: ["ASI04", "ASI07"],
    cwe: [319],
    remediation: "Use `https://` for every remote MCP server.",
  },

  // Framework options that switch off a safety default.
  {
    id: "PLG701",
    name: "dangerous-code-opt-in",
    title: "Framework allowed to run generated code",
    description:
      "A framework option that lets the model's code run is turned on (`allow_dangerous_code=True`, smolagents `additional_authorized_imports` with `*`, `os` or `subprocess`).",
    severity: "high",
    owasp: ["LLM05:2025", "ASI05"],
    cwe: [94],
    remediation:
      "Turn the option off, or run the agent in an isolated sandbox with no credentials and only the imports it needs.",
  },
  {
    id: "PLG702",
    name: "unsafe-deserialization-opt-in",
    title: "Framework allowed to load pickled data",
    description:
      "`allow_dangerous_deserialization=True` lets a vector store or loader unpickle files. Anyone who can replace those files can run code when they are loaded.",
    severity: "high",
    owasp: ["LLM03:2025", "LLM08:2025", "ASI04"],
    cwe: [502],
    remediation:
      "Load only files the application created and stores where others cannot write, or rebuild the index from source documents instead of loading pickles.",
  },
  {
    id: "PLG703",
    name: "remote-code-trust",
    title: "Model loading trusts code from the model repository",
    description:
      "`trust_remote_code=True` runs Python code shipped with a model or dataset from the hub when it is loaded.",
    severity: "high",
    owasp: ["LLM03:2025", "ASI04"],
    cwe: [494],
    remediation:
      "Prefer models that do not need remote code; otherwise pin the exact revision (`revision=` a commit hash) after reviewing its code.",
  },
  {
    id: "PLG704",
    name: "api-key-in-browser",
    title: "Model SDK allowed in the browser",
    description:
      "`dangerouslyAllowBrowser: true` runs the model SDK in the browser, so the API key is shipped to every visitor.",
    severity: "high",
    owasp: ["LLM02:2025", "ASI03"],
    cwe: [522],
    remediation:
      "Call the model from a server route that holds the key, or use short-lived, scoped tokens issued per user.",
  },
  {
    id: "PLG705",
    name: "dangerous-requests-opt-in",
    title: "Framework allowed to make arbitrary HTTP requests",
    description:
      "`allow_dangerous_requests=True` lets an agent's request tools call any URL the model chooses, including internal services.",
    severity: "medium",
    owasp: ["LLM06:2025", "ASI02"],
    cwe: [918],
    remediation:
      "Give the agent tools for specific APIs instead, or put an allow-list of hosts in front of the request tools.",
  },

  // Web routes: request input that reaches an effect, with no model in between.
  {
    id: "PLG801",
    name: "route-command-injection",
    title: "Route runs a command built from request input",
    description:
      "An HTTP route handler, or a project function it calls, builds a shell command, names the program to run or passes program arguments from the request. Anyone who can send the request can run commands with the application's privileges.",
    severity: "critical",
    owasp: [],
    cwe: [78, 77, 88],
    remediation:
      "Run a fixed program with an argument list and no shell, check each request value against an allow-list or a strict pattern, and put `--` before positional arguments.",
  },
  {
    id: "PLG802",
    name: "route-path-traversal",
    title: "Route accesses a file path built from request input",
    description:
      "An HTTP route handler, or a project function it calls, reads, writes or deletes a file at a path built from the request. Without confinement a request can reach files outside the intended directory (`../../.env`).",
    severity: "high",
    owasp: [],
    cwe: [22, 73],
    remediation:
      "Resolve the path (`os.path.realpath`, `Path.resolve`, `path.resolve`), check that it stays inside the base directory (`is_relative_to`, or a prefix that ends with a separator), or accept only names that match a strict pattern.",
  },
  {
    id: "PLG803",
    name: "route-sql-injection",
    title: "Route runs a SQL query built from request input",
    description:
      "An HTTP route handler, or a project function it calls, puts request values into the text of a SQL query. A request can read or change any data the connection can reach.",
    severity: "high",
    owasp: [],
    cwe: [89],
    remediation:
      "Use parameterised queries: fixed SQL with placeholders (`?`, `%s`, `$1`, `:name`) and the request values passed separately.",
  },
  {
    id: "PLG804",
    name: "route-ssrf",
    title: "Route requests a URL whose host comes from request input",
    description:
      "An HTTP route handler, or a project function it calls, fetches or opens a URL whose scheme or host the request decides. A request can make the server reach internal services, cloud metadata endpoints or other hosts with its network position.",
    severity: "high",
    owasp: [],
    cwe: [918],
    remediation:
      "Allow only known hosts, resolve the host and reject private, loopback and link-local addresses, disable redirects to other hosts, and keep the server's credentials out of requests the client shapes.",
  },
  {
    id: "PLG805",
    name: "route-code-injection",
    title: "Route evaluates request input as code",
    description:
      "An HTTP route handler, or a project function it calls, evaluates request input as code (`eval`, `exec`, `Function`, `vm`, a dynamic import). Anyone who can send the request can run code in the server's process.",
    severity: "critical",
    owasp: [],
    cwe: [94, 95],
    remediation:
      "Do not evaluate request input. Parse the narrow format the route needs (JSON, `ast.literal_eval`, an expression parser), or run untrusted code in an isolated sandbox with no credentials or network.",
  },
  {
    id: "PLG806",
    name: "route-template-injection",
    title: "Route renders request input as a template",
    description:
      "An HTTP route handler, or a project function it calls, compiles request input as a template (`render_template_string`, `jinja2.Template`, `ejs.render`, `handlebars.compile`). Template expressions can read the server's objects and run code.",
    severity: "critical",
    owasp: [],
    cwe: [1336, 94],
    remediation:
      "Keep templates fixed and pass request values as template variables. If users must write templates, use a sandboxed engine (`jinja2.sandbox.SandboxedEnvironment`) or a logic-less format.",
  },
  {
    id: "PLG807",
    name: "route-unsafe-deserialization",
    title: "Route deserializes request input with a loader that can run code",
    description:
      "An HTTP route handler, or a project function it calls, loads request data, or data from a location the request chooses, with a deserializer that can run code (`pickle`, `yaml.unsafe_load`, `torch.load`, `node-serialize`).",
    severity: "high",
    owasp: [],
    cwe: [502],
    remediation:
      "Use a data-only format (JSON, `yaml.safe_load`, `safetensors`, `torch.load(weights_only=True)`) for anything a client sends or names.",
  },

  // Library scans (`--library`): parameters of a package's public functions as input.
  {
    id: "PLG901",
    name: "library-command-injection",
    title: "Public function runs a command built from its parameters",
    description:
      "In a library scan, a public function or method, or a project function it calls, builds a shell command, names the program to run or passes program arguments from its parameters. A caller that passes untrusted text (a request field, a document, model output) lets that text run commands. Whether callers do is outside the scan.",
    severity: "critical",
    owasp: [],
    cwe: [78, 77, 88],
    remediation:
      "Run a fixed program with an argument list and no shell, check each argument against an allow-list or a strict pattern, put `--` before positional arguments, and document which parameters must be trusted.",
  },
  {
    id: "PLG902",
    name: "library-path-traversal",
    title: "Public function accesses a file path built from its parameters",
    description:
      'In a library scan, a public function or method joins a parameter below a base path, or reads a path from inside a parameter (`config["template_path"]`, `element.path`), and reads, writes or deletes that file. A value with `..` or an absolute path reaches files outside the base. A path the caller passes whole is the caller\'s choice and is not reported.',
    severity: "high",
    owasp: [],
    cwe: [22, 73],
    remediation:
      "Resolve the path and check that it stays inside the base (`is_relative_to`, or a prefix that ends with a separator), or accept only names that match a strict pattern.",
  },
  {
    id: "PLG903",
    name: "library-sql-injection",
    title: "Public function runs SQL text built from its parameters",
    description:
      "In a library scan, a public function or method puts parameter values into the text of a SQL query, or runs a parameter as SQL. A caller that passes untrusted values (a filter, a table name, model output) lets them read or change any data the connection can reach.",
    severity: "high",
    owasp: [],
    cwe: [89],
    remediation:
      "Pass values as placeholders, check identifiers such as table and column names against a fixed set, and document parameters that run as SQL.",
  },
  {
    id: "PLG904",
    name: "library-ssrf",
    title: "Public function requests a URL whose host comes from inside its parameters",
    description:
      "In a library scan, a public function or method fetches or opens a URL whose scheme or host it reads from inside a parameter (`element.url`, `form_data.url`, a link in a message), not from a URL the caller passes whole. A caller that passes untrusted data lets it reach internal services and cloud metadata endpoints.",
    severity: "high",
    owasp: [],
    cwe: [918],
    remediation:
      "Allow only known hosts, or resolve the host and reject private, loopback and link-local addresses, and refuse redirects to other hosts.",
  },
  {
    id: "PLG905",
    name: "library-code-injection",
    title: "Public function evaluates its parameters as code",
    description:
      "In a library scan, a public function or method evaluates a parameter as code (`eval`, `exec`, `Function`, `vm`) or imports a module its parameter names. A caller that passes untrusted text, such as model output or a file a user supplied, runs code in its own process.",
    severity: "critical",
    owasp: [],
    cwe: [94, 95],
    remediation:
      "Parse the narrow format the function needs (`ast.literal_eval`, JSON, an expression parser), run untrusted code in an isolated sandbox, or check module names against a fixed set.",
  },
  {
    id: "PLG906",
    name: "library-template-injection",
    title: "Public function compiles its parameters as a template",
    description:
      "In a library scan, a public function or method compiles a parameter as a template with an engine that can run code (`jinja2.Template`, `ejs.render`, `handlebars.compile`). A template from an untrusted source, such as a shared prompt or a user's file, can read the process's objects and run code.",
    severity: "critical",
    owasp: [],
    cwe: [1336, 94],
    remediation:
      "Compile templates that callers pass in a sandboxed environment (`jinja2.sandbox.SandboxedEnvironment`), or use a logic-less format.",
  },
  {
    id: "PLG907",
    name: "library-unsafe-deserialization",
    title: "Public function deserializes its parameters with a loader that can run code",
    description:
      "In a library scan, a public function or method loads parameter data, or a file at a path its parameter gives, with a deserializer that can run code (`pickle`, `torch.load`, `yaml.unsafe_load`, `node-serialize`). A caller that passes untrusted data or a downloaded file runs code.",
    severity: "high",
    owasp: [],
    cwe: [502],
    remediation:
      "Use a data-only format (JSON, `yaml.safe_load`, `safetensors`) for data and files that callers pass.",
  },
];

export const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));
