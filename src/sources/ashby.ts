import { z } from "zod";
import type { SearchPreferences } from "../candidate/preferences";
import type { DiscoveryContext, NormalizedJob, RawJob, WorkplaceType } from "../jobs/types";
import { errorMessage } from "../shared/errors";
import { fetchWithTimeout, stripHtml } from "../shared/http";
import type { AshbySourceEntry, JobSourceAdapter } from "./source-adapter";
import { SourceFetchError } from "./source-adapter";

const AshbyJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  department: z.string().nullish(),
  team: z.string().nullish(),
  employmentType: z.string().nullish(),
  location: z.string().nullish(),
  isListed: z.boolean().optional(),
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  jobUrl: z.string(),
  applyUrl: z.string().optional(),
  publishedAt: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
});

const AshbyBoardResponseSchema = z.object({
  jobs: z.array(AshbyJobSchema),
});

/** Cap jobs kept per board so large Ashby boards stay within Worker limits. */
const MAX_JOBS_PER_BOARD = 40;

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

function selectJobs(
  jobs: Array<z.infer<typeof AshbyJobSchema>>,
  preferences: SearchPreferences,
): Array<z.infer<typeof AshbyJobSchema>> {
  const listed = jobs.filter((job) => job.isListed !== false);
  const eligible = listed.filter((job) => !titleExcluded(job.title, preferences.excludedTitles));
  const preferred: typeof eligible = [];
  const relevant: typeof eligible = [];
  for (const job of eligible) {
    if (titlePreferred(job.title, preferences.titles)) preferred.push(job);
    else if (ENG_TITLE.test(job.title)) relevant.push(job);
  }
  return [...preferred, ...relevant].slice(0, MAX_JOBS_PER_BOARD);
}

function mapWorkplaceType(
  value: string | null | undefined,
  isRemote: boolean | null | undefined,
): WorkplaceType {
  switch (value?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
    case "on-site":
      return "onsite";
    default:
      if (isRemote) return "remote";
      return "unknown";
  }
}

function mapEmploymentType(value: string | null | undefined): string | undefined {
  switch (value?.toLowerCase().replace(/[\s-]+/g, "")) {
    case "fulltime":
      return "full_time";
    case "parttime":
      return "part_time";
    case "contract":
      return "contract";
    case "intern":
    case "internship":
      return "internship";
    case "temporary":
      return "contract";
    default:
      return undefined;
  }
}

export function createAshbyAdapter(entry: AshbySourceEntry): JobSourceAdapter {
  return {
    name: "ashby",

    async discover(context: DiscoveryContext): Promise<RawJob[]> {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(entry.boardSlug)}`;
      const startedAt = Date.now();
      const response = await fetchWithTimeout(context.fetch, url, {
        headers: {
          "User-Agent": `job-maxxing/0.1 (personal job search; board=${entry.boardSlug})`,
        },
      });
      if (!response.ok) {
        throw new SourceFetchError(
          "ashby",
          entry.company,
          `Ashby board ${entry.boardSlug} returned HTTP ${response.status}`,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new SourceFetchError(
          "ashby",
          entry.company,
          `Ashby board ${entry.boardSlug} returned malformed JSON: ${errorMessage(error)}`,
        );
      }
      const parsed = AshbyBoardResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new SourceFetchError(
          "ashby",
          entry.company,
          `Ashby board ${entry.boardSlug} response failed validation`,
        );
      }
      const selected = selectJobs(parsed.data.jobs, context.preferences);
      context.logger.info({
        operation: "source_discover",
        source: "ashby",
        company: entry.company,
        durationMs: Date.now() - startedAt,
        status: "ok",
        count: selected.length,
        listedCount: parsed.data.jobs.length,
      });
      return selected.map((job) => ({
        source: "ashby",
        company: entry.company,
        payload: job,
      }));
    },

    normalize(raw: RawJob): NormalizedJob | null {
      const parsed = AshbyJobSchema.safeParse(raw.payload);
      if (!parsed.success) return null;
      const job = parsed.data;
      const description = job.descriptionPlain?.trim()
        ? job.descriptionPlain.trim()
        : job.descriptionHtml
          ? stripHtml(job.descriptionHtml)
          : "";
      if (!description) return null;
      const employmentType = mapEmploymentType(job.employmentType);
      return {
        source: "ashby",
        sourceJobId: job.id,
        company: raw.company,
        title: job.title.trim(),
        ...(job.location ? { location: job.location } : {}),
        ...(employmentType ? { employmentType } : {}),
        workplaceType: mapWorkplaceType(job.workplaceType, job.isRemote),
        description,
        applyUrl: job.applyUrl ?? job.jobUrl,
        canonicalUrl: job.jobUrl,
        ...(job.publishedAt ? { postedAt: job.publishedAt } : {}),
        discoveredAt: new Date().toISOString(),
        rawPayload: raw.payload,
      };
    },
  };
}
