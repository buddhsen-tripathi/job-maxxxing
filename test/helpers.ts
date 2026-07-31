export function must<T>(value: T | null | undefined, message = "Expected value to be present"): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

import type { JobRow } from "../src/db/schema";

export function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: crypto.randomUUID(),
    fingerprint: "fp",
    source: "greenhouse",
    source_job_id: null,
    company: "Example Corp",
    title: "Backend Software Engineer",
    location: "New York, NY",
    employment_type: "full_time",
    workplace_type: "hybrid",
    description: "We are hiring a backend engineer with TypeScript experience.",
    apply_url: "https://boards.greenhouse.io/example/jobs/1",
    canonical_url: "https://boards.greenhouse.io/example/jobs/1",
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    posted_at: null,
    discovered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    raw_payload: null,
    status: "discovered",
    ...overrides,
  };
}
