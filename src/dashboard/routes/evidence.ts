import { parseReaEvidence, ReaImportError } from "../../evidence/import-rea.ts";
import { StoreValidationError } from "../../storage/store.ts";
import { API, type DeleteResult, REA_LIMITS, WORKSPACE_LIMITS } from "../contract.ts";
import { expectKeys, HttpError, jsonRequest, requireString } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

/** Imports never start REA, contact a target, or follow paths from the document. */
export function evidenceRoutes({ store, supervisor }: Services): Route[] {
  function scanId(value: unknown): string {
    const id = requireString(value, "Choose a saved scan.", {
      min: 1,
      max: WORKSPACE_LIMITS.recordIdCharacters,
    });
    if (!store.scans.readScan(id))
      throw new HttpError(404, "Scan not found. Run a scan before importing evidence.");
    return id;
  }
  return [
    {
      method: "GET",
      path: API.reaEvidence,
      handler: ({ url }) => ({
        status: 200,
        body: store.evidence.list(scanId(url.searchParams.get("scanId"))),
      }),
    },
    {
      method: "POST",
      path: API.reaEvidence,
      handler: async ({ request }) => {
        const body = await jsonRequest(request, REA_LIMITS.requestBytes);
        expectKeys(
          body,
          ["scanId", "filename", "evidence"],
          "Send a saved scan and REA JSON file.",
        );
        return supervisor.exclusive(async () => {
          const selected = scanId(body.scanId);
          const filename = requireString(
            body.filename,
            "Choose a JSON file with a name of up to 200 characters.",
            { min: 1, max: 200 },
          );
          if (
            /[\\/]/.test(filename) ||
            Array.from(filename).some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            ) ||
            !filename.toLowerCase().endsWith(".json")
          )
            throw new HttpError(400, "Choose a .json file without a directory path.");
          try {
            const analysis = parseReaEvidence(body.evidence);
            return { status: 200, body: store.evidence.save(selected, filename, analysis) };
          } catch (error) {
            if (error instanceof ReaImportError || error instanceof StoreValidationError)
              throw new HttpError(400, error.message, { cause: error });
            throw error;
          }
        });
      },
    },
    {
      method: "POST",
      path: API.deleteReaEvidence,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        expectKeys(body, ["scanId", "id"], "Choose an imported evidence record.");
        return supervisor.exclusive(async () => {
          const selected = scanId(body.scanId);
          const id = requireString(body.id, "Choose an imported evidence record.", {
            min: 1,
            max: WORKSPACE_LIMITS.recordIdCharacters,
          });
          if (!store.evidence.delete(selected, id))
            throw new HttpError(404, "Imported evidence not found in this scan.");
          const result: DeleteResult = { deleted: true };
          return { status: 200, body: result };
        });
      },
    },
  ];
}
