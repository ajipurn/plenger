// One proof test case, in its own process. Wraps the file and process APIs before the
// test or the project loads, attributes each watched call to the code that made it,
// records which entry and cited lines ran, and writes its observations to fd 3.
//
// Test code runs in this process. Everything the harness does while or after it runs
// uses functions saved here first, so a test that changes String.prototype or JSON
// cannot change what the harness sees or reports.
import cp from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const uncurry = Function.prototype.call.bind.bind(Function.prototype.call);
const StringStartsWith = uncurry(String.prototype.startsWith);
const StringIncludes = uncurry(String.prototype.includes);
const StringIndexOf = uncurry(String.prototype.indexOf);
const StringSlice = uncurry(String.prototype.slice);
const ArrayJoin = uncurry(Array.prototype.join);
const ArrayIsArray = Array.isArray;
const ObjectKeys = Object.keys;
const ObjectNames = Object.getOwnPropertyNames;
const ObjectDescriptor = Object.getOwnPropertyDescriptor;
const ObjectDescriptors = Object.getOwnPropertyDescriptors;
const ObjectDefineProperties = Object.defineProperties;
const ObjectCreate = Object.create;
const ObjectFreeze = Object.freeze;
const ReflectApply = Reflect.apply;
const JSONStringify = JSON.stringify;
const JSONParse = JSON.parse;
const BufferFrom = Buffer.from;
const BufferIsBuffer = Buffer.isBuffer;
const BufferToString = uncurry(Buffer.prototype.toString);
const MathMax = Math.max;
const MathMin = Math.min;
const NumberIsSafeInteger = Number.isSafeInteger;
const resolvePath = path.resolve;
const baseName = path.basename;
const toFilePath = fileURLToPath;
const realpathSync = fs.realpathSync;
const readFileSync = fs.readFileSync;
const writeSync = fs.writeSync;
const mkdirSync = fs.mkdirSync;
const writeFileSync = fs.writeFileSync;
const capture = Error.captureStackTrace;
const exit = process.exit.bind(process);
const environment = process.env;

const name = process.argv[2];
const config = JSONParse(readFileSync(0, "utf8"));
const PROJECT = "/tmp/project";
const ROOT = "/tmp/proof";
const BASE = `${ROOT}/base`;
const TEST = `${ROOT}/test/test_proof.mjs`;
const EFFECTS = `${ROOT}/effects`;
const HARNESS = "/opt/plenger/";
const LIBRARIES = "/opt/plenger/node_modules/";
const LIMITS = { effects: 32, target: 512, error: 2048 };
const SHELLS = ["sh", "bash", "dash", "zsh"];
const MARKER = config.marker;
const GUARDED = config.guarded;
const PROJECT_URL = `file://${PROJECT}/`;

const effects = [];
const replaced = ObjectCreate(null);
let dropped = 0;
let busy = false;
/** The watched state as the project and its packages left it; null until the test loads. */
let baseline = null;

function clip(text) {
  if (text.length <= LIMITS.target) return text;
  const index = StringIndexOf(text, MARKER);
  const start = index < 0 ? 0 : MathMax(0, MathMin(index - 200, text.length - LIMITS.target));
  return StringSlice(text, start, start + LIMITS.target);
}

function under(target, folder) {
  return target === folder || StringStartsWith(target, `${folder}/`);
}

function guarded(target) {
  for (let index = 0; index < GUARDED.length; index++)
    if (under(target, GUARDED[index])) return true;
  return false;
}

function fileOf(site) {
  const file = site.getFileName?.() ?? site.getScriptNameOrSourceURL?.();
  if (typeof file !== "string") return null;
  if (!StringStartsWith(file, "file://")) return file;
  try {
    return toFilePath(file);
  } catch {
    return null;
  }
}

function kind(file) {
  if (file === null) return "library";
  if (StringStartsWith(file, `${PROJECT}/`) && !StringStartsWith(file, `${PROJECT}/node_modules/`))
    return "project";
  if (file === TEST) return "test";
  if (StringStartsWith(file, LIBRARIES)) return "library";
  if (StringStartsWith(file, HARNESS)) return "harness";
  return "library";
}

/**
 * Innermost non-library kind, innermost and outermost project frames, async frames
 * included. The stack starts at the caller of `skip`, the harness's own wrapper.
 */
