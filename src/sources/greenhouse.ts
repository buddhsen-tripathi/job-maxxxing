import { z } from "zod";
import type { DiscoveryContext, NormalizedJob, RawJob } from "../jobs/types";
import { errorMessage } from "../shared/errors";
import { fetchWithTimeout, stripHtml } from "../shared/http";
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

export function createGreenhouseAdapter(entry: GreenhouseSourceEntry): JobSourceAdapter {
  return {
    name: "greenhouse",

    async discover(context: DiscoveryContext): Promise<RawJob[]> {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(entry.boardToken)}/jobs?content=true`;
      const startedAt = Date.now();
      const response = await fetchWithTimeout(context.fetch, url, {
        headers: {
          "User-Agent": `job-maxxing/0.1 (personal job search; board=${entry.boardToken})`,
        },
      });
      if (!response.ok) {
        throw new SourceFetchError(
          "greenhouse",
          entry.company,
          `Greenhouse board ${entry.boardToken} returned HTTP ${response.status}`,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new SourceFetchError(
          "greenhouse",
          entry.company,
          `Greenhouse board ${entry.boardToken} returned malformed JSON: ${errorMessage(error)}`,
        );
      }
      const parsed = GreenhouseBoardResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new SourceFetchError(
          "greenhouse",
          entry.company,
          `Greenhouse board ${entry.boardToken} response failed validation`,
        );
      }
      context.logger.info({
        operation: "source_discover",
        source: "greenhouse",
        company: entry.company,
        durationMs: Date.now() - startedAt,
        status: "ok",
        count: parsed.data.jobs.length,
      });
      return parsed.data.jobs.map((job) => ({
        source: "greenhouse",
        company: entry.company,
        payload: job,
      }));
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
