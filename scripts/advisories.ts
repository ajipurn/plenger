// Measures the static rules on reviewed security advisories of AI and agent projects:
// each advisory's vulnerable commit and its fix, cloned shallow and scanned read-only.
// Developer-only; the CLI never runs it, and no downloaded code is run.
// Usage: node scripts/advisories.ts select [--manifest <file>]
//          Queries the GitHub advisory database through `gh` and writes the manifest.
//        node scripts/advisories.ts run [--manifest <file>] [--cache <dir>]
//          [--only <GHSA id>]... [--concurrency <n>] [--output <file.md>] [--json <file>]
//          [--library]
//          Downloads, for both commits of every advisory, the source files in and below
//          the directories the fix changed, scans them and reports detection on the code
//          the fix changed. Needs `gh` for the GitHub API until the cache holds every
//          advisory. --library scans in the engine's library mode.

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import type { Span as FactSpan } from "../src/facts/model.ts";
import { RULE_BY_ID } from "../src/rules/catalog.ts";
import type { Finding } from "../src/rules/model.ts";
import { scan } from "../src/scan.ts";
import { sameWeakness } from "./lib/evaluation.ts";

const run = promisify(execFile);

/** The projects whose advisories are measured, by registry. */
const PACKAGES: Record<"pip" | "npm", string[]> = {
  pip: [
    "langchain",
    "langchain-community",
    "langchain-experimental",
    "langchain-core",
    "llama-index",
    "llama-index-core",
    "litellm",
    "gradio",
    "mlflow",
    "open-webui",
    "langflow",
    "lollms",
    "crewai",
    "pyautogen",
    "autogen-agentchat",
    "farm-haystack",
    "haystack-ai",
    "chainlit",
    "composio-core",
    "h2ogpt",
    "vllm",
    "bentoml",
    "superagi",
    "gpt-researcher",
    "agentscope",
    "letta",
    "fschat",
    "dbgpt",
    "pandasai",
    "vanna",
    "guardrails-ai",
    "promptflow",
    "semantic-kernel",
    "openai-agents",
    "smolagents",
    "camel-ai",
    "metagpt",
    "browser-use",
    "mcp",
    "fastmcp",
  ],
  npm: [
    "flowise",
    "flowise-components",
    "langchain",
    "@langchain/community",
    "@langchain/core",
    "n8n",
    "n8n-nodes-base",
    "@modelcontextprotocol/sdk",
    "ai",
    "librechat",
    "@mastra/core",
    "mcp-remote",
  ],
};
/** The weaknesses the static rules look for. */
const TARGET_CWES = new Set([22, 23, 24, 29, 36, 59, 73, 77, 78, 88, 89, 94, 95, 502, 918]);
const SOURCE = /\.(?:py|js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const TEST =
  /(?:^|\/)(?:tests?|__tests__|spec|e2e|cypress)(?:\/|$)|[._-](?:test|spec)\.[a-z]+$|(?:^|\/)test_[^/]+\.py$/;
/** The largest fix measured: beyond this, the changed code says little about where the flaw was. */
const MAX_FILES = 6;
const MAX_LINES = 400;

interface Advisory {
  ghsa: string;
  cve: string | null;
  ecosystem: "pip" | "npm";
  package: string;
  published: string;
  cwes: string[];
  summary: string;
  repository: string;
  fix: string;
  parent: string;
  files: string[];
}

interface Manifest {
  selected: string;
  rule: string;
  advisories: Advisory[];
}

const { positionals, values } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  allowPositionals: true,
  options: {
    manifest: { type: "string" },
    cache: { type: "string" },
    only: { type: "string", multiple: true },
    concurrency: { type: "string" },
    output: { type: "string" },
    json: { type: "string" },
    library: { type: "boolean" },
  },
});
const manifestPath = values.manifest ?? "test/fixtures/advisories/manifest.json";

