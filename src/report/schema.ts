/** JSON Schema draft 7 contracts. Regenerate the checked-in schemas with scripts/report-schemas.ts. */
type Schema = Record<string, unknown>;
const text: Schema = { type: "string" };
const boolean: Schema = { type: "boolean" };
const natural: Schema = { type: "integer", minimum: 0 };
const positive: Schema = { type: "integer", minimum: 1 };
const yes: Schema = { const: true };
const fingerprint: Schema = { type: "string", pattern: "^[0-9a-f]{16}$" };
const ruleId: Schema = { type: "string", pattern: "^PLG[0-9]{3}$" };
const severity = choices("critical", "high", "medium", "low");
const confidence = choices("high", "medium", "low");
/** `GuardFact["test"]` in src/facts/model.ts. */
const guardTest = choices(
  "matches",
  "fullmatches",
  "excludes",
  "within",
  "inside",
  "relative",
  "descends",
  "differs",
  "ends",
  "call",
);
const texts = array(text);
const locations = array(ref("location"));
const parts = array(ref("dynamicPart"));
const capabilities = array(ref("capability"));
const values = array(ref("value"));

function choices(...items: string[]): Schema {
  return { type: "string", enum: items };
}
function array(items: Schema): Schema {
  return { type: "array", items };
}
function nullable(value: Schema): Schema {
  return { anyOf: [value, { type: "null" }] };
}
function ref(name: string): Schema {
  return { $ref: `#/definitions/${name}` };
}
function object(required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema {
  return {
    type: "object",
    additionalProperties: false,
    properties: { ...required, ...optional },
    required: Object.keys(required),
  };
}
function document(title: string, body: Schema, definitions?: Record<string, Schema>): Schema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title,
    ...body,
    ...(definitions ? { definitions } : {}),
  };
}

