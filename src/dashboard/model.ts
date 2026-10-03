import type { Rule } from "../rules/model.ts";
import type { ScanResult } from "../scan.ts";

export interface DashboardSession {
  workspace: string;
  token: string;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
}

export interface DashboardScan {
  id: string;
  createdAt: string;
  scan: ScanResult;
  rules: Rule[];
}
