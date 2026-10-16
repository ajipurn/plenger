import { basename } from "node:path";
import { validateProviderSettings } from "../../redteam/provider-config.ts";
import { sourceRevision } from "../../security/git.ts";
import {
  FINDING_STATUSES,
  type FindingStatus,
  SCAN_DEPTHS,
  type ScanDepth,
} from "../../security/model.ts";
import { StoreValidationError } from "../../storage/store.ts";
import { API, WORKSPACE_LIMITS } from "../contract.ts";
import { expectKeys, HttpError, jsonRequest, requireString } from "../http.ts";
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
      method: "POST",
      path: API.updateRepository,
      handler: async ({ request, params }) => {
        const body = await jsonRequest(request);
        expectKeys(
          body,
          ["environment", "notes", "pauseMonitoring"],
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
          return { status: 200, body: store.security.saveRepository(repository) };
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
          ["repositoryId", "providerId", "scope", "depth", "model"],
          "Choose a local project, provider and scan depth.",
        );
        // Accept earlier local-scan clients, without enabling any automatic mode.
        if (body.scope !== undefined && body.scope !== "local" && body.scope !== "repository")
          throw new HttpError(400, "Only manual scans of local folders are supported.");
        if (typeof body.depth !== "string" || !Object.hasOwn(SCAN_DEPTHS, body.depth))
          throw new HttpError(400, "Choose a supported scan depth.");
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
            depth: body.depth as ScanDepth,
            ...(body.model === undefined ? {} : { model: body.model as string }),
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
