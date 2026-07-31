export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function utcDateKey(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

export function formatNyDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
