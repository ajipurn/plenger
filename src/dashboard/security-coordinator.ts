import { randomUUID } from "node:crypto";
import {
  batchCostBound,
  batchTokenBound,
  exploreCostBound,
  exploreTokenBound,
  type ReviewSourceFile,
  reviewBudget,
  type SecurityReview,
  type SpendingLimit,
} from "../assessment/review-model.ts";
import { reviewPaths } from "../assessment/review-source.ts";
import { reviewProject } from "../assessment/security-review.ts";
import { sumCosts } from "../redteam/model-pricing.ts";
import {
  modelPricingProvider,
  type SavedProvider,
  validateProviderSettings,
} from "../redteam/provider-config.ts";
import { RULES } from "../rules/index.ts";
import { type ScanResult, scan } from "../scan.ts";
import { scanFindings, vanishedStaticFindings } from "../security/findings.ts";
import { sourceRevision } from "../security/git.ts";
import {
  canContinue,
  remainingBudget,
  SCAN_ACTIVITY_LIMIT,
  SCAN_DEPTHS,
  type ScanActivity,
  type ScanBudget,
  type ScanCoverage,
  type ScanReply,
  SERVICE_STOPPED_PAUSE,
  type SecurityScan,
  type StartSecurityScan,
} from "../security/model.ts";
import { extendThreatModel, type ThreatModelContent } from "../security/threat-model.ts";
import { reportedScanTokens } from "../security/usage.ts";
import type { DashboardStore } from "../storage/store.ts";
import type { SecurityEvent } from "./contract.ts";
import { HttpError } from "./http.ts";
import type { ModelPricingCatalog } from "./model-pricing.ts";
import type { ModelWindowCatalog } from "./model-windows.ts";
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

/** Reply events go out at most this often per scan; a reply that ends goes out at once. */
const REPLY_EVENT_MS = 250;

