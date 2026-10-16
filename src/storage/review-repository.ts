import type { SecurityReview } from "../assessment/review-model.ts";
import { SECURITY_REVIEW_LIMITS } from "../assessment/review-model.ts";
import { redactReport } from "../shared/secrets.ts";
import { parsePayload, type Storage } from "./database.ts";
import { StoreValidationError } from "./errors.ts";

/** Model reviews remain separate from the immutable offline scanner results. */
export class ReviewRepository {
  readonly #storage: Storage;
  constructor(storage: Storage) {
    this.#storage = storage;
  }

  list(scanId: string): SecurityReview[] {
    return this.#storage.database
      .prepare(
        "SELECT payload FROM security_reviews WHERE scan_id = ? ORDER BY created_at DESC, id",
      )
      .all(scanId)
      .map((row) => parsePayload<SecurityReview>(row));
  }
  read(scanId: string, id: string): SecurityReview | null {
    const row = this.#storage.database
      .prepare("SELECT payload FROM security_reviews WHERE scan_id = ? AND id = ?")
      .get(scanId, id);
    return row ? parsePayload<SecurityReview>(row) : null;
  }
  assertCapacity(scanId: string): void {
    const count = this.#storage.database
      .prepare("SELECT COUNT(*) AS count FROM security_reviews WHERE scan_id = ?")
      .get(scanId)?.count;
    if (typeof count === "number" && count >= SECURITY_REVIEW_LIMITS.perScan)
      throw new StoreValidationError(
        "This scan has reached its review history limit. Run a new static scan to start another review.",
      );
  }
  save(review: SecurityReview): void {
    this.assertCapacity(review.scanId);
    const safe = structuredClone(review);
    redactReport(safe);
    this.#storage.database
      .prepare(
        "INSERT INTO security_reviews (id, scan_id, created_at, payload) VALUES (?, ?, ?, ?)",
      )
      .run(safe.id, safe.scanId, safe.createdAt, JSON.stringify(safe));
  }
}