function frames(skip) {
  const saved = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  Error.prepareStackTrace = (_, sites) => sites;
  Error.stackTraceLimit = 200;
  const holder = {};
  capture(holder, skip);
  const sites = holder.stack;
  Error.prepareStackTrace = saved;
  Error.stackTraceLimit = limit;
  let first = null;
  let inner = null;
  let outer = null;
  if (!ArrayIsArray(sites)) return { first, inner, outer };
  for (let index = 0; index < sites.length; index++) {
    const file = fileOf(sites[index]);
    const which = kind(file);
    if (which !== "library" && first === null) first = which;
    if (which === "project") {
      const line = sites[index].getLineNumber?.();
      const place = {
        path: StringSlice(file, PROJECT.length + 1),
        line: NumberIsSafeInteger(line) && line > 0 ? line : 1,
      };
      inner ??= place;
      outer = place;
    }
  }
  return { first, inner, outer };
}

// --- Watched state: built-in modules, intrinsics, project exports and the environment.

function allowedPath(value) {
  if (typeof value !== "string") return false;
  try {
    return under(realpathSync(resolvePath(value)), BASE);
  } catch {
    return under(resolvePath(value), BASE);
  }
}

/** Every function an owner holds, keyed by owner and name; accessors by their parts. */
function collect(into, label, owner) {
  if (owner === null || (typeof owner !== "object" && typeof owner !== "function")) return;
  const names = ObjectNames(owner);
  for (let index = 0; index < names.length; index++) {
    const descriptor = ObjectDescriptor(owner, names[index]);
    if (!descriptor) continue;
    const key = `${label}.${names[index]}`;
    if (typeof descriptor.value === "function") into[key] = descriptor.value;
    if (descriptor.get) into[`${key}#get`] = descriptor.get;
    if (descriptor.set) into[`${key}#set`] = descriptor.set;
  }
}

function state(watched, namespaces) {
  const values = ObjectCreate(null);
  for (let index = 0; index < watched.length; index++)
    collect(values, watched[index][0], watched[index][1]);
  for (let index = 0; index < namespaces.length; index++) {
    const where = namespaces[index][0];
    const namespace = namespaces[index][1];
    const keys = ObjectKeys(namespace);
    for (let item = 0; item < keys.length; item++) {
      const value = namespace[keys[item]];
      values[`${where}.${keys[item]}`] = value;
      collect(values, `${where}.${keys[item]}`, value);
    }
  }
  const variables = ObjectKeys(environment);
  for (let index = 0; index < variables.length; index++)
    values[`environment ${variables[index]}`] = environment[variables[index]];
  return values;
}

/** Names whose value differs from the baseline. A setting may point inside base(). */
function drift() {
  if (baseline === null) return [];
  const now = state(baseline.watched, baseline.namespaces);
  const changed = [];
  const check = (key) => {
    if (baseline.values[key] === now[key]) return;
    if (StringStartsWith(key, "environment ") && allowedPath(now[key])) return;
    changed[changed.length] = key;
  };
  const before = ObjectKeys(baseline.values);
  for (let index = 0; index < before.length; index++) check(before[index]);
  const after = ObjectKeys(now);
  for (let index = 0; index < after.length; index++)
    if (!(after[index] in baseline.values)) check(after[index]);
  return changed;
}

function record(effect) {
  // A change that is undone before the case ends still counts while the effect happens.
  const changed = drift();
  for (let index = 0; index < changed.length; index++) replaced[changed[index]] = true;
  if (effects.length < LIMITS.effects) effects[effects.length] = effect;
  else dropped += 1;
}

// --- Wrappers on the file and process APIs.

function toPath(value) {
  if (typeof value === "string") return resolvePath(value);
  if (BufferIsBuffer(value)) return resolvePath(BufferToString(value, "utf8"));
  if (value instanceof URL && value.protocol === "file:") return toFilePath(value);
  return null;
}

const READS = ["readFile", "readFileSync", "createReadStream", "readdir", "readdirSync"];
const TWO_PATHS = ["rename", "copyFile", "cp", "symlink", "link"];
const FILE_FUNCTIONS = [
  "readFile",
  "writeFile",
  "appendFile",
  "open",
  "openAsBlob",
  "createReadStream",
  "createWriteStream",
  "copyFile",
  "cp",
  "rename",
  "unlink",
  "rm",
  "rmdir",
  "mkdir",
  "symlink",
  "link",
  "truncate",
  "readdir",
  "opendir",
  "chmod",
];

function listed(list, value) {
  for (let index = 0; index < list.length; index++) if (list[index] === value) return true;
  return false;
}

