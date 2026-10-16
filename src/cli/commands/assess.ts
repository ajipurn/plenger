import { assessProject } from "../../assessment/assess.ts";
import { formatAssessment } from "../../assessment/format.ts";
import { ASSESSMENT_LIMITS } from "../../assessment/model.ts";
import { validateBudgetLimits } from "../../redteam/budget.ts";
import type { ProviderAccess } from "../../redteam/provider.ts";
import { validateProviderSettings } from "../../redteam/provider-config.ts";
import { ProviderRepository } from "../../storage/provider-repository.ts";
import { COMMON_OPTIONS, parseCommandArgs, requireNonemptyPaths } from "../args.ts";
import { emit, type Io, UsageError } from "../io.ts";

export const ASSESS_USAGE = `Usage:
  plenger assess [path] --provider <saved Anthropic name or id>
  plenger assess [path] --model <Claude model id> --api-key-env <name>

Send redacted static code facts and findings from the selected path to Claude for
defensive STRIDE analysis. Project code is only read. No tools or active tests run.
One model request; refusals stop the assessment without retries.

Options:
  --provider <name|id>    Saved Anthropic connection from Settings > Providers
  --data-dir <dir>       Provider store location (same as plenger serve)
  --model <id>           Claude model id when using --api-key-env
  --api-key-env <name>   Read only this environment variable for the API key
  --tokens <count>      Token admission budget (default: ${ASSESSMENT_LIMITS.tokens})
  --timeout <seconds>   Model request deadline (default: ${ASSESSMENT_LIMITS.timeoutSeconds})
  --format <format>     markdown or json (default: markdown)
  --json                Print the assessment as JSON
  --output <file>       Write the redacted report instead of stdout

Only scanned Python, JavaScript and TypeScript facts and finding snippets are sent.
Gitignored files, symlink entries and environment files stay outside the submitted scope.
The report records omissions, token accounting and refusal reasons.
Exit: 0 assessment completed; 1 incomplete, refused or failed; 2 invalid options.
`;

export async function assessCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    "assess",
    argv,
    {
      ...COMMON_OPTIONS,
      provider: { type: "string" },
      model: { type: "string" },
      "api-key-env": { type: "string" },
      "data-dir": { type: "string" },
      tokens: { type: "string" },
      timeout: { type: "string" },
      format: { type: "string" },
      json: { type: "boolean" },
      output: { type: "string" },
    } as const,
    1,
  );
  requireNonemptyPaths(values, ["output", "data-dir"]);
  if (Object.values(values).some((value) => value === ""))
    throw new UsageError("Use nonempty assessment option values.");
  const format = values.format ?? (values.json ? "json" : "markdown");
  if ((format !== "markdown" && format !== "json") || (values.json && format !== "json"))
    throw new UsageError("Choose one assessment format: markdown or json.");
  const maxTokens = Number(values.tokens ?? ASSESSMENT_LIMITS.tokens);
  const timeoutMs = Number(values.timeout ?? ASSESSMENT_LIMITS.timeoutSeconds) * 1000;
  let access: ProviderAccess;
  try {
    validateBudgetLimits({ maxModelCalls: 1, maxTokens, timeoutMs });
    if (values.provider) {
      if (values.model || values["api-key-env"])
        throw new Error("Use a saved provider or --model with --api-key-env.");
      const store = await ProviderRepository.open(values["data-dir"]);
      try {
        const saved = store.providers
          .readProviders()
          .find((item) => item.id === values.provider || item.name === values.provider);
        if (saved?.provider !== "anthropic")
          throw new Error("Choose a saved Anthropic Claude provider.");
        access = store.providers.resolveProvider(saved.id).access;
      } finally {
        store.close();
      }
    } else {
      const env = values["api-key-env"];
      if (!values.model || !env || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env))
        throw new Error(
          "Choose --provider, or supply --model and --api-key-env with an environment variable name.",
        );
      const apiKey = process.env[env];
      if (!apiKey) throw new Error("The selected API key environment variable is empty or unset.");
      access = {
        provider: "anthropic",
        model: values.model,
        apiKey,
        maxOutputTokens: ASSESSMENT_LIMITS.outputTokens,
      };
    }
    validateProviderSettings(access);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Check the assessment settings.");
  }
  const report = await assessProject(positionals[0] ?? ".", { access, maxTokens, timeoutMs });
  await emit(formatAssessment(report, format), values.output, io);
  return report.status === "completed" ? 0 : 1;
}
