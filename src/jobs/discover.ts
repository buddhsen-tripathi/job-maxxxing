import { errorMessage } from "../shared/errors";
import { mapWithConcurrency } from "../shared/http";
import { createAshbyAdapter } from "../sources/ashby";
import { createGreenhouseAdapter } from "../sources/greenhouse";
import { createLeverAdapter } from "../sources/lever";
import type { JobSourceAdapter, SourceEntry } from "../sources/source-adapter";
import { deduplicateInMemory } from "./deduplicate";
import { computeFingerprint } from "./fingerprint";
import type { DiscoveryContext, NormalizedJob } from "./types";

export interface SourceFailure {
  source: string;
  company: string;
  error: string;
}

export interface DiscoveryOutcome {
  jobs: Array<NormalizedJob & { fingerprint: string }>;
  discoveredCount: number;
  duplicateCount: number;
  failures: SourceFailure[];
}

export function createAdapterForEntry(entry: SourceEntry): JobSourceAdapter {
  switch (entry.source) {
    case "greenhouse":
      return createGreenhouseAdapter(entry);
    case "lever":
      return createLeverAdapter(entry);
    case "ashby":
      return createAshbyAdapter(entry);
  }
}

const SOURCE_CONCURRENCY = 2;

export async function discoverFromSources(
  entries: readonly SourceEntry[],
  context: DiscoveryContext,
  options: { limit?: number } = {},
): Promise<DiscoveryOutcome> {
  const perEntry = await mapWithConcurrency(entries, SOURCE_CONCURRENCY, async (entry) => {
    const adapter = createAdapterForEntry(entry);
    try {
      const rawJobs = await adapter.discover(context);
      const normalized: NormalizedJob[] = [];
      for (const raw of rawJobs) {
        const job = adapter.normalize(raw);
        if (job) normalized.push({ ...job, discoveredAt: context.now.toISOString() });
      }
      return { entry, normalized, failure: null as SourceFailure | null };
    } catch (error) {
      const failure: SourceFailure = {
        source: adapter.name,
        company: entry.company,
        error: errorMessage(error),
      };
      context.logger.error({
        operation: "source_discover",
        source: adapter.name,
        company: entry.company,
        status: "failed",
        error: failure.error,
      });
      return { entry, normalized: [] as NormalizedJob[], failure };
    }
  });

  const failures = perEntry.flatMap((r) => (r.failure ? [r.failure] : []));
  const all = perEntry.flatMap((r) => r.normalized);
  const limited = options.limit !== undefined ? all.slice(0, options.limit) : all;

  const withFingerprints = await mapWithConcurrency(limited, 8, async (job) => ({
    ...job,
    fingerprint: await computeFingerprint(job),
  }));

  const { unique, duplicateCount } = deduplicateInMemory(withFingerprints);
  return {
    jobs: unique,
    discoveredCount: all.length,
    duplicateCount,
    failures,
  };
}