function fileCall(operation, args, skip) {
  if (busy) return;
  busy = true;
  try {
    const base = StringIndexOf(operation, "Sync") > 0 ? StringSlice(operation, 0, -4) : operation;
    const targets = [];
    const count = listed(TWO_PATHS, base) ? 2 : 1;
    for (let index = 0; index < count; index++) {
      const target = toPath(args[index]);
      if (target !== null) targets[targets.length] = target;
    }
    if (!targets.length) return;
    const { first, inner, outer } = frames(skip);
    if (first === "harness") return;
    const writes =
      base === "open"
        ? StringIncludes(String(args[1] ?? "r"), "w") ||
          StringIncludes(String(args[1] ?? "r"), "a") ||
          StringIncludes(String(args[1] ?? "r"), "+")
        : !listed(READS, operation) && base !== "opendir" && base !== "openAsBlob";
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      if (under(target, EFFECTS))
        throw new Error("JavaScript code may not touch the command canary.");
      const watched = guarded(target);
      if (
        first === "test" &&
        (watched ||
          under(target, "/opt/plenger") ||
          under(target, `${ROOT}/test`) ||
          (writes && under(target, PROJECT)) ||
          base === "symlink" ||
          base === "link")
      )
        throw new Error("The test may not touch this path; call the project code.");
      if (watched)
        record({
          kind: "file",
          operation,
          target: clip(target),
          guarded: true,
          shell: false,
          innermost: inner,
          outermost: outer,
        });
    }
  } finally {
    busy = false;
  }
}

function processCall(operation, args, skip) {
  if (busy) return;
  busy = true;
  try {
    const { first, inner, outer } = frames(skip);
    if (first === "harness") return;
    if (first === "test")
      throw new Error("The test may not start processes; call the project code.");
    const words = [String(args[0])];
    let shell = operation === "exec" || operation === "execSync";
    if (!shell) {
      const list = ArrayIsArray(args[1]) ? args[1] : [];
      for (let index = 0; index < list.length; index++) words[words.length] = String(list[index]);
      const options = ArrayIsArray(args[1]) ? args[2] : args[1];
      if (options && typeof options === "object" && options.shell) shell = true;
      if (listed(SHELLS, baseName(String(args[0]))) && list[0] === "-c") shell = true;
    }
    const command = ArrayJoin(words, " ");
    if (!StringIncludes(command, MARKER)) return;
    record({
      kind: "process",
      operation,
      target: clip(command),
      guarded: false,
      shell,
      innermost: inner,
      outermost: outer,
    });
  } finally {
    busy = false;
  }
}

function wrap(target, key, check) {
  const original = target[key];
  if (typeof original !== "function") return;
  const wrapped = function (...args) {
    check(key, args, wrapped);
    return ReflectApply(original, this, args);
  };
  ObjectDefineProperties(wrapped, ObjectDescriptors(original));
  target[key] = wrapped;
}

for (const key of FILE_FUNCTIONS) {
  wrap(fs, key, fileCall);
  wrap(fs, `${key}Sync`, fileCall);
  wrap(fs.promises, key, fileCall);
}
for (const key of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"])
  wrap(cp, key, processCall);
module.syncBuiltinESMExports();

// Built-in modules and the intrinsics a check can rely on.
const WATCHED = [
  ["fs", fs],
  ["fs/promises", fs.promises],
  ["path", path],
  ["path.posix", path.posix],
  ["child_process", cp],
  ["Object", Object],
  ["Object.prototype", Object.prototype],
  ["Function.prototype", Function.prototype],
  ["Array", Array],
  ["Array.prototype", Array.prototype],
  ["String", String],
  ["String.prototype", String.prototype],
  ["RegExp.prototype", RegExp.prototype],
  ["Set.prototype", Set.prototype],
  ["Map.prototype", Map.prototype],
  ["Promise.prototype", Promise.prototype],
  ["Number", Number],
  ["Math", Math],
  ["JSON", JSON],
  ["Reflect", Reflect],
  ["URL", URL],
  ["URL.prototype", URL.prototype],
  ["Buffer", Buffer],
  ["Buffer.prototype", Buffer.prototype],
];

// Project modules, recorded as they resolve, to compare their exports.
const projectUrls = [];
module.registerHooks?.({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (typeof resolved.url === "string" && StringStartsWith(resolved.url, PROJECT_URL))
      projectUrls[projectUrls.length] = resolved.url;
    return resolved;
  },
});

async function projectNamespaces() {
  const found = [];
  const seen = ObjectCreate(null);
  for (let index = 0; index < projectUrls.length; index++) {
    const url = projectUrls[index];
    if (seen[url]) continue;
    seen[url] = true;
    try {
      found[found.length] = [StringSlice(url, PROJECT_URL.length), await import(url)];
    } catch {
      // A module that failed to load has nothing to compare.
    }
  }
  return found;
}

