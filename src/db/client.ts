export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
