import { randomUUID } from "node:crypto";
import { planProject } from "../../redteam/plan.ts";
import { RULES } from "../../rules/index.ts";
import { scan } from "../../scan.ts";
import { API, type DashboardScan } from "../contract.ts";
import { jsonRequest, type Reply } from "../http.ts";
import type { Route, RouteContext } from "../router.ts";
import type { Services } from "../services.ts";
import { parseProjectRequest, resolveDirectory } from "../workspace.ts";

/** Scanning, target planning and project selection: the exclusive project operations. */
export function scanRoutes({ workspace, store, supervisor }: Services): Route[] {
  async function exclusive(
    context: RouteContext,
    options: { allowTarget: boolean },
    operate: (path: string, target: string | undefined) => Promise<Reply>,
  ): Promise<Reply> {
    const body = parseProjectRequest(await jsonRequest(context.request), options);
    return supervisor.exclusive(async () =>
      operate(await resolveDirectory(body.path, workspace), body.target),
    );
  }
  return [
    {
      method: "POST",
      path: API.project,
      handler: (context) =>
        exclusive(context, { allowTarget: false }, async (path) => {
          store.selectProject(path);
          return { status: 200, body: store.read(workspace) };
        }),
    },
    {
      method: "POST",
      path: API.scan,
      handler: (context) =>
        exclusive(context, { allowTarget: false }, async (path) => {
          const result: DashboardScan = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            scan: await scan(path),
            rules: RULES,
          };
          store.saveScan(result);
          return { status: 200, body: result };
        }),
    },
    {
      method: "POST",
      path: API.plan,
      handler: (context) =>
        exclusive(context, { allowTarget: true }, async (path, target) => {
          const result = await planProject(path, target === undefined ? {} : { target });
          store.savePlan(result);
          return { status: 200, body: result };
        }),
    },
  ];
}
