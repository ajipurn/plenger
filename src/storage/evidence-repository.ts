import { createHash, randomUUID } from "node:crypto";
import type { ImportedReaEvidence, ReaAnalysis } from "../evidence/rea-model.ts";
import { REA_LIMITS } from "../evidence/rea-model.ts";
import { redact } from "../shared/secrets.ts";
import { parsePayload, type Storage } from "./database.ts";
import { StoreValidationError } from "./errors.ts";

/** Redacted external analysis, scoped to an immutable scan snapshot. */
export class EvidenceRepository {
  readonly #storage: Storage;
  constructor(storage: Storage) {
    this.#storage = storage;
  }

  list(scanId: string): ImportedReaEvidence[] {
    return this.#storage.database
      .prepare("SELECT payload FROM rea_evidence WHERE scan_id = ? ORDER BY imported_at DESC, id")
      .all(scanId)
      .map((row) => parsePayload<ImportedReaEvidence>(row));
  }

  read(scanId: string, id: string): ImportedReaEvidence | null {
    const row = this.#storage.database
      .prepare("SELECT payload FROM rea_evidence WHERE scan_id = ? AND id = ?")
      .get(scanId, id);
    return row ? parsePayload<ImportedReaEvidence>(row) : null;
  }

  save(scanId: string, filename: string, analysis: ReaAnalysis): ImportedReaEvidence {
    const digest = createHash("sha256").update(JSON.stringify(analysis)).digest("hex");
    return this.#storage.transaction(() => {
      const current = this.list(scanId);
      const duplicate = current.find((item) => item.digest === digest);
      if (duplicate) return duplicate;
      if (current.length >= REA_LIMITS.perScan)
        throw new StoreValidationError(
          `A scan can hold up to ${REA_LIMITS.perScan} REA imports. Remove an import before adding another.`,
        );
      const record: ImportedReaEvidence = {
        id: randomUUID(),
        scanId,
        filename: redact(filename),
        importedAt: new Date().toISOString(),
        digest,
        verification: "unverified",
        analysis,
      };
      this.#storage.database
        .prepare("INSERT INTO rea_evidence (id, scan_id, imported_at, payload) VALUES (?, ?, ?, ?)")
        .run(record.id, scanId, record.importedAt, JSON.stringify(record));
      return record;
    });
  }

  delete(scanId: string, id: string): boolean {
    const result = this.#storage.database
      .prepare("DELETE FROM rea_evidence WHERE scan_id = ? AND id = ?")
      .run(scanId, id);
    if (result.changes) this.#storage.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return Number(result.changes) > 0;
  }
}
