import { z } from "zod";
import type { SearchPreferences } from "../candidate/preferences";
import type { DiscoveryContext, NormalizedJob, RawJob } from "../jobs/types";
import { errorMessage } from "../shared/errors";
import { fetchWithTimeout, mapWithConcurrency, stripHtml } from "../shared/http";
import type { GreenhouseSourceEntry, JobSourceAdapter } from "./source-adapter";
import { SourceFetchError } from "./source-adapter";

const GreenhouseJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  location: z.object({ name: z.string() }).optional(),
  content: z.string().optional(),
  updated_at: z.string().optional(),
  metadata: z.array(z.object({ name: z.string(), value: z.unknown() })).nullish(),
});

const GreenhouseBoardResponseSchema = z.object({
  jobs: z.array(GreenhouseJobSchema),
});

/** Cap detail fetches per board so large boards stay within Worker limits. */
const MAX_DETAILS_PER_BOARD = 12;
const DETAIL_CONCURRENCY = 4;

const ENG_TITLE =
  /\b(software|engineer|developer|sde|machine learning|\bml\b|\bai\b|agentic|llm|platform|backend|frontend|full[\s-]?stack|new[\s-]?grad|university|early[\s-]?career|research scientist|applied scientist)\b/i;

function titleExcluded(title: string, excludedTitles: readonly string[]): boolean {
  const lower = title.toLowerCase();
  return excludedTitles.some((term) => term.trim() && lower.includes(term.trim().toLowerCase()));
}

function titlePreferred(title: string, preferredTitles: readonly string[]): boolean {
  const lower = title.toLowerCase();
  return preferredTitles.some((term) => term.trim() && lower.includes(term.trim().toLowerCase()));
}

function selectJobsForDetail(
  jobs: Array<z.infer<typeof GreenhouseJobSchema>>,
  preferences: SearchPreferences,
): Array<z.infer<typeof GreenhouseJobSchema>> {
  const eligible = jobs.filter((job) => !titleExcluded(job.title, preferences.excludedTitles));
  const preferred: typeof eligible = [];
  const relevant: typeof eligible = [];
  for (const job of eligible) {
    if (titlePreferred(job.title, preferences.titles)) preferred.push(job);
    else if (ENG_TITLE.test(job.title)) relevant.push(job);
  }
  return [...preferred, ...relevant].slice(0, MAX_DETAILS_PER_BOARD);
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  company: string,
  boardToken: string,
): Promise<unknown> {
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: {
      "User-Agent": `job-maxxing/0.1 (personal job search; board=${boardToken})`,
    },
  });
  if (!response.ok) {
    throw new SourceFetchError(
      "greenhouse",
      company,
      `Greenhouse board ${boardToken} returned HTTP ${response.status}`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new SourceFetchError(
      "greenhouse",
      company,
      `Greenhouse board ${boardToken} returned malformed JSON: ${errorMessage(error)}`,
    );
  }
}

export function createGreenhouseAdapter(entry: GreenhouseSourceEntry): JobSourceAdapter {
  return {
    name: "greenhouse",

    async discover(context: DiscoveryContext): Promise<RawJob[]> {
      const startedAt = Date.now();
      const listUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(entry.boardToken)}/jobs`;
      const listBody = await fetchJson(context.fetch, listUrl, entry.company, entry.boardToken);
      const listed = GreenhouseBoardResponseSchema.safeParse(listBody);
      if (!listed.success) {
        throw new SourceFetchError(
          "greenhouse",
          entry.company,
          `Greenhouse board ${entry.boardToken} response failed validation`,
        );
      }

      const selected = selectJobsForDetail(listed.data.jobs, context.preferences);
      const detailed = await mapWithConcurrency(selected, DETAIL_CONCURRENCY, async (job) => {
        const detailUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(entry.boardToken)}/jobs/${job.id}`;
        const detailBody = await fetchJson(
          context.fetch,
          detailUrl,
          entry.company,
          entry.boardToken,
        );
        const parsed = GreenhouseJobSchema.safeParse(detailBody);
        if (!parsed.success || !parsed.data.content) {
          return null;
        }
        const raw: RawJob = {
          source: "greenhouse",
          company: entry.company,
          payload: parsed.data,
        };
        return raw;
      });

      const rawJobs: RawJob[] = [];
      for (const job of detailed) {
        if (job) rawJobs.push(job);
      }
      context.logger.info({
        operation: "source_discover",
        source: "greenhouse",
        company: entry.company,
        durationMs: Date.now() - startedAt,
        status: "ok",
        count: rawJobs.length,
        listedCount: listed.data.jobs.length,
        selectedCount: selected.length,
      });
      return rawJobs;
    },

    normalize(raw: RawJob): NormalizedJob | null {
      const parsed = GreenhouseJobSchema.safeParse(raw.payload);
      if (!parsed.success) return null;
      const job = parsed.data;
      const locationName = job.location?.name;
      const description = job.content ? stripHtml(job.content) : "";
      if (!description) return null;
      const workplaceType = locationName?.toLowerCase().includes("remote") ? "remote" : "unknown";
      return {
        source: "greenhouse",
        sourceJobId: String(job.id),
        company: raw.company,
        title: job.title.trim(),
        ...(locationName ? { location: locationName } : {}),
        workplaceType,
        description,
        applyUrl: job.absolute_url,
        canonicalUrl: job.absolute_url,
        ...(job.updated_at ? { postedAt: job.updated_at } : {}),
        discoveredAt: new Date().toISOString(),
        rawPayload: raw.payload,
      };
    },
  };
}
