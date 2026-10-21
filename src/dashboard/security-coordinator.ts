import { randomUUID } from "node:crypto";
import {
  batchCostBound,
  batchTokenBound,
  exploreCostBound,
  exploreTokenBound,
  type ReviewSourceFile,
  reviewBudget,
  type SpendingLimit,
} from "../assessment/review-model.ts";
import { reviewPaths } from "../assessment/review-source.ts";
import { reviewProject } from "../assessment/security-review.ts";
import { sumCosts } from "../redteam/model-pricing.ts";
import { validateProviderSettings } from "../redteam/provider-config.ts";
import { RULES } from "../rules/index.ts";
import { scan } from "../scan.ts";
import { scanFindings, vanishedStaticFindings } from "../security/findings.ts";
import { sourceRevision } from "../security/git.ts";
import {
  SCAN_DEPTHS,
  type ScanBudget,
  type ScanCoverage,
  type SecurityScan,
  type StartSecurityScan,
} from "../security/model.ts";
import { extendThreatModel, type ThreatModelContent } from "../security/threat-model.ts";
import type { DashboardStore } from "../storage/store.ts";
import { HttpError } from "./http.ts";
import type { OperationSupervisor } from "./operations.ts";

/** Lines the files hold that some review read, counting each line of each path once. */
function readLines(files: readonly ReviewSourceFile[]): number {
  const read = new Map<string, Set<number>>();
  for (const file of files) {
    const lines = read.get(file.path) ?? new Set<number>();
    for (const range of file.ranges ?? [{ line: 1, endLine: file.lines }])
      for (let line = range.line; line <= range.endLine; line++) lines.add(line);
    read.set(file.path, lines);
  }
  return [...read.values()].reduce((sum, lines) => sum + lines.size, 0);
}

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
      const mode = input.mode ?? "batch";
      // The most one batch, or one exploring review, can charge, for the limit checks.
      const sizes = reviewBudget([inputTokens, ...(validator ? [validator.inputTokens] : [])]);
      const most = {
        tokens: mode === "explore" ? exploreTokenBound().total : batchTokenBound(sizes).total,
        usd: Number.POSITIVE_INFINITY,
      };
      if (input.budget?.kind === "usd") {
        const priced =
          resolved.access.provider === "anthropic" &&
          pricing !== undefined &&
          (!second || (second.access.provider === "anthropic" && secondPricing !== undefined));
        if (!priced || !pricing)
          throw new HttpError(
            400,
            "A USD limit needs saved Claude prices for every model in this scan. Use a token limit, or add prices under Settings > Providers.",
          );
        most.usd =
          mode === "explore"
            ? exploreCostBound(pricing, secondPricing ?? pricing)
            : batchCostBound(sizes, pricing, secondPricing ?? pricing);
        if (input.budget.usd < most.usd)
          throw new HttpError(
            400,
            `The limit is below ${mode === "explore" ? "one exploring review's" : "one batch's"} maximum of USD ${most.usd.toFixed(2)}. Raise it, or choose a model with a smaller window.`,
          );
      }
      if (input.budget?.kind === "tokens" && input.budget.tokens < most.tokens)
        throw new HttpError(
          400,
          `The limit is below ${mode === "explore" ? "one exploring review's" : "one batch's"} maximum of ${most.tokens.toLocaleString("en-US")} tokens.`,
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
        mode,
        ...(input.budget ? { budget: structuredClone(input.budget) } : {}),
        provider: { id: resolved.saved.id, name: resolved.saved.name, model },
        ...(validator ? { validator: validator.provider } : {}),
        revision,
        environment: structuredClone(repository.environment),
        ...(repository.threatModel
          ? {
              threatModel: {
                version: repository.threatModel.version,
                origin: repository.threatModel.origin,
              },
            }
          : {}),
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
              scan: await scan(repository.path, { texts: true }),
              rules: RULES,
            };
            controller.signal.throwIfAborted();
            this.#store.saveScan(result);
            job.sourceScanId = result.id;
            this.#store.security.saveScan(job);
            const paths = reviewPaths(result.scan);
            const coverage: ScanCoverage = {
              eligibleFiles: paths.length,
              sentFiles: 0,
              stop: null,
              charged: { tokens: 0, usd: 0 },
            };
            job.coverage = coverage;
            if (!paths.length) {
              job.status = "failed";
              job.error =
                "No readable source, template or configuration files were found in this folder.";
            }
            // Each review starts from the project model; one the user wrote stays as written,
            // and one the reviews derived grows with every completed review.
            const start = repository.threatModel;
            let model: (ThreatModelContent & { origin: "review" | "user" }) | null = start
              ? {
                  origin: start.origin,
                  architecture: start.architecture,
                  assets: start.assets,
                  trustBoundaries: start.trustBoundaries,
                }
              : null;
            // Earlier batches' files: whole ones are skipped, excerpts continue.
            const submitted: ReviewSourceFile[] = [];
            let stop: ScanCoverage["stop"] = null;
            for (let batch = 0; ; batch++) {
              controller.signal.throwIfAborted();
              const whole = new Set(
                submitted.filter((file) => !file.ranges).map((file) => file.path),
              );
              if (paths.every((path) => whole.has(path))) {
                stop = "complete";
                break;
              }
              if (batch >= SCAN_DEPTHS[input.depth].batches) {
                stop = input.depth === "quick" ? "quick" : "limit";
                break;
              }
              const limit = remainingLimit(input.budget, coverage.charged);
              if (limit && !fitsLimit(limit, most)) {
                stop = "budget";
                break;
              }
              const review = await reviewProject(result.scan, {
                scanId: result.id,
                provider: job.provider ?? { id: "", name: "", model: "" },
                access,
                ...(pricing ? { pricing } : {}),
                signal: controller.signal,
                submitted,
                inputTokens,
                ...(validator ? { validator } : {}),
                ...(limit ? { limit } : {}),
                mode,
                // Later exploring reviews hear what earlier ones reported, so they look elsewhere.
                ...(mode === "explore" && job.reviews.length
                  ? {
                      earlier: job.reviews.flatMap((item) =>
                        item.findings.map((finding) => ({
                          title: finding.title,
                          cwe: finding.cwe,
                          at: `${finding.evidence[0]?.path}:${finding.evidence[0]?.line}`,
                        })),
                      ),
                    }
                  : {}),
                environment: repository.environment,
                ...(model ? { projectModel: model } : {}),
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
              ) {
                stop = "complete";
                break;
              }
              this.#store.reviews.save(review);
              job.reviews.push(review);
              job.cost = sumCosts(
                job.reviews.flatMap((item) => [
                  item.request.billing?.cost,
                  ...(item.request.validatorBilling ? [item.request.validatorBilling.cost] : []),
                ]),
              );
              job.modelCalls += review.request.calls;
              const charged = review.request.charged;
              coverage.charged = {
                tokens: coverage.charged.tokens + (charged?.tokens ?? 0),
                usd:
                  coverage.charged.usd === null || charged?.usd == null
                    ? null
                    : coverage.charged.usd + charged.usd,
              };
              if (review.status !== "completed") {
                // A limit reached inside a later batch ends coverage; earlier batches stand.
                if (review.request.limitReached && batch > 0) {
                  stop = "budget";
                  break;
                }
                job.status = review.status === "cancelled" ? "cancelled" : "failed";
                job.error = review.reason ?? review.summary;
                break;
              }
              if (model?.origin !== "user")
                model = { origin: "review", ...extendThreatModel(model, review) };
              const readBefore = readLines(submitted);
              submitted.push(...review.scope.files);
              coverage.sentFiles = new Set(submitted.map((file) => file.path)).size;
              // An exploring review that read nothing new would only repeat itself.
              if (mode === "explore" && readLines(submitted) === readBefore) {
                stop = "explored";
                this.#store.security.saveScan(job);
                break;
              }
              this.#store.security.saveScan(job);
            }
            if (job.status === "running") coverage.stop = stop;
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
            // The project keeps the model this scan extended, unless the user wrote one,
            // also while the scan ran.
            const saved = this.#store.security.repository(repository.id);
            if (
              job.status === "completed" &&
              model?.origin === "review" &&
              saved &&
              saved.threatModel?.origin !== "user"
            ) {
              saved.threatModel = {
                version: (saved.threatModel?.version ?? 0) + 1,
                updatedAt: new Date().toISOString(),
                origin: "review",
                scanId: job.id,
                architecture: model.architecture,
                assets: model.assets,
                trustBoundaries: model.trustBoundaries,
              };
              this.#store.security.saveRepository(saved);
            }
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

/** What remains of a scan's limit after `charged`, or undefined without a limit. */
function remainingLimit(
  budget: ScanBudget | undefined,
  charged: ScanCoverage["charged"],
): SpendingLimit | undefined {
  if (!budget) return undefined;
  if (budget.kind === "tokens")
    return { kind: "tokens", tokens: Math.max(0, budget.tokens - charged.tokens) };
  return { kind: "usd", usd: charged.usd === null ? 0 : Math.max(0, budget.usd - charged.usd) };
}

/** Whether one more batch's maximum fits what remains. */
function fitsLimit(limit: SpendingLimit, most: { tokens: number; usd: number }): boolean {
  return limit.kind === "tokens" ? limit.tokens >= most.tokens : limit.usd >= most.usd;
}
