import { describe, expect, it } from "vitest";
import type { SearchPreferences } from "../../src/candidate/preferences";
import type { DiscoveryContext } from "../../src/jobs/types";
import { noopLogger } from "../../src/shared/logger";
import workdayDetailBackend from "../../src/sources/fixtures/workday-detail-backend.json";
import workdayDetailInfra from "../../src/sources/fixtures/workday-detail-infra.json";
import workdaySearch from "../../src/sources/fixtures/workday-search.json";
import { SourceFetchError } from "../../src/sources/source-adapter";
import { createWorkdayAdapter } from "../../src/sources/workday";
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
  preferUsBased: true,
} satisfies SearchPreferences;

const entry = {
  source: "workday" as const,
  company: "BigTech",
  host: "bigtech.wd5.myworkdayjobs.com",
  tenant: "bigtech",
  site: "BigTechCareers",
  limit: 50,
};

function fixtureFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/jobs") && init?.method === "POST") {
      return new Response(JSON.stringify(workdaySearch), { status: 200 });
    }
    if (url.includes("REQ-1001")) {
      return new Response(JSON.stringify(workdayDetailBackend), { status: 200 });
    }
    if (url.includes("REQ-1002")) {
      return new Response(JSON.stringify(workdayDetailInfra), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

function context(fetchImpl: typeof globalThis.fetch): DiscoveryContext {
  return {
    now: new Date("2026-07-31T13:00:00.000Z"),
    preferences,
    fetch: fetchImpl,
    logger: noopLogger,
  };
}

describe("workday adapter", () => {
  it("discovers postings and enriches them with detail fetches", async () => {
    const adapter = createWorkdayAdapter(entry);
    const raw = await adapter.discover(context(fixtureFetch()));
    expect(raw).toHaveLength(2);

    const backend = adapter.normalize(must(raw[0]));
    expect(backend?.title).toBe("Software Engineer, Backend");
    expect(backend?.company).toBe("BigTech");
    expect(backend?.location).toBe("New York, NY");
    expect(backend?.employmentType).toBe("full_time");
    expect(backend?.workplaceType).toBe("unknown");
    expect(backend?.sourceJobId).toBe("REQ-1001");
    expect(backend?.postedAt).toBe("2026-07-29");
    expect(backend?.description).toContain("TypeScript");
    expect(backend?.description).not.toContain("<p>");
    expect(backend?.canonicalUrl).toBe(
      "https://bigtech.wd5.myworkdayjobs.com/en-US/BigTechCareers/job/New-York-NY/Software-Engineer-Backend_REQ-1001",
    );

    const infra = adapter.normalize(must(raw[1]));
    expect(infra?.workplaceType).toBe("remote");
    expect(infra?.applyUrl).toBe(infra?.canonicalUrl);
  });

  it("throws SourceFetchError when the search endpoint fails", async () => {
    const adapter = createWorkdayAdapter(entry);
    await expect(
      adapter.discover(context((async () => new Response("x", { status: 403 })) as typeof fetch)),
    ).rejects.toThrow(SourceFetchError);
  });

  it("drops postings whose detail fetch fails instead of failing the board", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/jobs") && init?.method === "POST") {
        return new Response(JSON.stringify(workdaySearch), { status: 200 });
      }
      if (url.includes("REQ-1001")) {
        return new Response(JSON.stringify(workdayDetailBackend), { status: 200 });
      }
      return new Response("gone", { status: 410 });
    }) as typeof globalThis.fetch;
    const adapter = createWorkdayAdapter(entry);
    const raw = await adapter.discover(context(fetchImpl));
    expect(raw).toHaveLength(1);
    expect(adapter.normalize(must(raw[0]))?.sourceJobId).toBe("REQ-1001");
  });
});
