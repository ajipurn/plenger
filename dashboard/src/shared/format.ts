/**
 * "medium" renders with Intl (e.g. "Oct 4, 2026, 9:41 AM"); "locale" keeps the
 * browser's `toLocaleString()` output used by run and campaign pickers.
 */
export function formatDateTime(value: string, style: "medium" | "locale" = "medium"): string {
  const date = new Date(value);
  if (style === "locale") return date.toLocaleString();
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

export function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

export function known(value: string | null): string {
  return value ?? "Not resolved";
}

export function observedList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "None observed";
}
