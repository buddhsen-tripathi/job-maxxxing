import { z } from "zod";
import type { DiscoveryContext, NormalizedJob, RawJob, WorkplaceType } from "../jobs/types";
import { errorMessage } from "../shared/errors";
import { fetchWithTimeout, mapWithConcurrency, stripHtml } from "../shared/http";
import type { JobSourceAdapter, WorkdaySourceEntry } from "./source-adapter";
import { SourceFetchError } from "./source-adapter";

const WorkdaySearchResponseSchema = z.object({
  total: z.number().optional(),
  jobPostings: z.array(
    z.object({
      title: z.string(),
      externalPath: z.string(),
      locationsText: z.string().optional(),
      postedOn: z.string().optional(),
      bulletFields: z.array(z.string()).optional(),
    }),
  ),
});

const WorkdayDetailSchema = z.object({
  jobPostingInfo: z.object({
    title: z.string().optional(),
    jobDescription: z.string().optional(),
    location: z.string().optional(),
    externalUrl: z.string().optional(),
    startDate: z.string().optional(),
    jobReqId: z.string().optional(),
    timeType: z.string().optional(),
    additionalLocations: z.array(z.string()).optional(),
  }),
});

type WorkdayPosting = z.infer<typeof WorkdaySearchResponseSchema>["jobPostings"][number];
type WorkdayDetail = z.infer<typeof WorkdayDetailSchema>;

const DETAIL_CONCURRENCY = 4;

function mapEmploymentType(timeType: string | undefined): string | undefined {
  const value = timeType?.toLowerCase();
  if (!value) return undefined;
  if (value.includes("full")) return "full_time";
  if (value.includes("part")) return "part_time";
  if (value.includes("contract") || value.includes("temp")) return "contract";
  if (value.includes("intern")) return "internship";
  return undefined;
}

function mapWorkplaceType(location: string | undefined): WorkplaceType {
  if (!location) return "unknown";
  return location.toLowerCase().includes("remote") ? "remote" : "unknown";
}

export function createWorkdayAdapter(entry: WorkdaySourceEntry): JobSourceAdapter {
  const apiBase = `https://${entry.host}/wday/cxs/${entry.tenant}/${entry.site}`;

  return {
    name: "workday",

    async discover(context: DiscoveryContext): Promise<RawJob[]> {
      const startedAt = Date.now();
      const searchResponse = await fetchWithTimeout(context.fetch, `${apiBase}/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": `job-maxxing/0.1 (personal job search; site=${entry.site})`,
        },
        body: JSON.stringify({ appliedFacets: {}, limit: entry.limit, offset: 0, searchText: "" }),
      });
      if (!searchResponse.ok) {
        throw new SourceFetchError(
          "workday",
          entry.company,
          `Workday site ${entry.host}/${entry.site} search returned HTTP ${searchResponse.status}`,
        );
      }
      let searchBody: unknown;
      try {
        searchBody = await searchResponse.json();
      } catch (error) {
        throw new SourceFetchError(
          "workday",
          entry.company,
          `Workday site ${entry.site} returned malformed JSON: ${errorMessage(error)}`,
        );
      }
      const search = WorkdaySearchResponseSchema.safeParse(searchBody);
      if (!search.success) {
        throw new SourceFetchError(
          "workday",
          entry.company,
          `Workday site ${entry.site} search response failed validation`,
        );
      }

      const postings = search.data.jobPostings;
      const details = await mapWithConcurrency(
        postings,
        DETAIL_CONCURRENCY,
        async (posting): Promise<{ posting: WorkdayPosting; detail: WorkdayDetail | null }> => {
          try {
            const detailResponse = await fetchWithTimeout(
              context.fetch,
              `${apiBase}${posting.externalPath}`,
              { headers: { Accept: "application/json" } },
            );
            if (!detailResponse.ok) return { posting, detail: null };
            const parsed = WorkdayDetailSchema.safeParse(await detailResponse.json());
            return { posting, detail: parsed.success ? parsed.data : null };
          } catch {
            return { posting, detail: null };
          }
        },
      );

      const jobs = details.flatMap(({ posting, detail }) =>
        detail
          ? [
              {
                source: "workday",
                company: entry.company,
                payload: { posting, detail, site: entry.site, host: entry.host },
              },
            ]
          : [],
      );
      context.logger.info({
        operation: "source_discover",
        source: "workday",
        company: entry.company,
        durationMs: Date.now() - startedAt,
        status: "ok",
        count: jobs.length,
        listedCount: postings.length,
      });
      return jobs;
    },

    normalize(raw: RawJob): NormalizedJob | null {
      const payload = raw.payload as {
        posting: WorkdayPosting;
        detail: WorkdayDetail;
        site: string;
        host: string;
      };
      const info = payload.detail.jobPostingInfo;
      const description = info.jobDescription ? stripHtml(info.jobDescription) : "";
      if (!description) return null;
      const location = info.location ?? payload.posting.locationsText;
      const employmentType = mapEmploymentType(info.timeType);
      const canonicalUrl = `https://${payload.host}/en-US/${payload.site}${payload.posting.externalPath}`;
      return {
        source: "workday",
        ...(info.jobReqId ? { sourceJobId: info.jobReqId } : {}),
        company: raw.company,
        title: (info.title ?? payload.posting.title).trim(),
        ...(location ? { location } : {}),
        ...(employmentType ? { employmentType } : {}),
        workplaceType: mapWorkplaceType(location),
        description,
        applyUrl: info.externalUrl ?? canonicalUrl,
        canonicalUrl,
        ...(info.startDate ? { postedAt: info.startDate } : {}),
        discoveredAt: new Date().toISOString(),
        rawPayload: raw.payload,
      };
    },
  };
}
