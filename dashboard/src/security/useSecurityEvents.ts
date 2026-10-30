import { useEffect, useRef, useState } from "react";
import type { SecurityEvent } from "../../../src/dashboard/contract.ts";
import type { DashboardApi } from "../api/client.ts";

/** The first wait before reconnecting; each failure doubles it up to the maximum. */
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 15_000;

interface Subscriber {
  onEvent(event: SecurityEvent): void;
  onConnection(connected: boolean): void;
}
interface Hub {
  subscribers: Set<Subscriber>;
  connected: boolean;
  controller: AbortController | null;
}

// One stream per page: browsers allow few open connections to one host.
const hubs = new WeakMap<DashboardApi, Hub>();

function setConnected(hub: Hub, connected: boolean): void {
  if (hub.connected === connected) return;
  hub.connected = connected;
  for (const subscriber of hub.subscribers) subscriber.onConnection(connected);
}

async function connect(api: DashboardApi, hub: Hub, controller: AbortController): Promise<void> {
  let wait = RETRY_MS;
  while (!controller.signal.aborted) {
    try {
      await api.securityEvents(
        controller.signal,
        (event) => {
          for (const subscriber of hub.subscribers) subscriber.onEvent(event);
        },
        () => {
          wait = RETRY_MS;
          setConnected(hub, true);
        },
      );
    } catch {
      /* Reconnect below; subscribers poll meanwhile. */
    }
    // A stream aborted when its last subscriber left must not report on a newer one.
    if (controller.signal.aborted) return;
    setConnected(hub, false);
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  }
}

function join(api: DashboardApi, subscriber: Subscriber): () => void {
  let hub = hubs.get(api);
  if (!hub) {
    hub = { subscribers: new Set(), connected: false, controller: null };
    hubs.set(api, hub);
  }
  const joined = hub;
  joined.subscribers.add(subscriber);
  subscriber.onConnection(joined.connected);
  if (!joined.controller) {
    joined.controller = new AbortController();
    void connect(api, joined, joined.controller);
  }
  return () => {
    joined.subscribers.delete(subscriber);
    if (joined.subscribers.size) return;
    joined.controller?.abort();
    joined.controller = null;
    setConnected(joined, false);
  };
}

/**
 * Scan events the local service pushes, while `enabled`. Returns whether the stream is
 * open: callers poll while it is not and load again when it opens.
 */
export function useSecurityEvents(
  api: DashboardApi | null,
  enabled: boolean,
  onEvent: (event: SecurityEvent) => void,
): boolean {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  const [connected, setOpen] = useState(false);
  useEffect(() => {
    if (!api || !enabled) {
      setOpen(false);
      return;
    }
    return join(api, {
      onEvent: (event) => handler.current(event),
      onConnection: setOpen,
    });
  }, [api, enabled]);
  return enabled && connected;
}
