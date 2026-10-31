import { useEffect, useState } from "react";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import type { DashboardApi } from "../api/client.ts";

const WINDOW_LOOKUP_DELAY_MS = 300;

/**
 * The input window a scan with this model will use, as the host resolves it: the provider's
 * model catalog, else Models.dev. Null while loading or when unknown.
 */
export function useScanModelWindow(
  api: DashboardApi | null,
  provider: SavedProvider | undefined,
  model: string,
  active: boolean,
): number | null {
  const id = provider?.id;
  const key = `${id}:${model}`;
  const [loaded, setLoaded] = useState<{ key: string; inputTokens: number | null } | null>(null);
  useEffect(() => {
    if (!active || !api || !id || !model) return;
    const controller = new AbortController();
    // A typed model name settles before it is looked up.
    const timer = setTimeout(() => {
      api
        .modelWindow({ id, model }, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setLoaded({ key, inputTokens: result.inputTokens });
        })
        .catch(() => {
          /* The estimate keeps the default round size; the scan resolves its own window. */
        });
    }, WINDOW_LOOKUP_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, api, id, model, key]);
  return loaded?.key === key ? loaded.inputTokens : null;
}
