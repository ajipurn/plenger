import { useLayoutEffect, useState } from "react";

/**
 * One saved appearance choice. It applies to the document at once and saves through the
 * service; a failed save puts the previous choice back.
 */
export function usePreference<T extends string>({
  initial,
  apply,
  save,
  announce,
  failure,
}: {
  initial: () => T;
  /** Mirrors the choice into the document. Keep it stable: it runs on every change. */
  apply: (value: T) => void;
  save: ((value: T) => Promise<unknown>) | null;
  announce: (value: T) => void;
  failure: string;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useLayoutEffect(() => apply(value), [apply, value]);

  async function choose(next: T) {
    if (!save || saving || next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    setError("");
    try {
      await save(next);
      announce(next);
    } catch {
      setValue(previous);
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  return { value, setValue, saving, error, choose };
}
