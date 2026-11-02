import { HttpError } from "./http.ts";

export const BUSY_MESSAGE = "Another project operation is running. Try again shortly.";

interface ActiveOperation {
  id: string;
  controller: AbortController;
  task: Promise<unknown>;
}

/**
 * One project operation at a time. Scans, plans and selection hold the lock for their
 * duration; a started run or campaign stays "active" until its task settles, so
 * nothing else may change saved state underneath it. One native folder dialog at a
 * time, independently of the lock.
 */
export class OperationSupervisor {
  #busy = false;
  #active: ActiveOperation | null = null;
  #pickingFolder = false;
  readonly #shutdown = new AbortController();

  /** 409 while any exclusive operation or managed run is in progress. */
  assertIdle(): void {
    if (this.#busy || this.#active) throw new HttpError(409, BUSY_MESSAGE);
  }

  /** Run `work` as the only operation; released when it settles. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.assertIdle();
    this.#busy = true;
    try {
      return await work();
    } finally {
      this.#busy = false;
    }
  }

  /** Hand a started run or campaign over; it counts as active until `task` settles. */
  track(id: string, controller: AbortController, task: Promise<unknown>): void {
    const active: ActiveOperation = {
      id,
      controller,
      task: task.finally(() => {
        if (this.#active === active) this.#active = null;
      }),
    };
    this.#active = active;
  }

  /** 409 unless `id` names the active operation. */
  assertActive(id: string | null): void {
    if (this.#active?.id !== id) throw new HttpError(409, "This run is no longer active.");
  }

  /** Abort the active operation if `id` names it; 409 otherwise. */
  cancel(id: string | null): void {
    this.assertActive(id);
    this.#active?.controller.abort();
  }

  /** Open the one native dialog; the signal fires when the dashboard shuts down. */
  async withFolderPicker<T>(open: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#pickingFolder)
      throw new HttpError(409, "A folder picker is already open. Finish or cancel that dialog.");
    this.#pickingFolder = true;
    try {
      return await open(this.#shutdown.signal);
    } finally {
      this.#pickingFolder = false;
    }
  }

  /** Signal every dialog and run to stop. `settled` then waits for them. */
  abortAll(): void {
    this.#shutdown.abort();
    this.#active?.controller.abort();
  }

  /** Resolves once the active run or campaign, if any, has finished persisting. */
  async settled(): Promise<void> {
    await this.#active?.task;
  }
}
