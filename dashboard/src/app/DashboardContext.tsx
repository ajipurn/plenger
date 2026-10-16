import { createContext, type ReactNode, useContext } from "react";
import type { DashboardApi } from "../api/client.ts";

const ApiContext = createContext<DashboardApi | null | undefined>(undefined);

export function DashboardProvider({
  api,
  children,
}: {
  api: DashboardApi | null;
  children: ReactNode;
}) {
  return <ApiContext value={api}>{children}</ApiContext>;
}

/** The connected client, or null until the local service has answered. */
export function useApi(): DashboardApi | null {
  const api = useContext(ApiContext);
  if (api === undefined) throw new Error("useApi requires a DashboardProvider.");
  return api;
}
