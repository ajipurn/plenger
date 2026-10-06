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

/** "3 hours ago", "yesterday", "2 weeks ago"; dates far back fall back to the medium date. */
export function formatRelativeTime(value: string, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86_400],
    ["week", 604_800],
  ];
  if (Math.abs(seconds) < 60) return "just now";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (
      Math.abs(seconds) <
      size * (unit === "week" ? 5 : unit === "day" ? 7 : unit === "hour" ? 24 : 60)
    )
      return format.format(Math.round(seconds / size), unit);
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
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

/** "48 s", "2 min 14 s", "10 min", "1 h 05 min"; negative or invalid input reads as zero. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  if (minutes) return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  return `${seconds} s`;
}
