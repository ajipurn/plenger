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

function announce(message: string) {
  announcement = { message, revision: announcement.revision + 1 };
  for (const listener of listeners) listener();
}

/**
 * Confirm a finished action. The notch does not wrap and clips past 343px on a 375px
 * phone, so keep every toast message under about 35 characters.
 */
export function notifySuccess(message: string): void {
  announce(message);
  void import("notch-toast").then(({ toast }) => toast.success(message));
}

/** Report a finished action that did not change anything, such as a cancelled sign-in. */
export function notifyInfo(message: string): void {
  announce(message);
  void import("notch-toast").then(({ toast }) => toast.info(message));
}

/**
 * Show a short request the person waits on as one toast: progress, then its outcome. A
 * failure names its reason in the toast, so keep that reason short too.
 * Returns the request, so the caller handles its result and failure as before.
 */
export function notifyPromise<T>(
  request: Promise<T>,
  messages: {
    loading: string;
    success: (value: T) => string;
    error: (failure: unknown) => string;
  },
): Promise<T> {
  announce(messages.loading);
  void import("notch-toast").then(({ toast }) =>
    toast.promise(request, messages).catch(() => undefined),
  );
  request.then(
    (value) => announce(messages.success(value)),
    (failure) => announce(messages.error(failure)),
  );
  return request;
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
