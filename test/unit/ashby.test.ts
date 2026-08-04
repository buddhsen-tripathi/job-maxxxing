import { describe, expect, it } from "vitest";
import type { SearchPreferences } from "../../src/candidate/preferences";
import type { DiscoveryContext } from "../../src/jobs/types";
import { noopLogger } from "../../src/shared/logger";
import { createAshbyAdapter } from "../../src/sources/ashby";
import ashbyFixture from "../../src/sources/fixtures/ashby-board.json";
import { SourceFetchError } from "../../src/sources/source-adapter";
import { must } from "../helpers";

const preferences = {
  titles: ["Software Engineer", "Backend Engineer"],
  excludedTitles: ["Engineering Manager", "Director"],
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const entry = { source: "ashby" as const, company: "ExampleAshby", boardSlug: "example" };

describe("ashby adapter", () => {
  it("discovers and normalizes listed eng titles", async () => {
    const adapter = createAshbyAdapter(entry);
    const raw = await adapter.discover(contextWithFetch(async () => jsonResponse(ashbyFixture)));
    // Software Engineer kept; Product Designer dropped (non-eng); Manager excluded; intern kept via eng title
    expect(raw.length).toBeGreaterThanOrEqual(1);

    const first = adapter.normalize(must(raw[0]));
    expect(first).not.toBeNull();
    expect(first?.company).toBe("ExampleAshby");
    expect(first?.source).toBe("ashby");
    expect(first?.title).toBe("Software Engineer, Platform");
    expect(first?.employmentType).toBe("full_time");
    expect(first?.workplaceType).toBe("remote");
    expect(first?.description).toBe("Build APIs in TypeScript.");
    expect(first?.applyUrl).toContain("/application");
    expect(first?.postedAt).toBe("2026-07-01T12:00:00.000+00:00");
  });

  it("returns null for postings without a description", async () => {
    const adapter = createAshbyAdapter(entry);
    expect(
      adapter.normalize({
        source: "ashby",
        company: "ExampleAshby",
        payload: ashbyFixture.jobs[3],
      }),
    ).toBeNull();
  });

  it("skips excluded titles when selecting jobs", async () => {
    const adapter = createAshbyAdapter(entry);
    const raw = await adapter.discover(contextWithFetch(async () => jsonResponse(ashbyFixture)));
    const titles = raw.map((r) => adapter.normalize(r)?.title).filter(Boolean);
    expect(titles).not.toContain("Engineering Manager");
  });

  it("throws SourceFetchError on non-200 responses", async () => {
    const adapter = createAshbyAdapter(entry);
    await expect(
      adapter.discover(contextWithFetch(async () => jsonResponse({}, 404))),
    ).rejects.toThrow(SourceFetchError);
  });

  it("throws SourceFetchError on malformed JSON", async () => {
    const adapter = createAshbyAdapter(entry);
    await expect(
      adapter.discover(contextWithFetch(async () => new Response("not json", { status: 200 }))),
    ).rejects.toThrow(SourceFetchError);
  });

  it("throws SourceFetchError on schema-invalid payloads", async () => {
    const adapter = createAshbyAdapter(entry);
    await expect(
      adapter.discover(contextWithFetch(async () => jsonResponse({ jobs: [{ nope: 1 }] }))),
    ).rejects.toThrow(SourceFetchError);
  });
});