const span = { line: positive, column: positive, endLine: positive, endColumn: positive };
const item = { id: text, framework: text, location: ref("location") };
const definitionSpan = { scope: nullable(text), span: ref("span") };
const projectLinks = {
  file: text,
  origin: object({ path: text, assignment: natural }),
  constant: ref("value"),
};
const definitions: Record<string, Schema> = {
  span: object(span),
  location: object({ path: text, ...span }),
  traceGaps: object({ depthLimited: natural, dynamic: natural, locations }),
  dynamicPart: object(
    { text, source: choices("param", "name", "call", "other") },
    { ref: text, from: texts, calls: texts, callSites: texts, path: yes },
  ),
  capability: object(
    {
      kind: choices(
        "process",
        "code",
        "file_read",
        "file_write",
        "file_delete",
        "network",
        "database",
        "message",
        "payment",
        "secret",
        "deserialize",
        "browser",
        "llm",
        "agent",
        "mcp",
      ),
      target: text,
      location: ref("location"),
      via: locations,
      inputs: parts,
    },
    {
      hosted: yes,
      tool: text,
      command: choices("shell", "program", "arguments"),
      program: parts,
      query: yes,
      template: yes,
      operation: choices("read", "write", "unknown"),
      dataInputs: parts,
      host: parts,
      given: parts,
      sandbox: choices("none", "container", "remote"),
      systemInputs: parts,
      guards: texts,
    },
  ),
  prompt: object(
    {
      id: text,
      location: ref("location"),
      role: choices("system", "user", "template"),
      text,
      dynamic: parts,
      variables: texts,
      usedBy: texts,
    },
    { secret: text, truncated: yes },
  ),
  model: object({
    ...item,
    target: text,
    model: nullable(text),
    baseUrl: nullable(text),
    credential: choices("literal", "placeholder", "environment", "parameter", "default", "other"),
  }),
  llmCall: object({
    ...item,
    target: text,
    scope: nullable(text),
    model: nullable(text),
    client: nullable(text),
    prompts: texts,
    tools: texts,
    unresolvedTools: natural,
    inputs: parts,
    systemInputs: parts,
    outputEffects: capabilities,
  }),
  agent: object(
    {
      ...item,
      target: text,
      name: nullable(text),
      model: nullable(text),
      tools: texts,
      unresolvedTools: natural,
      prompts: texts,
      nodes: array(object({ name: text, handler: nullable(text) }, { handlerPath: text })),
      delegates: texts,
      mcpClients: texts,
      invocations: array(object({ location: ref("location"), inputs: parts })),
      capabilities,
      outputEffects: capabilities,
    },
    { approval: text },
  ),
  tool: object(
    {
      ...item,
      name: text,
      description: nullable(text),
      handler: nullable(text),
      params: texts,
      via: choices(
        "decorator",
        "class",
        "factory",
        "function",
        "builtin",
        "agent",
        "mcp",
        "schema",
      ),
      capabilities,
      server: nullable(text),
    },
    { handlerPath: text, agent: text, approval: text, trace: ref("traceGaps") },
  ),
  mcpMember: object(
    { name: text, handler: nullable(text), location: ref("location") },
    { handlerPath: text },
  ),
  mcpServer: object({
    ...item,
    name: nullable(text),
    transport: nullable(text),
    tools: texts,
    resources: array(ref("mcpMember")),
    prompts: array(ref("mcpMember")),
  }),
  mcpClient: object({ ...item, target: text, command: nullable(text), url: nullable(text) }),
  dataStore: object({
    ...item,
    kind: choices("vector_store", "embeddings", "retriever", "checkpointer", "memory", "database"),
    target: text,
  }),
  entryPoint: object(
    {
      ...item,
      kind: choices("http", "mcp"),
      method: nullable(text),
      path: nullable(text),
      handler: nullable(text),
      reaches: capabilities,
    },
    { handlerPath: text, trace: ref("traceGaps") },
  ),
  inventory: object({
    frameworks: array(object({ id: text, name: text, files: texts })),
    models: array(ref("model")),
    llmCalls: array(ref("llmCall")),
    agents: array(ref("agent")),
    tools: array(ref("tool")),
    mcpServers: array(ref("mcpServer")),
    mcpClients: array(ref("mcpClient")),
    prompts: array(ref("prompt")),
    dataStores: array(ref("dataStore")),
    entryPoints: array(ref("entryPoint")),
    unrecognised: array(object({ module: text, files: texts })),
  }),
  rule: object({
    id: ruleId,
    name: text,
    title: text,
    description: text,
    severity,
    owasp: texts,
    cwe: array(positive),
    remediation: text,
  }),
  finding: object(
    {
      rule: ruleId,
      fingerprint,
      title: text,
      severity,
      confidence,
      score: { type: "number", minimum: 0, maximum: 100 },
      location: ref("location"),
      subject: object(
        {
          kind: choices(
            "tool",
            "agent",
            "llm_call",
            "entry_point",
            "mcp_server",
            "mcp_client",
            "model",
            "prompt",
            "code",
            "function",
            "runtime",
          ),
          name: text,
        },
        { id: text },
      ),
      evidence: array(object({ location: ref("location"), message: text }, { snippet: text })),
      notes: texts,
      exposed: boolean,
    },
    {
      snippet: text,
      baselineState: choices("new", "unchanged"),
      suppression: object({ reason: text }, { inSource: yes }),
      inline: object({ line: positive, reason: text }),
    },
  ),
  ref: {
    oneOf: [
      object({ kind: { const: "import" }, module: text, path: text, name: text }, projectLinks),
      object({ kind: { const: "local" }, definition: text, path: text, name: text }, projectLinks),
      object({ kind: { const: "global" }, path: text, name: text }, projectLinks),
    ],
  },
  value: {
    oneOf: [
      object({ kind: { const: "string" }, value: text }, { template: values, truncated: yes }),
      object({ kind: { const: "concat" }, parts: values }),
      object({ kind: { const: "literal" }, text }),
      object(
        { kind: { const: "name" }, text, ref: nullable(ref("ref")) },
        { param: yes, assignment: natural, base: natural, of: natural },
      ),
      object({ kind: { const: "call" }, call: natural }),
      object({ kind: { const: "function" }, definition: text }),
      object({ kind: { const: "list" }, items: values }, { truncated: yes }),
      object(
        {
          kind: { const: "object" },
          entries: array(object({ key: nullable(text), value: ref("value") })),
        },
        { truncated: yes },
      ),
      object({ kind: { const: "other" }, text }, { parts: values, subscript: yes }),
    ],
  },
  argument: object({ keyword: nullable(text), value: ref("value") }, { spread: yes }),
  decorator: object(
    {
      text,
      ref: nullable(ref("ref")),
      arguments: nullable(array(ref("argument"))),
      span: ref("span"),
    },
    { receiver: natural },
  ),
  facts: object(
    {
      imports: array(
        object({
          module: text,
          imported: nullable(text),
          local: nullable(text),
          kind: choices(
            "module",
            "member",
            "default",
            "namespace",
            "wildcard",
            "side_effect",
            "require",
            "dynamic",
            "reexport",
          ),
          typeOnly: boolean,
          ...definitionSpan,
        }),
      ),
      definitions: array(
        object(
          {
            id: text,
            name: nullable(text),
            kind: choices("function", "method", "class"),
            parent: nullable(text),
            async: boolean,
            exported: boolean,
            params: texts,
            decorators: array(ref("decorator")),
            bases: values,
            doc: nullable(text),
            span: ref("span"),
          },
          {
            returns: values,
            returnSpans: array(ref("span")),
            unpacks: array({
              anyOf: [text, array(object({ name: text, key: nullable(text) }))],
            }),
            injected: texts,
            scalars: texts,
            checks: array(
              object({ subject: ref("value"), allowed: ref("value") }, { test: guardTest }),
            ),
          },
        ),
      ),
      assignments: array(
        object(
          { target: text, value: ref("value"), ...definitionSpan },
          { member: text, mutated: yes },
        ),
      ),
      calls: array(
        object(
          {
            callee: text,
            ref: nullable(ref("ref")),
            new: boolean,
            arguments: array(ref("argument")),
            ...definitionSpan,
          },
          { receiver: natural, object: ref("value"), lookup: ref("value") },
        ),
      ),
    },
    {
      guards: array(
        object(
          {
            scope: nullable(text),
            subject: ref("value"),
            allowed: ref("value"),
            region: ref("span"),
          },
          { test: guardTest },
        ),
      ),
      defaultExport: text,
    },
  ),
};

