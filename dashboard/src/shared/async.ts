import { useCallback, useState } from "react";

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Busy and error bookkeeping shared by one component's asynchronous actions.
 * `run` resolves to whether the task completed without throwing.
 */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(
    async (task: () => Promise<void>, fallback: string): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError("");
      try {
        await task();
        return true;
      } catch (failure) {
        setError(errorMessage(failure, fallback));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );
  return { busy, error, setError, run };
}
