/** Amounts are stored in minor units (cents). */
export function amount(minutes: number, hourlyRateMinor: number): number {
  return Math.round((minutes * hourlyRateMinor) / 60);
}

export function formatMinor(minor: number, currency: string, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}
