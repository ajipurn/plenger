import { compilePatterns } from "../facts/pattern.ts";
import type { CapabilityKind } from "../inventory/model.ts";
import { familyOf, type Language } from "../source/languages.ts";
import { APPROVAL_CALLS, GUARDS, JAVASCRIPT_SINKS, PYTHON_SINKS, type Sink } from "./sinks.ts";

/** A sink with its call patterns compiled. */
export interface CompiledSink {
  sink: Sink;
  pattern: RegExp;
}

interface CompiledCatalog {
  python: CompiledSink[];
  javascript: CompiledSink[];
  guards: { kinds: CapabilityKind[]; pattern: RegExp }[];
  approvals: RegExp;
}

let compiled: CompiledCatalog | undefined;

function compileSink(sink: Sink): CompiledSink {
  return { sink, pattern: compilePatterns(sink.calls, sink.except) };
}

/** The sink, guard and approval patterns of sinks.ts, compiled once per process. */
export function compiledSinks(): CompiledCatalog {
  compiled ??= {
    python: PYTHON_SINKS.map(compileSink),
    javascript: JAVASCRIPT_SINKS.map(compileSink),
    guards: GUARDS.map((guard) => ({ kinds: guard.kinds, pattern: compilePatterns(guard.calls) })),
    approvals: compilePatterns(APPROVAL_CALLS),
  };
  return compiled;
}

/** The sinks that apply to files of a language. */
export function sinksFor(language: Language): CompiledSink[] {
  return compiledSinks()[familyOf(language)];
}

/** The sink a canonical call name matches in a file of the given language. */
export function sinkOf(name: string, language: Language): Sink | undefined {
  return sinksFor(language).find(({ pattern }) => pattern.test(name))?.sink;
}