const session = new Session();
session.connect();
const post = (method, params = {}) =>
  new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
  );

/** Lines of the watched files that ran, from V8 block coverage. */
function reachedLines(coverage) {
  const reached = {};
  for (const script of coverage.result) {
    if (!StringStartsWith(script.url, PROJECT_URL)) continue;
    const relative = StringSlice(script.url, PROJECT_URL.length);
    if (!config.watched.includes(relative)) continue;
    const ranges = script.functions.flatMap((item) => item.ranges);
    const text = readFileSync(path.join(PROJECT, relative), "utf8");
    const lines = [];
    let offset = 0;
    text.split("\n").forEach((line, index) => {
      const indent = line.search(/\S/);
      if (indent >= 0) {
        const at = offset + indent;
        let best = null;
        for (const range of ranges)
          if (range.startOffset <= at && at < range.endOffset)
            if (!best || range.endOffset - range.startOffset < best.endOffset - best.startOffset)
              best = range;
        if (best && best.count > 0) lines.push(index + 1);
      }
      offset += line.length + 1;
    });
    if (lines.length) reached[relative] = lines;
  }
  return reached;
}

function describe(error) {
  const lines = [`${error?.name ?? "Error"}: ${error?.message ?? String(error)}`];
  for (const line of String(error?.stack ?? "")
    .split("\n")
    .slice(1)) {
    const match = /(?:file:\/\/)?(\/tmp\/(?:project|proof\/test)\/[^:)]+):(\d+)/.exec(line);
    if (!match) continue;
    const file = match[1] === TEST ? "test_proof.mjs" : match[1].slice(PROJECT.length + 1);
    lines.push(`  at ${file}:${match[2]}`);
  }
  return lines.slice(0, 8).join("\n").slice(0, LIMITS.error);
}

const plenger = ObjectFreeze({
  base: () => BASE,
  folder(folderName) {
    const target = resolvePath(BASE, folderName);
    if (!under(target, BASE)) throw new Error("folders stay under base()");
    mkdirSync(target, { recursive: true });
    return target;
  },
  write(fileName, text) {
    const target = resolvePath(BASE, fileName);
    if (!under(target, BASE)) throw new Error("files stay under base()");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
    return target;
  },
  read(fileName) {
    const target = resolvePath(BASE, fileName);
    if (!under(target, BASE)) throw new Error("files stay under base()");
    return readFileSync(target, "utf8");
  },
  canary: () => config.canary,
  siblingCanary: () => config.sibling,
  shellPayloads: () => [...config.payloads],
});

process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

let status = "passed";
let failedAt = null;
let error = null;
let reached = {};
await post("Profiler.enable");
await post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
let test = null;
try {
  const loaded = await import(pathToFileURL(TEST).href);
  test = loaded[name === "intended" ? "testIntended" : "testWeakness"];
  if (typeof test !== "function")
    throw new Error(`The test has no ${name === "intended" ? "testIntended" : "testWeakness"}.`);
} catch (caught) {
  status = "error";
  failedAt = "import";
  error = describe(caught);
}
if (failedAt === null) {
  // The test's top level holds only imports and definitions (the host checks), so this
  // is the state as the project and its packages left it.
  const namespaces = await projectNamespaces();
  baseline = { watched: WATCHED, namespaces, values: state(WATCHED, namespaces) };
  // Taking coverage resets the counters, so import-time lines do not count as reached.
  await post("Profiler.takePreciseCoverage");
  try {
    await test(plenger);
  } catch (caught) {
    status = caught?.name === "AssertionError" ? "failed" : "error";
    failedAt = "test";
    error = describe(caught);
  }
  const changed = drift();
  for (let index = 0; index < changed.length; index++) replaced[changed[index]] = true;
  reached = reachedLines(await post("Profiler.takePreciseCoverage"));
}
const names = ObjectKeys(replaced);
let text = "";
if (names.length) {
  // A changed intrinsic (a toJSON on Object.prototype, say) could forge the result, so
  // report only the names, written from strings alone.
  let list = "";
  for (let index = 0; index < names.length && index < 64; index++)
    list += `${index ? "," : ""}${JSONStringify(String(names[index]))}`;
  text = `{"status":"error","failedAt":"test","error":"The test changed code the harness watches.","effects":[],"effectsDropped":0,"reached":{},"replaced":[${list}]}`;
} else
  text = JSONStringify({
    status,
    failedAt,
    error,
    effects,
    effectsDropped: dropped,
    reached,
    replaced: [],
  });
const result = BufferFrom(text);
let written = 0;
while (written < result.length) written += writeSync(3, result, written);
exit(0);