async function select(): Promise<void> {
  const advisories = new Map<string, Advisory>();
  for (const ecosystem of ["pip", "npm"] as const) {
    for (const name of PACKAGES[ecosystem]) {
      const { stdout } = await run(
        "gh",
        [
          "api",
          `/advisories?ecosystem=${ecosystem}&affects=${encodeURIComponent(name)}&type=reviewed&per_page=100`,
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      for (const item of JSON.parse(stdout) as Record<string, unknown>[]) {
        const ghsa = String(item.ghsa_id);
        const cwes = ((item.cwes as { cwe_id: string }[] | null) ?? []).map((cwe) => cwe.cwe_id);
        const commits = ((item.references as string[] | null) ?? []).flatMap((url) => {
          const match = /github\.com\/([^/]+\/[^/]+)\/commit\/([0-9a-f]{7,40})/.exec(url);
          return match ? [{ repository: match[1] as string, sha: match[2] as string }] : [];
        });
        const targeted = cwes.some((cwe) => TARGET_CWES.has(Number(cwe.slice(4))));
        if (advisories.has(ghsa) || !targeted || commits.length !== 1) continue;
        const [{ repository, sha }] = commits as [{ repository: string; sha: string }];
        const { stdout: body } = await run("gh", ["api", `repos/${repository}/commits/${sha}`], {
          maxBuffer: 64 * 1024 * 1024,
        }).catch(() => ({ stdout: "null" }));
        const commit = JSON.parse(body) as {
          sha: string;
          parents: { sha: string }[];
          files?: { filename: string; status: string; additions: number; deletions: number }[];
        } | null;
        if (commit === null || commit.parents.length !== 1) continue;
        const files = (commit.files ?? []).filter(
          (file) => SOURCE.test(file.filename) && !TEST.test(file.filename),
        );
        const lines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
        if (
          files.length === 0 ||
          files.length > MAX_FILES ||
          lines > MAX_LINES ||
          !files.some((file) => file.status === "modified")
        )
          continue;
        advisories.set(ghsa, {
          ghsa,
          cve: (item.cve_id as string | null) ?? null,
          ecosystem,
          package: name,
          published: String(item.published_at),
          cwes,
          summary: String(item.summary),
          repository,
          fix: commit.sha,
          parent: (commit.parents[0] as { sha: string }).sha,
          files: files.filter((file) => file.status === "modified").map((file) => file.filename),
        });
      }
    }
  }
  const manifest: Manifest = {
    selected: new Date().toISOString().slice(0, 10),
    rule: `Reviewed GitHub advisories for the listed packages, with a CWE among ${[...TARGET_CWES].map((id) => `CWE-${id}`).join(", ")}, exactly one fix commit on GitHub with one parent, changing 1 to ${MAX_FILES} Python, JavaScript or TypeScript source files outside tests (at most ${MAX_LINES} lines), one of them modified.`,
    advisories: [...advisories.values()].sort((a, b) => a.ghsa.localeCompare(b.ghsa)),
  };
  await mkdir(join(manifestPath, ".."), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.advisories.length} advisories written to ${manifestPath}.`);
}

interface Version {
  /** Rules of the advisory's weakness family citing the code the fix changed. */
  matched: string[];
  /** Any rule citing that code. */
  cited: string[];
  /** Findings anywhere in the scanned files, by rule. */
  findings: Record<string, number>;
}

interface Outcome {
  ghsa: string;
  cve: string | null;
  package: string;
  cwes: string[];
  vulnerable?: Version;
  fixed?: Version;
  error?: string;
}

async function measure(): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const cache = values.cache ?? join(tmpdir(), "plenger-advisories");
  const only = new Set(values.only ?? []);
  const selected = manifest.advisories.filter((item) => only.size === 0 || only.has(item.ghsa));
  // Advisories are measured a few at a time: downloads wait on the network, not the CPU.
  const outcomes: Outcome[] = new Array(selected.length);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const index = next++;
      const advisory = selected[index] as Advisory;
      process.stderr.write(
        `[${index + 1}/${selected.length}] ${advisory.ghsa} ${advisory.package}\n`,
      );
      outcomes[index] = await measureOne(advisory, cache);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency ?? 4) }, worker));
  const report = format(manifest, outcomes);
  if (values.output) await writeFile(values.output, report);
  else console.log(report);
  if (values.json) await writeFile(values.json, `${JSON.stringify(outcomes, null, 2)}\n`);
}

async function measureOne(advisory: Advisory, cache: string): Promise<Outcome> {
  const outcome: Outcome = {
    ghsa: advisory.ghsa,
    cve: advisory.cve,
    package: advisory.package,
    cwes: advisory.cwes,
  };
  const trees = join(cache, advisory.ghsa);
  try {
    const hunks = await changedHunks(advisory, trees);
    const versions = { vulnerable: advisory.parent, fixed: advisory.fix } as const;
    for (const [version, sha] of Object.entries(versions) as [keyof typeof versions, string][]) {
      const root = join(trees, version);
      await downloadOnce(advisory, version, sha, root, join(trees, "vulnerable"));
      const scanned = await scan(root, { facts: true, library: values.library === true });
      const result: Version = { matched: [], cited: [], findings: {} };
      for (const finding of scanned.findings)
        result.findings[finding.rule] = (result.findings[finding.rule] ?? 0) + 1;
      for (const file of advisory.files) {
        const facts = scanned.files.find((item) => item.path === file)?.facts;
        const labels = labelSpans(
          hunks.get(file)?.map((hunk) => (version === "vulnerable" ? hunk.old : hunk.new)) ?? [],
          facts?.definitions.map((definition) => definition.span) ?? [],
        );
        for (const finding of scanned.findings) {
          if (!cites(finding, file, labels)) continue;
          result.cited.push(finding.rule);
          if (sameFamily(finding.rule, advisory.cwes)) result.matched.push(finding.rule);
        }
      }
      result.matched = [...new Set(result.matched)].sort();
      result.cited = [...new Set(result.cited)].sort();
      outcome[version] = result;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome.error = (message.split("\n")[0] ?? message).slice(0, 200);
  }
  return outcome;
}

/**
 * Downloads a version's files once into the cache: the source files around the changed
 * files for the vulnerable version, and only the changed files over a copy of it for the
 * fix. A finished download leaves a marker, so later runs scan the same files offline.
 */
async function downloadOnce(
  advisory: Advisory,
  version: "vulnerable" | "fixed",
  sha: string,
  root: string,
  vulnerable: string,
): Promise<void> {
  const marker = join(root, "..", `${version}.done`);
  if (await exists(marker)) return;
  let files = advisory.files;
  if (version === "vulnerable") {
    const listed = new Set<string>();
    const dirs = new Set(advisory.files.map((file) => file.split("/").slice(0, -1).join("/")));
    for (const dir of dirs) for (const file of await sourceFiles(advisory, dir)) listed.add(file);
    for (const file of advisory.files) listed.add(file);
    files = [...listed];
  }
  await download(
    advisory.repository,
    sha,
    files,
    root,
    version === "fixed" ? vulnerable : undefined,
  );
  await writeFile(marker, `${files.length} files\n`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** How deep below a changed file's directory source files are taken, and how many. */
const SCOPE = { depth: 2, files: 150 };

/**
 * The source files around a changed file: its directory and the directories below it,
 * listed through the GitHub contents API at the fix's parent.
 */
async function sourceFiles(advisory: Advisory, dir: string): Promise<string[]> {
  const found: string[] = [];
  const pending: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const { stdout } = await run(
      "gh",
      [
        "api",
        `repos/${advisory.repository}/contents/${encodeURI(next.path)}?ref=${advisory.parent}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const entries = JSON.parse(stdout) as { type: string; path: string; size: number }[];
    for (const entry of entries) {
      if (entry.type === "file" && SOURCE.test(entry.path) && entry.size < 1_000_000)
        found.push(entry.path);
      if (entry.type === "dir" && next.depth < SCOPE.depth && !SKIPPED_DIR.test(entry.path))
        pending.push({ path: entry.path, depth: next.depth + 1 });
    }
    if (found.length >= SCOPE.files) break;
  }
  return found.slice(0, SCOPE.files);
}

/** Directories that hold dependencies, builds or tests rather than the project's code. */
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|dist|build|\.git|__pycache__|tests?|__tests__)$/;

