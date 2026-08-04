export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function utcDateKey(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

/** Lock key for a 6-hour UTC window (00, 06, 12, 18), e.g. "2026-08-04T12". */
export function utcSixHourSlotKey(date: Date): string {
  const hour = Math.floor(date.getUTCHours() / 6) * 6;
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour),
  )
    .toISOString()
    .slice(0, 13);
}

export function formatNyDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
