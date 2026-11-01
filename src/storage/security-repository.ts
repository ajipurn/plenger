import { randomUUID } from "node:crypto";
import {
  type FindingStatus,
  type LocalRepository,
  SERVICE_STOPPED_PAUSE,
  type SecurityFinding,
  type SecurityScan,
  type SecurityScanSummary,
  type SecurityWorkspace,
} from "../security/model.ts";
import { restoreReportedTokens } from "../security/usage.ts";
import { redactReport } from "../shared/secrets.ts";
import { parsePayload, type Storage } from "./database.ts";

export class SecurityRepository {
  readonly #storage: Storage;
  constructor(storage: Storage) {
    this.#storage = storage;
  }
  repositories(): LocalRepository[] {
    return this.#storage.database
      .prepare("SELECT payload FROM security_repositories ORDER BY created_at, id")
      .all()
      .map((row) => parsePayload<LocalRepository>(row));
  }
  repository(id: string): LocalRepository | null {
    return this.repositories().find((item) => item.id === id) ?? null;
  }
  saveRepository(repository: LocalRepository): LocalRepository {
    const safe = structuredClone(repository);
    redactReport(safe);
    this.#storage.ensureProject(safe.path);
    this.#storage.database
      .prepare(
        "INSERT INTO security_repositories (id, path, created_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(safe.id, safe.path, safe.createdAt, JSON.stringify(safe));
    return safe;
  }
  add(
    path: string,
    name: string,
    revision: LocalRepository["revision"],
    environment: LocalRepository["environment"],
  ): LocalRepository {
    const current = this.repositories().find((item) => item.path === path);
    if (current) return current;
    return this.saveRepository({
      id: randomUUID(),
      path,
      name,
      revision,
      environment,
      createdAt: new Date().toISOString(),
      monitoring: {
        enabled: false,
        providerId: null,
        depth: "standard",
        lastCommit: revision.commit,
        error: null,
      },
    });
  }
  /**
   * Forget one project. Its scans, findings, reviews, imported evidence and red-team runs
   * reference `projects(path) ON DELETE CASCADE`, so deleting the project row removes them
   * too. The folder on disk is untouched. False when no project has `id`.
   */
  deleteRepository(id: string): boolean {
    const repository = this.repository(id);
    if (!repository) return false;
    this.#storage.transaction(() => {
      this.#storage.database.prepare("DELETE FROM projects WHERE path = ?").run(repository.path);
    });
    // Deleted rows must not linger in the write-ahead log.
    this.#storage.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return true;
  }
  scan(id: string): SecurityScan | null {
    const row = this.#storage.database
      .prepare("SELECT payload FROM security_scans WHERE id = ?")
      .get(id);
    return row ? restoreReportedTokens(parsePayload<SecurityScan>(row)) : null;
  }
  saveScan(scan: SecurityScan): void {
    const safe = structuredClone(scan);
    redactReport(safe);
    this.#storage.database
      .prepare(
        "INSERT INTO security_scans (id, repository_id, started_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(safe.id, safe.repositoryId, safe.startedAt, JSON.stringify(safe));
  }
  /** Every saved finding of one project, for matching a new scan against triage state. */
  findings(repositoryId: string): SecurityFinding[] {
    return this.#storage.database
      .prepare("SELECT payload FROM security_findings WHERE repository_id = ?")
      .all(repositoryId)
      .map((row) => parsePayload<SecurityFinding>(row));
  }
  /**
   * Save a scan's findings with their triage state. A finding detected again after it was
   * resolved is reopened; a dismissed one stays dismissed. `resolved` names saved findings
   * the scan showed to be gone; they are marked resolved unless already closed.
   */
  saveFindings(scan: SecurityScan, resolved: readonly string[] = []): void {
    this.#storage.transaction(() => {
      for (const finding of scan.findings) {
        const saved = [finding.id, ...(finding.aliases ?? [])].flatMap((id) => {
          const row = this.#storage.database
            .prepare("SELECT payload FROM security_findings WHERE id = ? AND repository_id = ?")
            .get(id, scan.repositoryId);
          return row ? [parsePayload<SecurityFinding>(row)] : [];
        });
        const previous = saved.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (previous) {
          finding.status = previous.status === "resolved" ? "new" : previous.status;
          finding.detectedAt =
            saved.map((item) => item.detectedAt).sort()[0] ?? previous.detectedAt;
          if (saved.length > 1)
            finding.mergedTriage = [
              ...(finding.mergedTriage ?? []),
              ...saved.map((item) => ({
                id: item.id,
                status: item.status,
                updatedAt: item.updatedAt,
              })),
            ];
        }
        redactReport(finding);
        this.#storage.database
          .prepare(
            "INSERT INTO security_findings (id, repository_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
          )
          .run(finding.id, finding.repositoryId, JSON.stringify(finding));
        for (const alias of finding.aliases ?? [])
          if (alias !== finding.id)
            this.#storage.database
              .prepare("DELETE FROM security_findings WHERE id = ? AND repository_id = ?")
              .run(alias, scan.repositoryId);
      }
      for (const id of resolved) {
        const row = this.#storage.database
          .prepare("SELECT payload FROM security_findings WHERE id = ? AND repository_id = ?")
          .get(id, scan.repositoryId);
        if (!row) continue;
        const finding = parsePayload<SecurityFinding>(row);
        if (finding.status === "resolved" || finding.status === "dismissed") continue;
        finding.status = "resolved";
        finding.updatedAt = scan.finishedAt ?? new Date().toISOString();
        this.#storage.database
          .prepare("UPDATE security_findings SET payload = ? WHERE id = ?")
          .run(JSON.stringify(finding), id);
      }
      this.saveScan(scan);
    });
  }
  findingStatus(id: string, status: FindingStatus): SecurityFinding | null {
    const row = this.#storage.database
      .prepare("SELECT payload FROM security_findings WHERE id = ?")
      .get(id);
    const finding = row
      ? parsePayload<SecurityFinding>(row)
      : this.workspace().findings.find((item) => item.aliases?.includes(id));
    if (!finding) return null;
    finding.status = status;
    finding.updatedAt = new Date().toISOString();
    this.#storage.database
      .prepare("UPDATE security_findings SET payload = ? WHERE id = ?")
      .run(JSON.stringify(finding), finding.id);
    return finding;
  }
  workspace(): SecurityWorkspace {
    return {
      repositories: this.repositories(),
      scans: this.#storage.database
        .prepare("SELECT payload FROM security_scans ORDER BY started_at DESC, id DESC")
        .all()
        .map((row): SecurityScanSummary => {
          const {
            findings: _findings,
            reviews: _reviews,
            ...summary
          } = restoreReportedTokens(parsePayload<SecurityScan>(row));
          return summary;
        }),
      findings: this.#storage.database
        .prepare("SELECT payload FROM security_findings ORDER BY rowid DESC")
        .all()
        .map((row) => parsePayload<SecurityFinding>(row)),
    };
  }
  recoverInterrupted(): void {
    for (const item of this.workspace().scans)
      if (item.status === "running") {
        const scan = this.scan(item.id);
        if (!scan) continue;
        // Finished rounds are saved, so a Full coverage AI scan pauses and can continue.
        const resumable = scan.depth === "full" && scan.workflow !== "static" && scan.provider;
        scan.status = resumable ? "paused" : "failed";
        scan.phase = "finished";
        scan.finishedAt = new Date().toISOString();
        scan.error = resumable
          ? SERVICE_STOPPED_PAUSE
          : "The local service stopped before this scan finished. Start a new scan to continue.";
        this.saveScan(scan);
      }
  }
}