export const REPORT_SCHEMA = document(
  "plenger report v1",
  object(
    {
      schemaVersion: { const: 1 },
      tool: object({ name: { const: "plenger" }, version: text }),
      root: text,
      files: array(
        object(
          {
            path: text,
            language: choices("python", "javascript", "typescript", "php"),
            bytes: natural,
            lines: natural,
            syntaxErrors: boolean,
          },
          { facts: ref("facts") },
        ),
      ),
      skipped: array(
        object({
          path: text,
          reason: choices(
            "declaration",
            "minified",
            "gitignored",
            "symlink",
            "too_large",
            "unreadable",
            "binary",
            "not_utf8",
          ),
        }),
      ),
      excludedDirs: array(
        object({ path: text, reason: choices("default", "virtualenv", "gitignore") }),
      ),
      truncated: boolean,
      inventory: ref("inventory"),
      findings: array(ref("finding")),
      durationMs: natural,
      rules: array(ref("rule")),
      review: object({ active: natural, suppressed: natural, unchanged: natural, new: natural }),
    },
    {
      library: object({ functions: natural }),
      binaries: array(
        object({
          path: text,
          kind: choices(
            "native library",
            "executable",
            "WebAssembly",
            "JVM bytecode",
            "Python package",
          ),
          bytes: natural,
          sha256: nullable({ type: "string", pattern: "^[0-9a-f]{64}$" }),
        }),
      ),
    },
  ),
  definitions,
);

const BASELINE_SCHEMA = document(
  "plenger baseline v1",
  object({
    schemaVersion: { const: 1 },
    findings: array(object({ fingerprint, rule: ruleId, path: text })),
  }),
);
const SUPPRESSIONS_SCHEMA = document(
  "plenger suppressions v1",
  object({
    schemaVersion: { const: 1 },
    suppressions: array({
      ...object(
        { reason: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" } },
        { fingerprint, rule: ruleId, path: text },
      ),
      anyOf: [{ required: ["fingerprint"] }, { required: ["rule"] }],
    }),
  }),
);

export const REPORT_SCHEMAS = {
  "report-v1.schema.json": REPORT_SCHEMA,
  "baseline-v1.schema.json": BASELINE_SCHEMA,
  "suppressions-v1.schema.json": SUPPRESSIONS_SCHEMA,
};
