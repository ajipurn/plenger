const DAY = 24 * 60 * 60 * 1000;

export function startOfWeek(date: Date, weekStartsOn = 1): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offset = (day.getUTCDay() - weekStartsOn + 7) % 7;
  return new Date(day.getTime() - offset * DAY);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
