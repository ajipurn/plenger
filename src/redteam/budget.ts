export interface BudgetLimits {
  maxModelCalls: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Other charged categories, if not already included in input/output tokens. */
  additionalTokens: number;
}

export interface ModelReservation {
  purpose: "setup" | "control" | "probe" | "retry";
  /** Computed by a trusted provider profile from the complete outgoing request. */
  inputTokensUpperBound: number;
  /** The transport must enforce this allowance on the actual provider request. */
  maxOutputTokens: number;
  additionalTokensUpperBound: number;
}

export type BudgetStopReason =
  | "model-call-limit"
  | "token-limit"
  | "deadline"
  | "cancelled"
  | "invalid-provider-response"
  | "invalid-provider-usage"
  | "provider-usage-exceeded-reservation";

export interface BudgetCall {
  id: number;
  purpose: ModelReservation["purpose"];
  state: "in-flight" | "succeeded" | "failed" | "interrupted";
  providerSettled: boolean;
  reservation: TokenUsage;
  usage: TokenUsage | null;
  accounting: "reserved" | "confirmed" | "unknown" | "overrun";
  accountedTokens: number;
}

export interface BudgetSnapshot {
  schemaVersion: 1;
  kind: "redteam-model-budget";
  /** A ledger for submitted dispatches; not proof of a worker's network isolation. */
  enforcementScope: "submitted-dispatches";
  state: "open" | "completed" | "stopped";
  limits: BudgetLimits;
  stopReasons: BudgetStopReason[];
  callsAdmitted: number;
  callsInFlight: number;
  providersUnsettled: number;
  observedTokens: number;
  outstandingReservedTokens: number;
  accountedTokens: number;
  remainingCalls: number;
  remainingTokens: number;
  calls: BudgetCall[];
}

export class BudgetStoppedError extends Error {
  readonly reason: BudgetStopReason;
  constructor(reason: BudgetStopReason) {
    super(`Model budget stopped: ${reason}`);
    this.reason = reason;
  }
}

/**
 * One controller per run, shared by every phase and retry. Admission is synchronous
 * before dispatch, including when callers race. It never retries or refunds an
 * admitted call. Provider errors/missing usage retain the full token reservation.
 *
 * Callers are trusted engine code, not workers supplying their own token counts.
 * A qualified transport must enforce the supplied output allowance and cannot
 * contain hidden provider retries. This class itself does not restrict networking.
 */
export class ModelBudget {
  readonly #limits: BudgetLimits;
  readonly #controller = new AbortController();
  readonly #calls: BudgetCall[] = [];
  readonly #interrupts = new Map<number, (error: BudgetStoppedError) => void>();
  readonly #stopReasons: BudgetStopReason[] = [];
  readonly #deadline: number;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort = () => this.cancel();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #state: BudgetSnapshot["state"] = "open";
  #accountedTokens = 0;

