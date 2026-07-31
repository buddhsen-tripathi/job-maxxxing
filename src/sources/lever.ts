import { z } from "zod";
import type { DiscoveryContext, NormalizedJob, RawJob, WorkplaceType } from "../jobs/types";
import { errorMessage } from "../shared/errors";
import { fetchWithTimeout, stripHtml } from "../shared/http";
import type { JobSourceAdapter, LeverSourceEntry } from "./source-adapter";
import { SourceFetchError } from "./source-adapter";

const LeverPostingSchema = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  applyUrl: z.string().optional(),
  description: z.string().optional(),
  descriptionPlain: z.string().optional(),
  createdAt: z.number().optional(),
  categories: z
    .object({
      location: z.string().optional(),
      commitment: z.string().optional(),
      team: z.string().optional(),
    })
    .optional(),
  workplaceType: z.string().optional(),
});

const LeverPostingsResponseSchema = z.array(LeverPostingSchema);

function mapWorkplaceType(value: string | undefined): WorkplaceType {
  switch (value?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "on-site":
    case "onsite":
      return "onsite";
    default:
      return "unknown";
  }
}

function mapEmploymentType(commitment: string | undefined): string | undefined {
  const value = commitment?.toLowerCase().replace(/[\s-]+/g, "_");
  switch (value) {
    case "full_time":
    case "part_time":
    case "contract":
    case "internship":
    case "intern":
      return value === "intern" ? "internship" : value;
    default:
      return undefined;
  }
}

export function createLeverAdapter(entry: LeverSourceEntry): JobSourceAdapter {
  return {
    name: "lever",

    async discover(context: DiscoveryContext): Promise<RawJob[]> {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(entry.account)}?mode=json`;
      const startedAt = Date.now();
      const response = await fetchWithTimeout(context.fetch, url, {
        headers: {
          "User-Agent": `job-maxxing/0.1 (personal job search; account=${entry.account})`,
        },
      });
      if (!response.ok) {
        throw new SourceFetchError(
          "lever",
          entry.company,
          `Lever account ${entry.account} returned HTTP ${response.status}`,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new SourceFetchError(
          "lever",
          entry.company,
          `Lever account ${entry.account} returned malformed JSON: ${errorMessage(error)}`,
        );
      }
      const parsed = LeverPostingsResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new SourceFetchError(
          "lever",
          entry.company,
          `Lever account ${entry.account} response failed validation`,
        );
      }
      context.logger.info({
        operation: "source_discover",
        source: "lever",
        company: entry.company,
        durationMs: Date.now() - startedAt,
        status: "ok",
        count: parsed.data.length,
      });
      return parsed.data.map((posting) => ({
        source: "lever",
        company: entry.company,
        payload: posting,
      }));
    },

    normalize(raw: RawJob): NormalizedJob | null {
      const parsed = LeverPostingSchema.safeParse(raw.payload);
      if (!parsed.success) return null;
      const posting = parsed.data;
      const description = posting.descriptionPlain?.trim()
        ? posting.descriptionPlain.trim()
        : posting.description
          ? stripHtml(posting.description)
          : "";
      if (!description) return null;
      const employmentType = mapEmploymentType(posting.categories?.commitment);
      return {
        source: "lever",
        sourceJobId: posting.id,
        company: raw.company,
        title: posting.text.trim(),
        ...(posting.categories?.location ? { location: posting.categories.location } : {}),
        ...(employmentType ? { employmentType } : {}),
        workplaceType: mapWorkplaceType(posting.workplaceType),
        description,
        applyUrl: posting.applyUrl ?? posting.hostedUrl,
        canonicalUrl: posting.hostedUrl,
        ...(posting.createdAt ? { postedAt: new Date(posting.createdAt).toISOString() } : {}),
        discoveredAt: new Date().toISOString(),
        rawPayload: raw.payload,
      };
    },
  };
}
