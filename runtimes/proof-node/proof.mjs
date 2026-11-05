// Proof test worker (docs/design/proof-tests.md). Stages one test file and a copy of the
// project in a networkless container, runs each case in its own process (case.mjs) and
// reports what the harness observed. The host decides the outcome.
import { spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

// Frame version from docs/design/worker-protocol.md; matches WORKER_PROTOCOL_VERSION.
const PROTOCOL_VERSION = 2;
const CASE_MS = 20_000;
const PROJECT = "/tmp/project";
const ROOT = "/tmp/proof";
const BASE = `${ROOT}/base`;
const TEST = `${ROOT}/test/test_proof.mjs`;
const EFFECTS = `${ROOT}/effects`;
const PACKAGES = ["ai", "express", "zod"];
const LIMITS = { request: 6 * 1024 * 1024, output: 8192 };
const WEAKNESSES = ["CWE-22", "CWE-78"];

// A host that died cannot stop this worker; exit at 70 s, after the host's 60 s.
setTimeout(() => process.exit(124), 70_000).unref();

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function receive() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const newline = chunk.indexOf(10);
    chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
    bytes += chunk.length;
    if (bytes > LIMITS.request + 1) throw new Error("request limit");
    if (newline !== -1) break;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isolation(hostMarker) {
  const checks = [];
  function check(name, ok) {
    if (!ok) throw new Error(`isolation:${name}`);
    checks.push(name);
  }
  const status = readFileSync("/proc/self/status", "utf8");
  const cgroup = (name) => readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim();
  check("linux", process.platform === "linux");
  check("node-version", process.versions.node === "22.23.4");
  check("non-root", process.getuid() === 65532);
  check("no-capabilities", /CapEff:\s*0+\s/.test(status));
  check("no-new-privileges", /NoNewPrivs:\s*1/.test(status));
  check("seccomp-filter", /Seccomp:\s*2/.test(status));
  check(
    "loopback-only",
    Object.keys(networkInterfaces()).every((name) => name === "lo"),
  );
  let denied = false;
  try {
    writeFileSync("/opt/plenger/probe", "x");
  } catch {
    denied = true;
  }
  check("read-only-root", denied);
  check("memory-limit", Number(cgroup("memory.max")) <= 268435456);
  check("no-swap", cgroup("memory.swap.max") === "0");
  check("process-limit", Number(cgroup("pids.max")) <= 64);
  const [quota, period] = cgroup("cpu.max").split(" ").map(Number);
  check("cpu-limit", quota / period <= 1);
  check("no-host-file", !existsSync(hostMarker));
  check(
    "no-host-environment",
    !process.env.PLENGER_HOST_SENTINEL &&
      !process.env.GOOGLE_GENERATIVE_AI_API_KEY &&
      !process.env.OPENAI_API_KEY,
  );
  check(
    "no-container-socket",
    !existsSync("/var/run/docker.sock") && !existsSync("/run/podman/podman.sock"),
  );
  writeFileSync("/tmp/plenger-check", "x", { mode: 0o600 });
  check("private-temporary-files", (statSync("/tmp/plenger-check").mode & 0o777) === 0o600);
  rmSync("/tmp/plenger-check");
  return checks;
}

function safePath(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 512 &&
    !name.startsWith("/") &&
    name.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."))
  );
}

function ranges(value, paths) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new Error("ranges");
  for (const item of value)
    if (
      !paths.has(item?.path) ||
      !Number.isSafeInteger(item.line) ||
      !Number.isSafeInteger(item.endLine) ||
      item.line < 1 ||
      item.endLine < item.line
    )
      throw new Error("range");
  return value;
}

function walk(folder, visit) {
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    const info = lstatSync(path);
    visit(path, info);
    if (info.isDirectory()) walk(path, visit);
  }
}

function digest() {
  const hash = createHash("sha256");
  walk(PROJECT, (path, info) => {
    if (path === `${PROJECT}/node_modules`) return;
    hash.update(`${path}\0${info.isSymbolicLink() ? "link" : info.isFile() ? "file" : "dir"}\0`);
    if (info.isFile()) hash.update(readFileSync(path));
  });
  return hash.digest("hex");
}

/** Write the sources read-only, replacing whatever a case left in the folder. */
function stage(sources) {
  if (existsSync(PROJECT)) {
    chmodSync(PROJECT, 0o700);
    walk(PROJECT, (path, info) => {
      if (info.isDirectory()) chmodSync(path, 0o700);
    });
    rmSync(PROJECT, { recursive: true, force: true });
  }
  mkdirSync(PROJECT, { mode: 0o700 });
  for (const source of sources) {
    const path = join(PROJECT, source.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, source.content, { mode: 0o400, flag: "wx" });
  }
  // Project imports resolve the packages of the image.
  symlinkSync("/opt/plenger/node_modules", `${PROJECT}/node_modules`);
  walk(PROJECT, (path, info) => {
    if (info.isDirectory()) chmodSync(path, 0o500);
  });
  chmodSync(PROJECT, 0o500);
}

