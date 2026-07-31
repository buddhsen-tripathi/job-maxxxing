import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getJobById, listJobs, upsertDiscoveredJob } from "../../src/db/repositories/jobs";
import { must } from "../helpers";

const db = env.DB;

beforeEach(async () => {
  await db.prepare("DELETE FROM jobs").run();
});

function discovered(overrides: Record<string, unknown> = {}) {
  return {
    fingerprint: `fp-${crypto.randomUUID()}`,
    source: "greenhouse",
    sourceJobId: "4001",
    company: "ExampleCo",
    title: "Backend Software Engineer",
    description: "Build APIs.",
    applyUrl: "https://boards.greenhouse.io/exampleco/jobs/4001",
    canonicalUrl: "https://boards.greenhouse.io/exampleco/jobs/4001",
    ...overrides,
  };
}

describe("upsertDiscoveredJob", () => {
  it("inserts a new job on first discovery", async () => {
    const { job, isNew } = await upsertDiscoveredJob(db, discovered({ fingerprint: "fp-a" }));
    expect(isNew).toBe(true);
    expect(job.status).toBe("discovered");
  });

  it("is idempotent: rediscovery updates last_seen_at without duplicating", async () => {
    const first = await upsertDiscoveredJob(db, discovered({ fingerprint: "fp-b" }));
    const later = new Date(Date.now() + 60_000);
    const second = await upsertDiscoveredJob(db, discovered({ fingerprint: "fp-b", now: later }));
    expect(second.isNew).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    const stored = must(await getJobById(db, first.job.id));
    expect(stored.last_seen_at).toBe(later.toISOString());
    expect(await listJobs(db)).toHaveLength(1);
  });

  it("detects duplicates by canonical URL even with different fingerprints", async () => {
    const first = await upsertDiscoveredJob(
      db,
      discovered({ fingerprint: "fp-c1", canonicalUrl: "https://example.com/job/1" }),
    );
    const second = await upsertDiscoveredJob(
      db,
      discovered({ fingerprint: "fp-c2", canonicalUrl: "https://example.com/job/1" }),
    );
    expect(second.isNew).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });
});
