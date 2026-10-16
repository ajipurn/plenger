import type { executeCampaign } from "../redteam/campaign.ts";
import type { executeRun } from "../redteam/run.ts";
import type { DashboardStore } from "../storage/store.ts";
import type { ChatgptLogin } from "./chatgpt-login.ts";
import type { FolderPicker } from "./folder-picker.ts";
import type { OperationSupervisor } from "./operations.ts";
import type { SecurityCoordinator } from "./security-coordinator.ts";

/** What every route handler can reach; created once per `startDashboard`. */
export interface Services {
  /** The folder the dashboard was started in; relative paths resolve against it. */
  workspace: string;
  /** The per-process session token the page must send back. */
  token: string;
  store: DashboardStore;
  supervisor: OperationSupervisor;
  security: SecurityCoordinator;
  chatgptLogin: ChatgptLogin;
  folderPicker: FolderPicker;
  runExecutor: typeof executeRun;
  campaignExecutor: typeof executeCampaign;
}
