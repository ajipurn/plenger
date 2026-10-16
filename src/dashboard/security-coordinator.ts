import { randomUUID } from "node:crypto";
import type { ReviewSourceFile } from "../assessment/review-model.ts";
import { reviewProject } from "../assessment/security-review.ts";
import { sumCosts } from "../redteam/model-pricing.ts";
import { validateProviderSettings } from "../redteam/provider-config.ts";
import { RULES } from "../rules/index.ts";
import { scan } from "../scan.ts";
import { scanFindings, vanishedStaticFindings } from "../security/findings.ts";
import { sourceRevision } from "../security/git.ts";
import { SCAN_DEPTHS, type SecurityScan, type StartSecurityScan } from "../security/model.ts";
import type { DashboardStore } from "../storage/store.ts";
import { HttpError } from "./http.ts";
import type { OperationSupervisor } from "./operations.ts";

/** Background scans survive page navigation. The same supervisor protects legacy operations. */
export class SecurityCoordinator {
  readonly #store: DashboardStore;
  readonly #supervisor: OperationSupervisor;
  #closed = false;
  constructor(store: DashboardStore, supervisor: OperationSupervisor) {
    this.#store = store;
    this.#supervisor = supervisor;
    this.#importHistory();
    // Older workspaces may contain enabled monitors. All scans now require an explicit start.
    for (const project of store.security.repositories()) {
      if (!project.monitoring.enabled) continue;
      project.monitoring.enabled = false;
      store.security.saveRepository(project);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
  }

  async start(input: StartSecurityScan): Promise<SecurityScan> {
    return this.#supervisor.exclusive(async () => {
      if (this.#closed) throw new HttpError(503, "The service is shutting down.");
      const repository = this.#store.security.repository(input.repositoryId);
      if (!repository) throw new HttpError(404, "Project not found. Add a local folder first.");
      const resolved = this.#store.resolveProvider(input.providerId);
      const model = input.model ?? resolved.saved.model;
      try {
        validateProviderSettings({ ...resolved.access, model });
      } catch {
        throw new HttpError(400, "Choose a valid model for this provider.");
      }
      const access = { ...resolved.access, model };
      const pricing = structuredClone(
        resolved.saved.modelPricing?.find((item) => item.model === model),
      );
      // A different saved connection checks candidates with its saved model.
      const second =
        input.validatorProviderId === undefined ||
        (input.validatorProviderId === input.providerId && resolved.saved.model === model)
          ? undefined
          : this.#store.resolveProvider(input.validatorProviderId);
      const secondPricing = second?.saved.modelPricing?.find(
        (item) => item.model === second.saved.model,
      );
      const validator = second && {
        provider: { id: second.saved.id, name: second.saved.name, model: second.saved.model },
        access: second.access,
        ...(secondPricing ? { pricing: structuredClone(secondPricing) } : {}),
        inputTokens: this.#store.providers.modelInputTokens(
          second.saved,
          second.access.apiKey,
          second.saved.model,
        ),
      };
      const inputTokens = this.#store.providers.modelInputTokens(
        resolved.saved,
        resolved.access.apiKey,
        model,
      );
      const revision = await sourceRevision(repository.path);
      if (this.#closed) throw new HttpError(503, "The service is shutting down.");
      repository.revision = revision;
      this.#store.security.saveRepository(repository);
      const job: SecurityScan = {
        id: randomUUID(),
        repositoryId: repository.id,
        sourceScanId: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: 0,
        status: "running",
        phase: "reading",
        initiatedBy: "Local user",
        scope: "local",
        depth: input.depth,
        provider: { id: resolved.saved.id, name: resolved.saved.name, model },
        ...(validator ? { validator: validator.provider } : {}),
        revision,
        environment: structuredClone(repository.environment),
        findingCount: 0,
        modelCalls: 0,
        tokens: null,
        cost: null,
        error: null,
        findings: [],
        reviews: [],
      };
      this.#store.security.saveScan(job);
      const controller = new AbortController();
      // Defer execution so the initial response and tracked operation are established first.
      const task = Promise.resolve()
        .then(async () => {
          const started = performance.now();
          try {
            const result = {
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              scan: await scan(repository.path),
              rules: RULES,
            };
            controller.signal.throwIfAborted();
            this.#store.saveScan(result);
            job.sourceScanId = result.id;
            this.#store.security.saveScan(job);
            if (!result.scan.files.length) {
              job.status = "failed";
              job.error =
                "No readable Python, JavaScript or TypeScript source files were found in this folder.";
            }
            // Earlier batches' files: whole ones are skipped, excerpts continue.
            const submitted: ReviewSourceFile[] = [];
            for (let batch = 0; batch < SCAN_DEPTHS[input.depth].batches; batch++) {
              controller.signal.throwIfAborted();
              const whole = new Set(
                submitted.filter((file) => !file.ranges).map((file) => file.path),
              );
              if (result.scan.files.every((file) => whole.has(file.path))) break;
              const review = await reviewProject(result.scan, {
                scanId: result.id,
                provider: job.provider ?? { id: "", name: "", model: "" },
                access,
                ...(pricing ? { pricing } : {}),
                signal: controller.signal,
                submitted,
                inputTokens,
                ...(validator ? { validator } : {}),
                environment: repository.environment,
                onPhase: (phase) => {
                  job.phase = phase;
                  this.#store.security.saveScan(job);
                },
              });
              // Exhausted readable source after a successful batch is coverage information.
              if (
                batch > 0 &&
                review.status === "failed" &&
                review.request.calls === 0 &&
                !review.scope.files.length
              )
                break;
              this.#store.reviews.save(review);
              job.reviews.push(review);
              job.cost = sumCosts(
                job.reviews.flatMap((item) => [
                  item.request.billing?.cost,
                  ...(item.request.validatorBilling ? [item.request.validatorBilling.cost] : []),
                ]),
              );
              job.modelCalls += review.request.calls;
              if (review.status !== "completed") {
                job.status = review.status === "cancelled" ? "cancelled" : "failed";
                job.error = review.reason ?? review.summary;
                break;
              }
              submitted.push(...review.scope.files);
            }
            const usage = job.reviews.map((review) => review.request.usage);
            job.tokens =
              usage.length && usage.every(Boolean)
                ? usage.reduce(
                    (sum, item) =>
                      sum +
                      (item ? item.inputTokens + item.outputTokens + item.additionalTokens : 0),
                    0,
                  )
                : null;
            if (job.status === "running") job.status = "completed";
            const previous = this.#store.security.findings(repository.id);
            job.findings = scanFindings(job, result.scan, RULES, job.reviews, previous);
            job.findingCount = job.findings.length;
            this.#store.security.saveFindings(
              job,
              vanishedStaticFindings(previous, job.findings, result.scan),
            );
          } catch {
            job.status = controller.signal.aborted ? "cancelled" : "failed";
            job.error = controller.signal.aborted
              ? "Scan cancelled."
              : "Unable to finish this scan. Check the folder and provider settings, then start a new scan.";
          } finally {
            job.phase = "finished";
            job.finishedAt = new Date().toISOString();
            job.durationMs = Math.round(performance.now() - started);
            this.#store.security.saveScan(job);
          }
        })
        .catch(() => {
          /* A storage failure cannot be repaired by retrying model calls. */
        });
      this.#supervisor.track(job.id, controller, task);
      return structuredClone(job);
    });
  }

  #importHistory(): void {
    if (this.#store.security.repositories().length) return;
    // Preserve saved scans and provider settings when installing the new workspace.
    for (const item of this.#store.scans.history().toReversed()) {
      const previous = this.#store.scans.readScan(item.id);
      if (!previous) continue;
      const repository = this.#store.security.add(
        item.project,
        item.project.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project",
        { commit: null, branch: null, dirty: null },
        { name: "Local workspace", notes: "" },
      );
      const reviews = this.#store.reviews.list(item.id).slice(0, 1);
      const review = reviews[0];
      const usage = review?.request.usage;
      const job: SecurityScan = {
        id: `imported-${item.id}`,
        repositoryId: repository.id,
        sourceScanId: item.id,
        startedAt: item.createdAt,
        finishedAt: review
          ? new Date(new Date(review.createdAt).getTime() + review.request.durationMs).toISOString()
          : item.createdAt,
        durationMs: previous.scan.durationMs + (review?.request.durationMs ?? 0),
        status:
          review && review.status !== "completed"
            ? review.status === "cancelled"
              ? "cancelled"
              : "failed"
            : "completed",
        phase: "finished",
        initiatedBy: "Imported history",
        scope: "local",
        depth: "standard",
        provider: reviews[0]?.provider ?? null,
        revision: repository.revision,
        findingCount: 0,
        modelCalls: reviews[0]?.request.calls ?? 0,
        tokens: usage ? usage.inputTokens + usage.outputTokens + usage.additionalTokens : null,
        error: review && review.status !== "completed" ? (review.reason ?? review.summary) : null,
        findings: [],
        reviews,
        environment: structuredClone(repository.environment),
      };
      const saved = this.#store.security.findings(repository.id);
      job.findings = scanFindings(job, previous.scan, previous.rules, reviews, saved);
      job.findingCount = job.findings.length;
      this.#store.security.saveFindings(
        job,
        vanishedStaticFindings(saved, job.findings, previous.scan),
      );
    }
  }
}
