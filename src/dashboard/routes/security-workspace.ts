import { basename } from "node:path";
import type { ReviewMode } from "../../assessment/review-model.ts";
import { reviewSourceSize } from "../../assessment/review-source.ts";
import { validateProviderSettings } from "../../redteam/provider-config.ts";
import { sourceRevision } from "../../security/git.ts";
import {
  FINDING_STATUSES,
  type FindingStatus,
  SCAN_BUDGET_LIMITS,
  SCAN_DEPTHS,
  type ScanBudget,
  type SelectableScanDepth,
  THREAT_MODEL_LIMITS,
} from "../../security/model.ts";
import { isRecord } from "../../shared/guards.ts";
import { StoreValidationError } from "../../storage/store.ts";
import { API, type DeleteResult, type RepositorySource, WORKSPACE_LIMITS } from "../contract.ts";
import { expectKeys, HttpError, jsonRequest, requireInt, requireString } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";
import { resolveDirectory } from "../workspace.ts";

export function securityWorkspaceRoutes({
  store,
  supervisor,
  security,
  workspace,
}: Services): Route[] {
  return [
    {
      method: "GET",
      path: API.securityWorkspace,
      handler: () => ({ status: 200, body: store.security.workspace() }),
    },
    {
      method: "POST",
      path: API.repositories,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        expectKeys(
          body,
          ["path", "name", "environment", "notes"],
          "Choose a local project folder.",
        );
        return supervisor.exclusive(async () => {
          const path = await resolveDirectory(
            requireString(body.path, "Choose an existing local folder.", {
              min: 1,
              max: WORKSPACE_LIMITS.pathCharacters,
            }),
            workspace,
          );
          const repository = store.security.add(
            path,
            body.name === undefined
              ? basename(path)
              : requireString(body.name, "Enter a project name.", {
                  min: 1,
                  max: WORKSPACE_LIMITS.nameCharacters,
                }),
            await sourceRevision(path),
            {
              name:
                body.environment === undefined
                  ? "Local workspace"
                  : requireString(body.environment, "Enter an environment name.", {
                      min: 1,
                      max: WORKSPACE_LIMITS.environmentCharacters,
                    }),
              notes:
                body.notes === undefined
                  ? ""
                  : requireString(body.notes, "Keep environment context under 2000 characters.", {
                      max: WORKSPACE_LIMITS.contextCharacters,
                    }),
            },
          );
          return { status: 200, body: repository };
        });
      },
    },
    {
      method: "GET",
      path: API.repositorySource,
      handler: async ({ params }) => {
        const repository = store.security.repository(params.id ?? "");
        if (!repository) throw new HttpError(404, "Project not found.");
        let body: RepositorySource;
        try {
          body = await reviewSourceSize(repository.path);
        } catch {
          throw new HttpError(409, "The project folder is no longer available.");
        }
        return { status: 200, body };
      },
    },
    {
      method: "POST",
      path: API.updateRepository,
      handler: async ({ request, params }) => {
        const body = await jsonRequest(request);
        expectKeys(
          body,
          ["environment", "notes", "pauseMonitoring", "threatModel"],
          "Project update contains unsupported fields.",
        );
        return supervisor.exclusive(async () => {
          const repository = store.security.repository(params.id ?? "");
          if (!repository) throw new HttpError(404, "Project not found.");
          if (body.pauseMonitoring !== undefined && body.pauseMonitoring !== true)
            throw new HttpError(400, "Automatic scanning is unavailable. Start scans manually.");
          if (body.pauseMonitoring) repository.monitoring.enabled = false;
          if (body.environment !== undefined)
            repository.environment.name = requireString(
              body.environment,
              "Enter an environment name.",
              { min: 1, max: WORKSPACE_LIMITS.environmentCharacters },
            );
          if (body.notes !== undefined)
            repository.environment.notes = requireString(
              body.notes,
              "Keep environment context under 2000 characters.",
              { max: WORKSPACE_LIMITS.contextCharacters },
            );
          if (body.threatModel === null) delete repository.threatModel;
          else if (body.threatModel !== undefined)
            repository.threatModel = {
              ...userThreatModel(body.threatModel),
              version: (repository.threatModel?.version ?? 0) + 1,
              updatedAt: new Date().toISOString(),
              origin: "user",
              scanId: null,
            };
          return { status: 200, body: store.security.saveRepository(repository) };
        });
      },
    },
    {
      method: "POST",
      path: API.deleteRepository,
      handler: async ({ request, params }) => {
        expectKeys(await jsonRequest(request), [], "This request does not accept options.");
        // A running scan holds the supervisor, so a project is never deleted under it.
        return supervisor.exclusive(async () => {
          if (!store.security.deleteRepository(params.id ?? ""))
            throw new HttpError(404, "Project not found.");
          const result: DeleteResult = { deleted: true };
          return { status: 200, body: result };
        });
      },
    },
    {
      method: "POST",
      path: API.securityScans,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        expectKeys(
          body,
          [
            "repositoryId",
            "providerId",
            "scope",
            "depth",
            "budget",
            "model",
            "validatorProviderId",
            "mode",
          ],
          "Choose a local project, provider and scan depth.",
        );
        // Accept earlier local-scan clients, without enabling any automatic mode.
        if (body.scope !== undefined && body.scope !== "local" && body.scope !== "repository")
          throw new HttpError(400, "Only manual scans of local folders are supported.");
        if (
          typeof body.depth !== "string" ||
          !Object.hasOwn(SCAN_DEPTHS, body.depth) ||
          !SCAN_DEPTHS[body.depth as keyof typeof SCAN_DEPTHS].selectable
        )
          throw new HttpError(400, "Choose Quick or Full coverage.");
        if (body.mode !== undefined && body.mode !== "batch" && body.mode !== "explore")
          throw new HttpError(400, "Choose Explore or Batch review mode.");
        // Without a limit, Full coverage stops when it covers the project or at its batch cap.
        const budget = body.budget === undefined ? undefined : scanBudget(body.budget);
        if (body.model !== undefined) {
          try {
            // The coordinator checks the selected connection too. No access overrides are accepted.
            validateProviderSettings({ provider: "anthropic", model: body.model });
          } catch {
            throw new HttpError(400, "Choose a valid model ID.");
          }
        }
        try {
          const result = await security.start({
            repositoryId: requireString(body.repositoryId, "Choose a local project.", {
              min: 1,
              max: WORKSPACE_LIMITS.recordIdCharacters,
            }),
            providerId: requireString(body.providerId, "Choose a saved provider.", {
              min: 1,
              max: WORKSPACE_LIMITS.recordIdCharacters,
            }),
            depth: body.depth as SelectableScanDepth,
            ...(body.mode === undefined ? {} : { mode: body.mode as ReviewMode }),
            ...(budget ? { budget } : {}),
            ...(body.model === undefined ? {} : { model: body.model as string }),
            ...(body.validatorProviderId === undefined
              ? {}
              : {
                  validatorProviderId: requireString(
                    body.validatorProviderId,
                    "Choose a saved provider for the second review.",
                    { min: 1, max: WORKSPACE_LIMITS.recordIdCharacters },
                  ),
                }),
          });
          return { status: 202, body: result };
        } catch (error) {
          if (error instanceof StoreValidationError)
            throw new HttpError(400, error.message, { cause: error });
          throw error;
        }
      },
    },
    {
      method: "GET",
      path: API.securityScan,
      handler: ({ params }) => {
        const scan = store.security.scan(params.id ?? "");
        if (!scan) throw new HttpError(404, "Scan not found.");
        return { status: 200, body: scan };
      },
    },
    {
      method: "POST",
      path: API.continueSecurityScan,
      handler: async ({ request, params }) => {
        const body = await jsonRequest(request);
        expectKeys(body, ["budget"], "Set a limit to continue the scan.");
        if (body.budget === undefined)
          throw new HttpError(400, "Set a limit to continue the scan.");
        const scan = await security.continueScan(params.id ?? "", scanBudget(body.budget));
        return { status: 202, body: scan };
      },
    },
    {
      method: "POST",
      path: API.cancelSecurityScan,
      handler: async ({ request, params }) => {
        expectKeys(await jsonRequest(request), [], "This request does not accept options.");
        supervisor.cancel(params.id ?? null);
        return { status: 200, body: { cancelled: true } };
      },
    },
    {
      method: "POST",
      path: API.findingStatus,
      handler: async ({ request, params }) => {
        const body = await jsonRequest(request);
        expectKeys(body, ["status"], "Choose a finding status.");
        if (!FINDING_STATUSES.includes(body.status as FindingStatus))
          throw new HttpError(400, "Choose a supported finding status.");
        const finding = store.security.findingStatus(params.id ?? "", body.status as FindingStatus);
        if (!finding) throw new HttpError(404, "Finding not found.");
        return { status: 200, body: finding };
      },
    },
  ];
}

