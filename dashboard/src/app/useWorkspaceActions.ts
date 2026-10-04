import { useState } from "react";
import { useNavigate } from "react-router";
import type { DashboardScanSummary } from "../../../src/dashboard/contract.ts";
import type { DashboardApi } from "../api/client.ts";
import { errorMessage } from "../shared/async.ts";
import { projectName } from "../shared/paths.ts";
import type { DashboardActions } from "./DashboardContext.tsx";
import { routes } from "./routes.ts";

/** Workspace operations against the local service, plus the dialogs that start them. */
export function useWorkspaceActions({
  api,
  project,
  operationBlocked,
  actions,
  announce,
}: {
  api: DashboardApi | null;
  project: string;
  operationBlocked: boolean;
  actions: DashboardActions;
  announce: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [picker, setPicker] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearError, setClearError] = useState("");

  async function runScan(path = project) {
    if (!api || operationBlocked) return;
    actions.setBusy("scan");
    actions.setError("");
    announce("Scanning source code…");
    try {
      const result = await api.scan(path);
      actions.scanComplete(result);
      announce(
        `Scan complete. ${result.scan.findings.length} findings across ${result.scan.files.length} source files.`,
      );
    } catch (error) {
      actions.setError(errorMessage(error, "Unable to scan this project. Try again."));
      announce("Scan could not complete.");
    } finally {
      actions.setBusy(null);
    }
  }
  async function reviewPlan(target?: string) {
    if (!api || operationBlocked) return;
    actions.setBusy("plan");
    actions.setPlanError(null);
    announce("Reviewing project preparation…");
    try {
      const result = await api.plan(project, target);
      actions.setPlan(result);
      announce("Project preparation reviewed. Check runtime eligibility before starting a run.");
    } catch (error) {
      actions.setPlanError(errorMessage(error, "Unable to review project preparation. Try again."));
    } finally {
      actions.setBusy(null);
    }
  }
  async function selectProject(path: string) {
    if (!api || operationBlocked) return;
    actions.setBusy("project");
    try {
      const state = await api.selectProject(path);
      actions.restore(state);
      setPicker(false);
      void navigate(routes.overview);
      announce(`Selected ${projectName(state.project)}.`);
    } finally {
      actions.setBusy(null);
    }
  }
  async function openHistory(item: DashboardScanSummary) {
    if (!api || operationBlocked) return;
    actions.setBusy("history");
    actions.setError("");
    try {
      actions.restore(await api.openScan(item.id));
      void navigate(routes.overview);
      announce("Viewing a saved scan. Rescan for current source code.");
    } catch (error) {
      actions.setError(errorMessage(error, "Unable to open this saved scan."));
    } finally {
      actions.setBusy(null);
    }
  }
  async function clearSavedData() {
    if (!api || operationBlocked) return;
    actions.setBusy("clear");
    setClearError("");
    try {
      actions.restore(await api.clear());
      actions.setProviders([]);
      setClearOpen(false);
      announce("Saved dashboard data cleared. Your project files are unchanged.");
    } catch (error) {
      setClearError(errorMessage(error, "Unable to clear saved data. Try again."));
    } finally {
      actions.setBusy(null);
    }
  }

  return {
    runScan,
    reviewPlan,
    selectProject,
    openHistory,
    clearSavedData,
    picker,
    openPicker: () => setPicker(true),
    closePicker: () => setPicker(false),
    clearOpen,
    clearError,
    openClearDialog: () => {
      setClearError("");
      setClearOpen(true);
    },
    closeClearDialog: () => setClearOpen(false),
  };
}