/**
 * Writes `files` of a commit under `root` from raw.githubusercontent.com, copying the
 * other `all` files from `base` when given. Nothing downloaded is run.
 */
async function download(
  repository: string,
  sha: string,
  files: string[],
  root: string,
  base: string | undefined,
): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  if (base !== undefined) await cp(base, root, { recursive: true });
  let index = 0;
  const worker = async () => {
    while (index < files.length) {
      const file = files[index++] as string;
      const response = await fetch(
        `https://raw.githubusercontent.com/${repository}/${sha}/${encodeURI(file)}`,
      );
      const target = join(root, file);
      if (response.status === 404) {
        await rm(target, { force: true });
        continue;
      }
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

interface Hunk {
  old: FactSpan;
  new: FactSpan;
}

/** The line ranges each changed file's hunks cover, before and after the fix, from the commit's patch. */
async function changedHunks(advisory: Advisory, trees: string): Promise<Map<string, Hunk[]>> {
  const saved = join(trees, "commit.json");
  let stdout: string;
  if (await exists(saved)) stdout = await readFile(saved, "utf8");
  else {
    ({ stdout } = await run("gh", ["api", `repos/${advisory.repository}/commits/${advisory.fix}`], {
      maxBuffer: 64 * 1024 * 1024,
    }));
    await mkdir(trees, { recursive: true });
    await writeFile(saved, stdout);
  }
  const commit = JSON.parse(stdout) as { files?: { filename: string; patch?: string }[] };
  const result = new Map<string, Hunk[]>();
  for (const file of commit.files ?? []) {
    if (!advisory.files.includes(file.filename)) continue;
    const hunks: Hunk[] = [];
    for (const match of (file.patch ?? "").matchAll(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm,
    )) {
      const span = (start: string, count: string | undefined): FactSpan => {
        const line = Math.max(Number(start), 1);
        const lines = count === undefined ? 1 : Number(count);
        return { line, column: 1, endLine: Math.max(line + lines - 1, line), endColumn: 1 };
      };
      hunks.push({
        old: span(match[1] as string, match[2]),
        new: span(match[3] as string, match[4]),
      });
    }
    result.set(file.filename, hunks);
  }
  return result;
}

/**
 * The code a fix changed in one version: the innermost function around each hunk, or the
 * hunk with three lines on each side when it is at module level.
 */
function labelSpans(hunks: FactSpan[], definitions: FactSpan[]): FactSpan[] {
  return hunks.map((hunk) => {
    const around = definitions
      .filter((span) => span.line <= hunk.line && span.endLine >= hunk.endLine)
      .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
    return (
      around ?? {
        line: Math.max(hunk.line - 3, 1),
        column: 1,
        endLine: hunk.endLine + 3,
        endColumn: 1,
      }
    );
  });
}

/** Whether a finding's location or an evidence step lies in the labeled code. */
function cites(finding: Finding, path: string, labels: FactSpan[]): boolean {
  const steps = [finding.location, ...finding.evidence.map((step) => step.location)];
  return steps.some(
    (step) =>
      step.path === path &&
      labels.some((label) => step.line <= label.endLine && step.endLine >= label.line),
  );
}

/** Whether a rule's CWE mapping names one of the advisory's weaknesses or its family. */
function sameFamily(rule: string, cwes: string[]): boolean {
  const mapped = RULE_BY_ID.get(rule)?.cwe ?? [];
  return cwes.some((cwe) => mapped.some((id) => sameWeakness(cwe, `CWE-${id}`)));
}

function format(manifest: Manifest, outcomes: Outcome[]): string {
  const measured = outcomes.filter((item) => item.vulnerable && item.fixed);
  const detected = measured.filter((item) => (item.vulnerable?.matched.length ?? 0) > 0);
  const cleared = detected.filter((item) => (item.fixed?.matched.length ?? 0) === 0);
  const flagged = measured.filter((item) => (item.fixed?.matched.length ?? 0) > 0);
  const families: [string, number[]][] = [
    ["Path traversal", [22, 23, 24, 29, 36, 59, 73]],
    ["Command injection", [77, 78, 88]],
    ["SQL injection", [89]],
    ["Code injection", [94, 95]],
    ["Deserialization", [502]],
    ["SSRF", [918]],
  ];
  const familyOf = (item: Outcome) =>
    families.find(([, ids]) => item.cwes.some((cwe) => ids.includes(Number(cwe.slice(4)))))?.[0] ??
    "Other";
  const lines = [
    `# Static rules on security advisories, ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Manifest selected ${manifest.selected}: ${manifest.rule}`,
    "",
    ...(values.library
      ? [
          "Library scan: the parameters of public functions and methods count as untrusted input (library mode).",
          "",
        ]
      : []),
    "A version counts as reported when a rule of the advisory's weakness family cites the code the fix changed: the innermost function around each changed hunk.",
    "",
    "| Advisories | Measured | Reported before the fix | Not reported after it | Still reported after the fix |",
    "| --- | --- | --- | --- | --- |",
    `| ${outcomes.length} | ${measured.length} | ${detected.length} | ${cleared.length} | ${flagged.length} |`,
    "",
    "| Weakness | Measured | Reported before the fix | Still reported after it |",
    "| --- | --- | --- | --- |",
    ...[...families.map(([name]) => name), "Other"].flatMap((name) => {
      const group = measured.filter((item) => familyOf(item) === name);
      if (group.length === 0) return [];
      const found = group.filter((item) => (item.vulnerable?.matched.length ?? 0) > 0).length;
      const still = group.filter((item) => (item.fixed?.matched.length ?? 0) > 0).length;
      return [`| ${name} | ${group.length} | ${found} | ${still} |`];
    }),
    "",
    "| Advisory | Package | CWE | Before the fix | After the fix | Other rules citing the change |",
    "| --- | --- | --- | --- | --- | --- |",
    ...outcomes.map((item) => {
      const id = item.cve ? `${item.ghsa} (${item.cve})` : item.ghsa;
      if (item.error)
        return `| ${id} | ${item.package} | ${item.cwes.join(", ")} | error: ${item.error.replace(/\|/g, "/")} | | |`;
      const other = [...new Set([...(item.vulnerable?.cited ?? []), ...(item.fixed?.cited ?? [])])]
        .filter(
          (rule) => !item.vulnerable?.matched.includes(rule) && !item.fixed?.matched.includes(rule),
        )
        .join(", ");
      return `| ${id} | ${item.package} | ${item.cwes.join(", ")} | ${item.vulnerable?.matched.join(", ") || "none"} | ${item.fixed?.matched.join(", ") || "none"} | ${other || "none"} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

if (positionals[0] === "select") await select();
else if (positionals[0] === "run") await measure();
else throw new Error("Use `select` or `run`.");
