import { describe, expect, it } from "vitest";
import {
  createRunProvider,
  ModelProviderHttpError,
  providerErrorDetail,
} from "../src/redteam/provider.ts";

const request = { messages: [{ role: "user", content: "Hello" }], tools: null };

describe("provider error replies", () => {
  it.each([
    [
      {
        error: {
          message: "Invalid schema for function 'submit': secret-source-text",
          type: "invalid_request_error",
          param: "tools[4].function.parameters",
          code: "invalid_function_parameters",
        },
      },
      {
        type: "invalid_request_error",
        code: "invalid_function_parameters",
        param: "tools[4].function.parameters",
      },
    ],
    [
      { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } },
      { type: "invalid_request_error" },
    ],
    [
      [
        {
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            status: "INVALID_ARGUMENT",
          },
        },
      ],
      { type: "INVALID_ARGUMENT" },
    ],
    [{ error: "Pricing unavailable" }, {}],
    ["not an object", {}],
  ])("names only the short codes of %j", (body, detail) => {
    expect(providerErrorDetail(body)).toEqual(detail);
  });

  it("leaves out values that are not short codes", () => {
    expect(
      providerErrorDetail({
        error: { type: "has spaces in it", code: "x".repeat(65), param: "messages[0]; DROP" },
      }),
    ).toEqual({});
  });

  it("puts the codes of a rejected request in the error, never the provider's message", async () => {
    const provider = createRunProvider(
      { provider: "openai", model: "gpt-test", apiKey: "sk-test-key-for-a-rejected-request" },
      async () =>
        Response.json(
          {
            error: {
              message: "Unsupported parameter: echoed-request-text",
              type: "invalid_request_error",
              param: "prompt_cache_key",
              code: "unsupported_parameter",
            },
          },
          { status: 400 },
        ),
    );
    const failure = await provider
      .generate(request, { signal: AbortSignal.timeout(5000), maxOutputTokens: 64 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelProviderHttpError);
    const error = failure as ModelProviderHttpError;
    expect(error.status).toBe(400);
    expect(error.summary).toBe(
      " (invalid_request_error, unsupported_parameter, param prompt_cache_key)",
    );
    expect(error.message).not.toContain("echoed-request-text");
  });
});
