import type { SearchPreferences } from "../candidate/preferences";
import type { Logger } from "../shared/logger";

export interface RawJob {
  source: string;
  company: string;
  payload: unknown;
}

export type WorkplaceType = "remote" | "hybrid" | "onsite" | "unknown";

export interface NormalizedJob {
  source: string;
  sourceJobId?: string;
  company: string;
  title: string;
  location?: string;
  employmentType?: string;
  workplaceType: WorkplaceType;
  description: string;
  applyUrl: string;
  canonicalUrl: string;
  salary?: {
    min?: number;
    max?: number;
    currency?: string;
  };
  postedAt?: string;
  discoveredAt: string;
  rawPayload?: unknown;
}

export interface DiscoveryContext {
  now: Date;
  preferences: SearchPreferences;
  fetch: typeof globalThis.fetch;
  logger: Logger;
}
