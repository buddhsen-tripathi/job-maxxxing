export function deduplicateInMemory<T extends { fingerprint: string }>(
  jobs: readonly T[],
): { unique: T[]; duplicateCount: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const job of jobs) {
    if (seen.has(job.fingerprint)) continue;
    seen.add(job.fingerprint);
    unique.push(job);
  }
  return { unique, duplicateCount: jobs.length - unique.length };
}