  constructor(limits: BudgetLimits, options: { signal?: AbortSignal } = {}) {
    validateBudgetLimits(limits);
    this.#limits = {
      maxModelCalls: limits.maxModelCalls,
      maxTokens: limits.maxTokens,
      timeoutMs: limits.timeoutMs,
    };
    this.#deadline = performance.now() + limits.timeoutMs;
    this.#externalSignal = options.signal;
    options.signal?.addEventListener("abort", this.#onExternalAbort, { once: true });
    if (options.signal?.aborted) this.cancel();
    else this.#armDeadline();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  async execute<T>(
    request: ModelReservation,
    dispatch: (allowance: {
      signal: AbortSignal;
      maxOutputTokens: number;
    }) => Promise<{ value: T; usage?: TokenUsage }>,
  ): Promise<T> {
    this.#expire();
    if (this.#state === "stopped")
      throw new BudgetStoppedError(this.#stopReasons[0] as BudgetStopReason);
    if (this.#state === "completed") throw new Error("Model budget is already completed.");
    const reservation = {
      inputTokens: request.inputTokensUpperBound,
      outputTokens: request.maxOutputTokens,
      additionalTokens: request.additionalTokensUpperBound,
    };
    if (!["setup", "control", "probe", "retry"].includes(request.purpose))
      throw new Error("Invalid model call purpose.");
    validateTokens(reservation);
    integer(reservation.outputTokens, "maxOutputTokens", 1);
    const reserved = total(reservation);
    if (this.#calls.length >= this.#limits.maxModelCalls) this.#stop("model-call-limit");
    else if (reserved > this.#limits.maxTokens - this.#accountedTokens) this.#stop("token-limit");
    if (this.signal.aborted) throw new BudgetStoppedError(this.#stopReasons[0] as BudgetStopReason);

    const call: BudgetCall = {
      id: this.#calls.length + 1,
      purpose: request.purpose,
      state: "in-flight",
      providerSettled: false,
      reservation,
      usage: null,
      accounting: "reserved",
      accountedTokens: reserved,
    };
    this.#calls.push(call);
    this.#accountedTokens += reserved;
    return new Promise<T>((resolve, reject) => {
      // Installed before dispatch: even a synchronous cancellation is accounted.
      this.#interrupts.set(call.id, reject);
      const failed = (error: unknown) => {
        this.#expire();
        call.providerSettled = true;
        call.accounting = "unknown";
        if (call.state === "in-flight") call.state = "failed";
        this.#interrupts.delete(call.id);
        reject(error);
      };
      try {
        const response = dispatch({
          signal: this.signal,
          maxOutputTokens: reservation.outputTokens,
        });
        Promise.resolve(response)
          .then((result) => {
            this.#expire();
            call.providerSettled = true;
            let value: T;
            let reportedUsage: TokenUsage | undefined;
            try {
              if (!result || typeof result !== "object" || !("value" in result)) throw new Error();
              value = result.value;
              reportedUsage = result.usage;
            } catch {
              call.accounting = "unknown";
              this.#stop("invalid-provider-response");
              return;
            }
            if (reportedUsage !== undefined) {
              let usage: TokenUsage;
              try {
                usage = {
                  inputTokens: reportedUsage.inputTokens,
                  outputTokens: reportedUsage.outputTokens,
                  additionalTokens: reportedUsage.additionalTokens,
                };
                validateTokens(usage);
              } catch {
                call.accounting = "unknown";
                this.#stop("invalid-provider-usage");
                return;
              }
              const overrun =
                usage.inputTokens > reservation.inputTokens ||
                usage.outputTokens > reservation.outputTokens ||
                usage.additionalTokens > reservation.additionalTokens;
              const actual = total(usage);
              // A profile violation never releases reserved capacity, even when a
              // different token category happened to cost less than its bound.
              const charged = overrun ? Math.max(actual, reserved) : actual;
              const nextAccounted = this.#accountedTokens - call.accountedTokens + charged;
              if (!Number.isSafeInteger(nextAccounted)) {
                call.accounting = "unknown";
                this.#stop("invalid-provider-usage");
                return;
              }
              call.usage = usage;
              this.#accountedTokens = nextAccounted;
              call.accountedTokens = charged;
              call.accounting = overrun ? "overrun" : "confirmed";
              if (overrun) {
                this.#stop("provider-usage-exceeded-reservation");
                return;
              }
            } else call.accounting = "unknown";
            this.#interrupts.delete(call.id);
            if (call.state === "in-flight") {
              call.state = "succeeded";
              resolve(value);
            }
            // Late replies can reconcile accounting after cancellation, but must
            // never turn an interrupted call/run into a successful one.
          }, failed)
          .catch(failed);
      } catch (error) {
        failed(error);
      }
    });
  }

  cancel(): void {
    if (this.#state !== "completed") this.#stop("cancelled");
  }

  /** Close admission after required work. A reached cap alone is not exhaustion. */
  finish(): BudgetSnapshot {
    this.#expire();
    if (this.#state === "open") {
      if (this.#interrupts.size > 0) throw new Error("Cannot finish with model calls in flight.");
      this.#state = "completed";
      this.#clearDeadline();
    }
    return this.snapshot();
  }

  snapshot(): BudgetSnapshot {
    this.#expire();
    return {
      schemaVersion: 1,
      kind: "redteam-model-budget",
      enforcementScope: "submitted-dispatches",
      state: this.#state,
      limits: { ...this.#limits },
      stopReasons: [...this.#stopReasons],
      callsAdmitted: this.#calls.length,
      callsInFlight: this.#interrupts.size,
      providersUnsettled: this.#calls.filter((call) => !call.providerSettled).length,
      observedTokens: this.#calls.reduce(
        (sum, call) => sum + (call.usage ? total(call.usage) : 0),
        0,
      ),
      outstandingReservedTokens: this.#calls.reduce(
        (sum, call) => sum + call.accountedTokens - (call.usage ? total(call.usage) : 0),
        0,
      ),
      accountedTokens: this.#accountedTokens,
      remainingCalls: Math.max(0, this.#limits.maxModelCalls - this.#calls.length),
      remainingTokens: Math.max(0, this.#limits.maxTokens - this.#accountedTokens),
      calls: this.#calls.map((call) => ({
        ...call,
        reservation: { ...call.reservation },
        usage: call.usage ? { ...call.usage } : null,
      })),
    };
  }

  #stop(reason: BudgetStopReason): void {
    if (this.#state === "completed") return;
    if (!this.#stopReasons.includes(reason)) this.#stopReasons.push(reason);
    this.#state = "stopped";
    this.#clearDeadline();
    const error = new BudgetStoppedError(this.#stopReasons[0] as BudgetStopReason);
    for (const call of this.#calls) if (call.state === "in-flight") call.state = "interrupted";
    for (const interrupt of this.#interrupts.values()) interrupt(error);
    this.#interrupts.clear();
    if (!this.signal.aborted) this.#controller.abort(error);
  }

  #expire(): void {
    if (this.#state === "open" && performance.now() >= this.#deadline) this.#stop("deadline");
  }

  #armDeadline(): void {
    this.#timer = setTimeout(
      () => {
        this.#expire();
        if (this.#state === "open") this.#armDeadline();
      },
      Math.max(1, Math.ceil(this.#deadline - performance.now())),
    );
  }

  #clearDeadline(): void {
    clearTimeout(this.#timer);
    this.#externalSignal?.removeEventListener("abort", this.#onExternalAbort);
  }
}

/** The bounds a `ModelBudget` accepts, checked without arming a deadline timer. */
export function validateBudgetLimits(limits: BudgetLimits): void {
  integer(limits.maxModelCalls, "maxModelCalls", 1, 100_000);
  integer(limits.maxTokens, "maxTokens", 1, Number.MAX_SAFE_INTEGER);
  integer(limits.timeoutMs, "timeoutMs", 1, 86_400_000);
}

function integer(
  value: number,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
}

function validateTokens(usage: TokenUsage): void {
  integer(usage.inputTokens, "inputTokens");
  integer(usage.outputTokens, "outputTokens");
  integer(usage.additionalTokens, "additionalTokens");
  integer(total(usage), "totalTokens");
}

function total(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.additionalTokens;
}
