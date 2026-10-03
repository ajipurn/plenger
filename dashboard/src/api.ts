import type { DashboardScan, DashboardSession, FolderListing } from "../../src/dashboard/model.ts";
import type { ProjectPlan } from "../../src/redteam/plan.ts";

export interface DashboardApi {
  session: DashboardSession;
  folders(path?: string): Promise<FolderListing>;
  scan(path: string): Promise<DashboardScan>;
  plan(path: string, target?: string): Promise<ProjectPlan>;
}

export async function connect(): Promise<DashboardApi> {
  const response = await fetch("/api/session", { cache: "no-store" });
  if (!response.ok)
    throw new Error("Unable to connect to Plenger. Restart the dashboard and try again.");
  const session = (await response.json()) as DashboardSession;
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const result = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: {
        "X-Plenger-Token": session.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = (await result.json()) as { error?: string };
    if (!result.ok) throw new Error(value.error ?? "Unable to complete this request. Try again.");
    return value as T;
  }
  return {
    session,
    folders: (path) =>
      request<FolderListing>(`/api/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
    scan: (path) => request<DashboardScan>("/api/scan", { path }),
    plan: (path, target) =>
      request<ProjectPlan>("/api/plan", { path, ...(target ? { target } : {}) }),
  };
}