/** A spending limit from a request body: whole tokens, or USD to the cent. */
function scanBudget(value: unknown): ScanBudget {
  const L = SCAN_BUDGET_LIMITS;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HttpError(400, "Set the limit as tokens or USD.");
  const budget = value as Record<string, unknown>;
  if (budget.kind === "tokens") {
    expectKeys(budget, ["kind", "tokens"], "Set the limit as tokens or USD.");
    const message = `Set a token limit from ${L.minTokens.toLocaleString("en-US")} to ${L.maxTokens.toLocaleString("en-US")}.`;
    return { kind: "tokens", tokens: requireInt(budget.tokens, L.minTokens, L.maxTokens, message) };
  }
  if (budget.kind === "usd") {
    expectKeys(budget, ["kind", "usd"], "Set the limit as tokens or USD.");
    const usd = budget.usd;
    if (
      typeof usd !== "number" ||
      !Number.isFinite(usd) ||
      usd < L.minUsd ||
      usd > L.maxUsd ||
      Math.round(usd * 100) / 100 !== usd
    )
      throw new HttpError(400, `Set a USD limit from ${L.minUsd} to ${L.maxUsd}, in cents.`);
    return { kind: "usd", usd };
  }
  throw new HttpError(400, "Set the limit as tokens or USD.");
}

/** A threat model from the project page, checked against the limits both sides share. */
function userThreatModel(value: unknown) {
  if (!isRecord(value)) throw new HttpError(400, "Send the threat model as an object.");
  expectKeys(
    value,
    ["architecture", "assets", "trustBoundaries"],
    "The threat model has unsupported fields.",
  );
  const L = THREAT_MODEL_LIMITS;
  const list = (items: unknown, name: string) => {
    if (!Array.isArray(items) || items.length > L.items)
      throw new HttpError(400, `List at most ${L.items} ${name}.`);
    return items.map((item) =>
      requireString(item, `Keep each of the ${name} under ${L.itemCharacters} characters.`, {
        min: 1,
        max: L.itemCharacters,
      }).trim(),
    );
  };
  return {
    architecture: requireString(
      value.architecture,
      `Keep the architecture under ${L.textCharacters} characters.`,
      { max: L.textCharacters },
    ).trim(),
    assets: list(value.assets, "assets"),
    trustBoundaries: list(value.trustBoundaries, "trust boundaries"),
  };
}