/** Background scans survive page navigation. The same supervisor protects legacy operations. */
export class SecurityCoordinator {
  readonly #store: DashboardStore;
  readonly #supervisor: OperationSupervisor;
  #closed = false;
  // Pause and Stop both abort a run; scans named here end paused instead of stopped.
  readonly #pausing = new Set<string>();
  readonly #listeners = new Set<(event: SecurityEvent) => void>();
  // Replies stream too fast to save; they live here until their request ends.
  readonly #replies = new Map<string, ScanReply>();
  readonly #replyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #pricing: ModelPricingCatalog | undefined;
  readonly #windows: ModelWindowCatalog | undefined;
  constructor(
    store: DashboardStore,
    supervisor: OperationSupervisor,
    pricing?: ModelPricingCatalog,
    windows?: ModelWindowCatalog,
  ) {
    this.#store = store;
    this.#supervisor = supervisor;
    this.#pricing = pricing;
    this.#windows = windows;
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
    for (const timer of this.#replyTimers.values()) clearTimeout(timer);
    this.#replyTimers.clear();
  }

  /** Every scan save and reply update, until the returned function unsubscribes. */
  subscribe(listener: (event: SecurityEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The reply a running scan is receiving, if a request is under way. */
  reply(id: string): ScanReply | undefined {
    return this.#replies.get(id);
  }

  #emit(event: SecurityEvent): void {
    for (const listener of this.#listeners)
      try {
        listener(event);
      } catch {
        /* One closed stream must not stop the others or the scan. */
      }
  }

  #saveScan(job: SecurityScan): void {
    this.#store.security.saveScan(job);
    this.#emit({ type: "scan", id: job.id });
  }

  /** The model's input window, which sizes each round; null keeps the default round size. */
  async #inputTokens(
    saved: SavedProvider,
    apiKey: string | undefined,
    model: string,
  ): Promise<number | null> {
    return this.#windows
      ? this.#windows.forScan(saved, apiKey, model)
      : this.#store.providers.modelInputTokens(saved, apiKey, model);
  }

  /** Hold a scan's reply and send it on: the first update at once, then the latest each interval. */
  #reply(id: string, reply: ScanReply | null): void {
    if (!reply) {
      clearTimeout(this.#replyTimers.get(id));
      this.#replyTimers.delete(id);
      if (this.#replies.delete(id)) this.#emit({ type: "reply", id, reply: null });
      return;
    }
    this.#replies.set(id, reply);
    if (this.#replyTimers.has(id)) return;
    this.#emit({ type: "reply", id, reply });
    const later = (sent: ScanReply) =>
      setTimeout(() => {
        const latest = this.#replies.get(id);
        if (latest && latest !== sent) {
          this.#emit({ type: "reply", id, reply: latest });
          this.#replyTimers.set(id, later(latest));
        } else this.#replyTimers.delete(id);
      }, REPLY_EVENT_MS);
    this.#replyTimers.set(id, later(reply));
  }

  /**
   * Continue a Full coverage scan that paused or stopped at its limit, under a new limit for
   * what it spends from now on. It keeps the saved static scan and earlier reviews; later
   * batches skip files sent whole and continue excerpts, as within one run. A paused scan
   * whose run had no limit continues without one.
   */
  async continueScan(id: string, budget?: ScanBudget): Promise<SecurityScan> {
    const previous = this.#store.security.scan(id);
    if (!previous) throw new HttpError(404, "Scan not found.");
    if (!canContinue(previous) || !previous.provider)
      throw new HttpError(
        400,
        "Only a Full coverage scan that paused, stopped at its limit, or whose later round failed, can continue.",
      );
    if (!budget && (previous.status !== "paused" || remainingBudget(previous)))
      throw new HttpError(400, "Set a limit to continue the scan.");
    return this.start(
      {
        repositoryId: previous.repositoryId,
        providerId: previous.provider.id,
        model: previous.provider.model,
        ...(previous.validator
          ? {
              validatorProviderId: previous.validator.id,
              validatorModel: previous.validator.model,
            }
          : {}),
        depth: "full",
        mode: previous.mode ?? "batch",
        ...(budget ? { budget } : {}),
      },
      previous,
    );
  }

  /**
   * Pause a running Full coverage scan. It stops now like Stop; its finished rounds stay,
   * and Continue runs the rest, starting again with the round that was running.
   */
  pause(id: string): void {
    const scan = this.#store.security.scan(id);
    if (!scan) throw new HttpError(404, "Scan not found.");
    if (scan.status !== "running" || scan.depth !== "full")
      throw new HttpError(409, "Only a running Full coverage scan can pause.");
    this.#pausing.add(id);
    try {
      this.#supervisor.cancel(id);
    } catch (error) {
      this.#pausing.delete(id);
      throw error;
    }
  }

  async start(input: StartSecurityScan, continued?: SecurityScan): Promise<SecurityScan> {
    return this.#supervisor.exclusive(async () => {
      if (
        continued &&
        this.#store.security.workspace().scans.some((item) => item.status === "running")
      )
        throw new HttpError(409, "Wait for the running scan to finish.");
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
        this.#pricing
          ? await this.#pricing.forScan(resolved.saved, model)
          : resolved.saved.modelPricing?.find((item) => item.model === model),
      );
      // Validation may use another connection, another model, or both.
      const second =
        input.validatorProviderId === undefined ||
        (input.validatorProviderId === input.providerId &&
          (input.validatorModel ?? resolved.saved.model) === model)
          ? undefined
          : this.#store.resolveProvider(input.validatorProviderId);
      const secondAccess = second && {
        ...second.access,
        model: input.validatorModel ?? second.saved.model,
      };
      if (secondAccess) {
        try {
          validateProviderSettings(secondAccess);
        } catch {
          throw new HttpError(400, "Choose a valid model for the validation provider.");
        }
      }
      const secondPricing =
        second && secondAccess
          ? this.#pricing
            ? await this.#pricing.forScan(second.saved, secondAccess.model)
            : second.saved.modelPricing?.find((item) => item.model === secondAccess.model)
          : undefined;
      const validator = second &&
        secondAccess && {
          provider: { id: second.saved.id, name: second.saved.name, model: secondAccess.model },
          access: secondAccess,
          ...(secondPricing ? { pricing: structuredClone(secondPricing) } : {}),
          inputTokens: await this.#inputTokens(
            second.saved,
            second.access.apiKey,
            secondAccess.model,
          ),
        };
      const inputTokens = await this.#inputTokens(resolved.saved, resolved.access.apiKey, model);
      const mode = input.mode ?? "batch";
      // The most one batch, or one exploring review, can charge, for the limit checks.
      const sizes = reviewBudget([inputTokens, ...(validator ? [validator.inputTokens] : [])]);
      const most = {
        tokens: mode === "explore" ? exploreTokenBound().total : batchTokenBound(sizes).total,
        usd: Number.POSITIVE_INFINITY,
      };
      if (input.budget?.kind === "usd") {
        const priced =
          modelPricingProvider(resolved.access.provider) &&
          pricing !== undefined &&
          (!second ||
            (modelPricingProvider(second.access.provider) && secondPricing !== undefined));
        if (!priced || !pricing)
          throw new HttpError(
            400,
            "A USD limit needs model prices for every model in this scan. Use a token limit, or refresh prices under Settings > Providers.",
          );
        most.usd =
          mode === "explore"
            ? exploreCostBound(pricing, secondPricing ?? pricing)
            : batchCostBound(sizes, pricing, secondPricing ?? pricing);
        if (input.budget.usd < most.usd)
          throw new HttpError(
            400,
            `The limit is below one round's maximum of USD ${most.usd.toFixed(2)}. Raise it, or choose a model with a smaller window.`,
          );
      }
      if (input.budget?.kind === "tokens" && input.budget.tokens < most.tokens)
        throw new HttpError(
          400,
          `The limit is below one round's maximum of ${most.tokens.toLocaleString("en-US")} tokens.`,
        );
      const revision = await sourceRevision(repository.path);
      if (this.#closed) throw new HttpError(503, "The service is shutting down.");
      repository.revision = revision;
      this.#store.security.saveRepository(repository);
      const before = continued?.durationMs ?? 0;
      const job: SecurityScan = continued
        ? Object.assign(continued, {
            status: "running" as const,
            phase: "reading" as const,
            finishedAt: null,
            error: null,
            continuations: [
              ...(continued.continuations ?? []),
              {
                at: new Date().toISOString(),
                ...(input.budget ? { budget: structuredClone(input.budget) } : {}),
                charged: structuredClone(continued.coverage?.charged ?? { tokens: 0, usd: 0 }),
              },
            ],
          })
        : {
            id: randomUUID(),
            repositoryId: repository.id,
            sourceScanId: null,
            workflow: "all",
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
      this.#saveScan(job);
      // The live timeline: recent requests, tool calls and batch results, saved at most
      // once a second while a review runs.
      let savedAt = 0;
      const activity = (entry: Omit<ScanActivity, "at">) => {
        job.activity = [...(job.activity ?? []), { at: new Date().toISOString(), ...entry }].slice(
          -SCAN_ACTIVITY_LIMIT,
        );
        if (entry.kind === "batch" || performance.now() - savedAt > 1000) {
          savedAt = performance.now();
          this.#saveScan(job);
        }
      };
      const controller = new AbortController();
      // Stop, Pause and closing the service abort the run. The round that was running stays
      // as a record of what it charged; a paused scan runs that round again when it continues.
      // Closing pauses a Full coverage scan too, so it can continue after a restart.
      const stopped = () => {
        const asked = this.#pausing.has(job.id);
        const paused = input.depth === "full" && (asked || this.#closed);
        job.status = paused ? "paused" : "cancelled";
        job.error = paused && !asked ? SERVICE_STOPPED_PAUSE : null;
      };
      // Defer execution so the initial response and tracked operation are established first.
      const task = Promise.resolve()
        .then(async () => {
          const started = performance.now();
          let captured: ScanResult | undefined;
          try {
            // A continued scan keeps its static scan, so earlier reviews still describe it.
            const kept = continued?.sourceScanId
              ? this.#store.scans.readScan(continued.sourceScanId)
              : null;
            if (continued && !kept) throw new Error("missing-static-scan");
            const result = kept ?? {
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              scan: await scan(repository.path, { texts: true }),
              rules: RULES,
            };
            captured = result.scan;
            controller.signal.throwIfAborted();
            if (!kept) {
              job.staticCompletedAt = new Date().toISOString();
              this.#store.saveScan(result);
              job.sourceScanId = result.id;
              this.#saveScan(job);
            }
            const paths = reviewPaths(result.scan);
            const coverage: ScanCoverage = continued?.coverage
              ? { ...continued.coverage, stop: null }
              : {
                  eligibleFiles: paths.length,
                  sentFiles: 0,
                  stop: null,
                  charged: { tokens: 0, usd: 0 },
                };
            // A new limit counts what the scan charges from now on.
            const offset = structuredClone(coverage.charged);
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
            const submitted: ReviewSourceFile[] = job.reviews
              .filter((item) => item.status === "completed")
              .flatMap((item) => item.scope.files);
            // A continuation may retry undecided static candidates; this run never retries them.
            const resumedAt = job.reviews.length;
            let stop: ScanCoverage["stop"] = null;
            const updateUsage = (request?: SecurityReview["request"]) => {
              const reports = [
                ...job.reviews,
                ...(request ? [{ request, validator: job.validator }] : []),
              ];
              const usage = reportedScanTokens(reports);
              job.tokens = usage?.tokens ?? null;
              if (usage) job.tokensComplete = usage.complete;
              job.modelCalls = reports.reduce((sum, item) => sum + item.request.calls, 0);
              const billings = reports.flatMap((item) => [
                item.request.billing,
                ...(item.validator ? [item.request.validatorBilling] : []),
              ]);
              // An unused validator's zero-cost snapshot is not reported consumption.
              job.cost = billings.some((billing) => billing?.cost && billing.usage.length)
                ? sumCosts(billings.map((billing) => billing?.cost))
                : null;
            };
            for (let batch = job.reviews.length; ; batch++) {
              controller.signal.throwIfAborted();
              const whole = new Set(
                submitted.filter((file) => !file.ranges).map((file) => file.path),
              );
              const reviewedStatic = job.reviews.flatMap((item, index) =>
                (item.staticFindings ?? [])
                  .filter((finding) => finding.validation !== "unvalidated" || index >= resumedAt)
                  .map((finding) => finding.static.fingerprint),
              );
              const pendingStatic = result.scan.findings.some(
                (finding) => !reviewedStatic.includes(finding.fingerprint),
              );
              const sourceCovered = paths.every((path) => whole.has(path));
              if (sourceCovered && !pendingStatic) {
                stop = "complete";
                break;
              }
              if (batch >= SCAN_DEPTHS[input.depth].batches) {
                stop = input.depth === "quick" ? "quick" : "limit";
                break;
              }
              const limit = remainingLimit(input.budget, {
                tokens: coverage.charged.tokens - offset.tokens,
                usd:
                  coverage.charged.usd === null || offset.usd === null
                    ? null
                    : coverage.charged.usd - offset.usd,
              });
              if (limit && !fitsLimit(limit, most)) {
                stop = "budget";
                break;
              }
              this.#store.reviews.assertCapacity(result.id);
              const review = await reviewProject(result.scan, {
                scanId: result.id,
                provider: job.provider ?? { id: "", name: "", model: "" },
                access,
                ...(pricing ? { pricing } : {}),
                signal: controller.signal,
                submitted: sourceCovered ? [] : submitted,
                reviewedStatic,
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
                onActivity: (event) =>
                  activity({
                    batch,
                    kind: event.kind,
                    detail: event.detail,
                    tokens: coverage.charged.tokens + event.tokens,
                  }),
                onPhase: (phase) => {
                  job.phase = phase;
                  this.#saveScan(job);
                },
                onUsage: (request) => {
                  // A timed-out provider may settle after this round or scan has ended.
                  if (
                    job.status !== "running" ||
                    controller.signal.aborted ||
                    job.reviews.length !== batch
                  )
                    return;
                  updateUsage(request);
                  this.#saveScan(job);
                },
                onReply: (reply) => {
                  // As with usage, a provider that settles late must not overwrite a later round.
                  if (
                    job.status !== "running" ||
                    controller.signal.aborted ||
                    job.reviews.length !== batch
                  )
                    return;
                  this.#reply(job.id, reply && { ...reply, batch });
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
              updateUsage();
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
                if (review.status === "cancelled") stopped();
                else {
                  job.status = "failed";
                  job.error = review.reason ?? review.summary;
                }
                break;
              }
              if (model?.origin !== "user")
                model = { origin: "review", ...extendThreatModel(model, review) };
              const reported = review.findings.filter((item) => item.validation !== "dismissed");
              activity({
                batch,
                kind: "batch",
                detail: `Round ${batch + 1} finished: ${review.scope.files.length} ${review.scope.files.length === 1 ? "file" : "files"}, ${reported.length} ${reported.length === 1 ? "finding" : "findings"}`,
                tokens: coverage.charged.tokens,
              });
              const readBefore = readLines(submitted);
              submitted.push(...review.scope.files);
              coverage.sentFiles = new Set(submitted.map((file) => file.path)).size;
              if (review.request.limitReached) {
                stop = "budget";
                this.#saveScan(job);
                break;
              }
              // Without new source or static candidates, another round would repeat itself.
              if (
                (mode === "explore" || sourceCovered) &&
                readLines(submitted) === readBefore &&
                !review.staticFindings?.length
              ) {
                stop = "explored";
                this.#saveScan(job);
                break;
              }
              this.#saveScan(job);
            }
            if (job.status === "running") coverage.stop = stop;
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
          } catch {
            if (controller.signal.aborted) stopped();
            else {
              job.status = "failed";
              job.error =
                "Unable to finish this scan. Check the folder and provider settings, then start a new scan.";
            }
          } finally {
            this.#pausing.delete(job.id);
            this.#reply(job.id, null);
            job.phase = "finished";
            job.finishedAt = new Date().toISOString();
            job.durationMs = before + Math.round(performance.now() - started);
            if (captured && job.sourceScanId) {
              const previous = this.#store.security.findings(repository.id);
              job.findings = scanFindings(job, captured, RULES, job.reviews, previous);
              job.findingCount = job.findings.filter(
                (finding) => finding.validationStatus !== "dismissed",
              ).length;
              this.#store.security.saveFindings(
                job,
                vanishedStaticFindings(previous, job.findings, captured),
              );
              this.#emit({ type: "scan", id: job.id });
            } else this.#saveScan(job);
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
