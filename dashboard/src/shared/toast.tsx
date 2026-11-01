import { lazy, Suspense, useSyncExternalStore } from "react";

// Motion is most of Notch Toast's weight and no toast shows before an action finishes, so
// it loads after the first render. Both imports share one module and so one toast store.
const NotchToaster = lazy(() =>
  import("notch-toast").then((module) => ({ default: module.NotchToaster })),
);

// Notch Toast hides its text from assistive technology and mounts its live region with the
// message already inside, which screen readers often skip. A live region that is always
// present announces the same message.
let announcement = { message: "", revision: 0 };
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Confirm a finished action whose own controls have closed. The notch does not wrap and
 * clips past 343px on a 375px phone, so keep the message under about 35 characters.
 */
export function notifySuccess(message: string): void {
  announcement = { message, revision: announcement.revision + 1 };
  for (const listener of listeners) listener();
  void import("notch-toast").then(({ toast }) => toast.success(message));
}

/** Mount once at the root. */
export function Toaster() {
  const { message, revision } = useSyncExternalStore(subscribe, () => announcement);
  return (
    <>
      <Suspense fallback={null}>
        <NotchToaster />
      </Suspense>
      <p className="sr-only" role="status">
        {/* A new node per message, so repeating the same message is announced again. */}
        <span key={revision}>{message}</span>
      </p>
    </>
  );
}
