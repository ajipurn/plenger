import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderModel, ProviderModelsRequest } from "../../../src/dashboard/contract.ts";
import type { DashboardApi } from "../api/client.ts";
import { errorMessage } from "../shared/async.ts";

/** Restore saved catalogs locally. Only an explicit load can contact the provider. */
export function useProviderModels(api: DashboardApi | null) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const clear = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setModels([]);
    setLoaded(false);
    setLoading(false);
    setError("");
  }, []);
  const requestCatalog = useCallback(
    async (input: ProviderModelsRequest | string) => {
      if (!api) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError("");
      try {
        const result =
          typeof input === "string"
            ? await api.cachedProviderModels(input, controller.signal)
            : await api.providerModels(input, controller.signal);
        if (!controller.signal.aborted && result) {
          setModels(result.models);
          setLoaded(true);
          return result.models;
        }
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            errorMessage(failure, "Unable to load models. Check the API key and try again."),
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [api],
  );
  const load = useCallback(
    (input: ProviderModelsRequest) => requestCatalog(input),
    [requestCatalog],
  );
  const restore = useCallback((id: string) => requestCatalog(id), [requestCatalog]);
  return {
    models,
    loading,
    loaded,
    error,
    clear,
    load,
    restore,
  };
}