function runCase(name, config) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "/opt/plenger/case.mjs", name],
      {
        cwd: BASE,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: { HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    const output = [];
    let outputBytes = 0;
    const result = [];
    let resultBytes = 0;
    let timedOut = false;
    const keep = (chunk) => {
      if (outputBytes < LIMITS.output) output.push(chunk);
      outputBytes += chunk.length;
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.stdio[3].on("data", (chunk) => {
      resultBytes += chunk.length;
      if (resultBytes <= 1024 * 1024) result.push(chunk);
    });
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, CASE_MS);
    child.on("close", () => {
      clearTimeout(timer);
      kill();
      const text = Buffer.concat(output).toString("utf8").slice(0, LIMITS.output);
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.concat(result).toString("utf8"));
      } catch {
        parsed = null;
      }
      if (timedOut || parsed === null || typeof parsed !== "object")
        resolve({
          status: timedOut ? "timeout" : "error",
          failedAt: timedOut ? null : "test",
          error: timedOut ? null : "The case ended without a result.",
          output: text,
          effects: [],
          effectsDropped: 0,
          reached: {},
          replaced: [],
        });
      else resolve({ ...parsed, output: text });
    });
    child.stdin.end(JSON.stringify(config));
  });
}

async function main() {
  const request = await receive();
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error("protocol version");
  const isolationChecks = isolation(request.hostMarker);
  const packages = Object.fromEntries(
    PACKAGES.map((name) => [
      name,
      JSON.parse(readFileSync(`/opt/plenger/node_modules/${name}/package.json`, "utf8")).version,
    ]),
  );
  emit({
    type: "ready",
    protocolVersion: PROTOCOL_VERSION,
    node: process.versions.node,
    packages,
    isolationChecks,
  });
  const { marker, sources, test, weakness } = request;
  if (typeof marker !== "string" || !/^PLENGER_[a-f0-9]{32}$/.test(marker))
    throw new Error("marker");
  if (!WEAKNESSES.includes(weakness)) throw new Error("weakness");
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some((item) => !safePath(item?.path) || typeof item.content !== "string")
  )
    throw new Error("sources");
  const paths = new Set(sources.map((item) => item.path));
  if (paths.size !== sources.length || paths.has("node_modules")) throw new Error("duplicate");
  if (sources.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) > 4 * 1024 * 1024)
    throw new Error("source limit");
  const entry = ranges(request.entry, paths);
  const cited = ranges(request.cited, paths);
  if (typeof test !== "string" || Buffer.byteLength(test) > 16384) throw new Error("test");

  stage(sources);
  const expected = digest();
  mkdirSync(`${ROOT}/test`, { recursive: true, mode: 0o700 });
  writeFileSync(TEST, test, { mode: 0o400 });
  mkdirSync(BASE, { mode: 0o700 });
  mkdirSync(EFFECTS, { mode: 0o700 });
  const guarded = [`${ROOT}/outside-${marker}`, `${ROOT}/base-${marker}`];
  const first = randomInt(1000, 10000);
  const second = randomInt(1000, 10000);
  const effect = `${EFFECTS}/${marker}`;
  const command = `echo $((${first}+${second}))>${effect}`;
  const config = {
    marker,
    weakness,
    guarded,
    canary: `${guarded[0]}/canary.txt`,
    sibling: `${guarded[1]}/canary.txt`,
    payloads: [
      `;${command}`,
      `$(${command})`,
      `\`${command}\``,
      `|${command}`,
      `&&${command}`,
      `||${command}`,
      `\n${command}\n`,
    ],
    watched: [...new Set([...entry, ...cited].map((item) => item.path))].sort(),
  };
  for (const name of ["intended", "weakness"]) {
    for (const folder of guarded) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(`${folder}/canary.txt`, `canary ${marker}\n`);
    }
    const result = await runCase(name, config);
    let canary = false;
    try {
      canary = readFileSync(effect, "utf8").slice(0, 64).trim() === String(first + second);
      rmSync(effect);
    } catch {
      // No canary.
    }
    const replaced = Array.isArray(result.replaced) ? result.replaced : [];
    if (digest() !== expected) {
      replaced.push("project files");
      stage(sources);
    }
    emit({
      type: "case",
      name,
      status: result.status,
      failedAt: result.failedAt,
      error: result.error,
      output: result.output,
      effects: result.effects,
      effectsDropped: result.effectsDropped,
      reached: result.reached,
      replaced: replaced.slice(0, 64),
      canary,
    });
  }
  emit({ type: "finished", completed: true });
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`proof worker failed: ${String(error?.message ?? error).slice(0, 200)}\n`);
    process.exit(1);
  },
);
