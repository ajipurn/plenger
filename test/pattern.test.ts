import { describe, expect, it } from "vitest";
import { compilePatterns } from "../src/inventory/pattern.ts";

describe("compilePatterns", () => {
  const matches = (patterns: string[], name: string) => compilePatterns(patterns).test(name);

  it("treats everything but the wildcards and alternations literally", () => {
    expect(matches(["openai.OpenAI().chat"], "openai.OpenAI().chat")).toBe(true);
    expect(matches(["openai.OpenAI().chat"], "openaixOpenAI().chat")).toBe(false);
    expect(matches(["a#b"], "a#b")).toBe(true);
  });

  it("matches one name segment with * and anything with **", () => {
    expect(
      matches(["anthropic.*().messages.create"], "anthropic.AsyncAnthropic().messages.create"),
    ).toBe(true);
    expect(matches(["anthropic.*().messages.create"], "anthropic.a.B().messages.create")).toBe(
      false,
    );
    expect(matches(["@ai-sdk/*#*"], "@ai-sdk/openai#openai")).toBe(true);
    expect(matches(["@ai-sdk/*#*"], "@ai-sdk/openai/x#openai")).toBe(false);
    expect(matches(["x()**.invoke"], "x().bind_tools().invoke")).toBe(true);
    expect(matches(["x()**.invoke"], "x().invoke")).toBe(true);
  });

  it("supports alternatives, empty ones and wildcards inside them", () => {
    expect(matches(["openai{#default,#OpenAI,}()"], "openai()")).toBe(true);
    expect(matches(["openai{#default,#OpenAI,}()"], "openai#OpenAI()")).toBe(true);
    expect(matches(["llmfy{,.**}.RedisCheckpointer"], "llmfy.RedisCheckpointer")).toBe(true);
    expect(
      matches(
        ["llmfy{,.**}.RedisCheckpointer"],
        "llmfy.flow_engine.checkpointer.redis_checkpointer.RedisCheckpointer",
      ),
    ).toBe(true);
  });
});
