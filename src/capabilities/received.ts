/**
 * Where data received over the network goes: effects whose input is computed from what
 * an HTTP client, a socket or a remote listing returned. A server or peer the code does
 * not control chooses that data, as a model chooses its output (see `output.ts`).
 */

import { compilePatterns } from "../facts/pattern.ts";
import { definitionOf, provenanceOf } from "../facts/query.ts";
import type { Capability, CapabilityKind, Location } from "../inventory/model.ts";
import { MODULE_SCOPE, type ProjectIndex } from "../project/index.ts";
import type { Project, ProjectFile } from "../project/project.ts";
import { locationKey } from "../shared/location.ts";
import { familyOf } from "../source/languages.ts";
import type { EffectTracer } from "./effects.ts";

/** A call that receives data, and the effects whose input comes from it. */
export interface Receiver {
  /** The receiving call (`requests.get`, `zmq...recv_pyobj`), or the project function that returns what one received. */
  target: string;
  location: Location;
  /** The function the call is in; null at module level. */
  scope: string | null;
  effects: Capability[];
}

const PY_HTTP = "get,post,put,patch,delete,head,options,request";

/** Calls whose result is data a remote party chose. */
const RECEIVES = {
  python: compilePatterns([
    `requests{,.api}.{${PY_HTTP}}`,
    `requests.Session()**.{${PY_HTTP},send}`,
    `httpx.{${PY_HTTP},stream}`,
    `httpx.{Client,AsyncClient}()**.{${PY_HTTP},send,stream}`,
    `aiohttp.ClientSession()**.{${PY_HTTP}}`,
    "urllib.request.urlopen",
    "urllib3{,.PoolManager()**}.request",
    "socket.{socket,create_connection}()**.{recv,recvfrom,recvmsg}",
    "zmq.**.{recv,recv_multipart,recv_pyobj,recv_json,recv_string,recv_serialized}",
    "ftplib.{FTP,FTP_TLS}()**.{nlst,mlsd}",
    "boto3.client()**.{list_objects,list_objects_v2,get_object}",
  ]),
  javascript: compilePatterns([
    "fetch",
    "{node-fetch,undici,cross-fetch}{#default,#fetch,#request,}",
    "axios{#default,}",
    "axios{#default.,#}{get,post,put,patch,delete,request}",
    "axios{#default.,#}create()**.{get,post,put,patch,delete,request}",
    "got{#default,}",
    "got{#default.,#}{get,post}",
  ]),
};

/** Effects that misbehave when a remote party chooses their input. */
const RECEIVED_SINKS = new Set<CapabilityKind>([
  "process",
  "code",
  "file_read",
  "file_write",
  "file_delete",
  "deserialize",
]);

/**
 * Every call in the project that receives data, directly or through a project function
 * that returns what it received, with the effects (through project functions too) whose
 * input is computed from that call's result.
 */
export function receivedEffects(
  project: Project,
  index: ProjectIndex,
  tracer: EffectTracer,
): Receiver[] {
  const returning = new Map<string, boolean>();
  /** Whether a project function returns data it received, or that a function it calls did. */
  const returnsReceived = (path: string, definition: string): boolean => {
    const key = `${path}|${definition}`;
    const known = returning.get(key);
    if (known !== undefined) return known;
    returning.set(key, false);
    const file = project.files.get(path);
    const returns = file === undefined ? [] : (definitionOf(file.facts, definition)?.returns ?? []);
    const result =
      file !== undefined &&
      returns.some((value) =>
        [
          ...provenanceOf(value, file.facts, definition, undefined, tracer.flowFor(file)).calls,
        ].some((call) => receives(file, call)),
      );
    returning.set(key, result);
    return result;
  };
  const receives = (file: ProjectFile, index_: number): boolean => {
    const call = file.facts.calls[index_];
    const name = call?.ref?.name;
    if (call === undefined || name === undefined) return false;
    if (RECEIVES[familyOf(file.language)].test(name)) return true;
    const target = index.calledFunction(file, call);
    return target !== null && returnsReceived(target.path, target.definition);
  };

  const receivers: Receiver[] = [];
  for (const [path, file] of project.files) {
    const sites = new Map<string | null, Receiver[]>();
    for (const [position, call] of file.facts.calls.entries()) {
      if (!receives(file, position)) continue;
      const receiver: Receiver = {
        target: call.ref?.name ?? call.callee,
        location: { path, ...call.span },
        scope: call.scope,
        effects: [],
      };
      sites.set(call.scope, [...(sites.get(call.scope) ?? []), receiver]);
    }
    for (const [scope, found] of sites) {
      for (const effect of tracer.effects(path, scope ?? MODULE_SCOPE, 0)) {
        if (!RECEIVED_SINKS.has(effect.kind)) continue;
        // `name@line:column` of every call the effect's inputs come from, in this file.
        const from = new Set(
          effect.inputs.flatMap((part) =>
            (part.calls ?? []).map((name, at) => `${name}@${part.callSites?.[at]}`),
          ),
        );
        for (const receiver of found) {
          const site = `${receiver.target}@${receiver.location.line}:${receiver.location.column}`;
          if (!from.has(site)) continue;
          if (receiver.effects.some((item) => same(item, effect))) continue;
          receiver.effects.push(effect);
        }
      }
      receivers.push(...found.filter((receiver) => receiver.effects.length > 0));
    }
  }
  return receivers;
}

function same(a: Capability, b: Capability): boolean {
  return (
    a.kind === b.kind &&
    a.target === b.target &&
    locationKey(a.location) === locationKey(b.location)
  );
}
