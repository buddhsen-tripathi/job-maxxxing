import { describe, expect, it } from "vitest";
import type { SearchPreferences } from "../../src/candidate/preferences";
import type { DiscoveryContext } from "../../src/jobs/types";
import { noopLogger } from "../../src/shared/logger";
import leverFixture from "../../src/sources/fixtures/lever-postings.json";
import { createLeverAdapter } from "../../src/sources/lever";
import { must } from "../helpers";

const preferences = {
  titles: [],
  excludedTitles: [],
  locations: [],
  remote: true,
  hybrid: true,
  onsite: false,
  employmentTypes: ["full_time"],
  excludedCompanies: [],
  requiredKeywords: [],
  excludedKeywords: [],
} satisfies SearchPreferences;

function contextWithFetch(fetchImpl: typeof globalThis.fetch): DiscoveryContext {
  return {
    now: new Date("2026-07-31T13:00:00.000Z"),
    preferences,
    fetch: fetchImpl,
    logger: noopLogger,
  };
}

const entry = { source: "lever" as const, company: "SampleInc", account: "sampleinc" };

describe("lever adapter", () => {
  it("discovers and normalizes postings", async () => {
    const adapter = createLeverAdapter(entry);
    const raw = await adapter.discover(
      contextWithFetch(
        async () =>
          new Response(JSON.stringify(leverFixture), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    expect(raw).toHaveLength(3);

    const first = adapter.normalize(must(raw[0]));
    expect(first?.title).toBe("Software Engineer, Platform");
    expect(first?.employmentType).toBe("full_time");
    expect(first?.workplaceType).toBe("remote");
    expect(first?.location).toBe("Remote");
    expect(first?.applyUrl).toBe("https://jobs.lever.co/sampleinc/a1b2c3/apply");
    expect(first?.postedAt).toBe(new Date(1785000000000).toISOString());

    const hybrid = adapter.normalize(must(raw[1]));
    expect(hybrid?.workplaceType).toBe("hybrid");
    expect(hybrid?.description).not.toContain("<p>");
    expect(hybrid?.applyUrl).toBe("https://jobs.lever.co/sampleinc/d4e5f6");
  });

  it("returns null for postings without a description", async () => {
    const adapter = createLeverAdapter(entry);
    const raw = await adapter.discover(
      contextWithFetch(
        async () =>
          new Response(JSON.stringify(leverFixture), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    expect(adapter.normalize(must(raw[2]))).toBeNull();
  });
});
