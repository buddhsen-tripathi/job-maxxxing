import { z } from "zod";
import type { DiscoveryContext, NormalizedJob, RawJob } from "../jobs/types";

export interface JobSourceAdapter {
  readonly name: string;

  discover(context: DiscoveryContext): Promise<RawJob[]>;

  normalize(raw: RawJob): NormalizedJob | null;
}

export const GreenhouseSourceEntrySchema = z.object({
  source: z.literal("greenhouse"),
  company: z.string().min(1),
  boardToken: z.string().min(1),
});

export const LeverSourceEntrySchema = z.object({
  source: z.literal("lever"),
  company: z.string().min(1),
  account: z.string().min(1),
});

export const AshbySourceEntrySchema = z.object({
  source: z.literal("ashby"),
  company: z.string().min(1),
  boardSlug: z.string().min(1),
});

export const WorkdaySourceEntrySchema = z.object({
  source: z.literal("workday"),
  company: z.string().min(1),
  host: z.string().min(1),
  tenant: z.string().min(1),
  site: z.string().min(1),
  limit: z.number().int().positive().max(200).default(50),
});

export const SourceEntrySchema = z.discriminatedUnion("source", [
  GreenhouseSourceEntrySchema,
  LeverSourceEntrySchema,
  AshbySourceEntrySchema,
  WorkdaySourceEntrySchema,
]);

export const SourcesConfigSchema = z.array(SourceEntrySchema);

export type GreenhouseSourceEntry = z.infer<typeof GreenhouseSourceEntrySchema>;
export type LeverSourceEntry = z.infer<typeof LeverSourceEntrySchema>;
export type AshbySourceEntry = z.infer<typeof AshbySourceEntrySchema>;
export type WorkdaySourceEntry = z.infer<typeof WorkdaySourceEntrySchema>;
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

export class SourceFetchError extends Error {
  constructor(
    public readonly source: string,
    public readonly company: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}
