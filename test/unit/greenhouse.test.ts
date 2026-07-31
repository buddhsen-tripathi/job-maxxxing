import { describe, expect, it } from "vitest";
import type { SearchPreferences } from "../../src/candidate/preferences";
import type { DiscoveryContext } from "../../src/jobs/types";
import { noopLogger } from "../../src/shared/logger";
import greenhouseFixture from "../../src/sources/fixtures/greenhouse-board.json";
import { createGreenhouseAdapter } from "../../src/sources/greenhouse";
import { SourceFetchError } from "../../src/sources/source-adapter";
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const entry = { source: "greenhouse" as const, company: "ExampleCo", boardToken: "exampleco" };

describe("greenhouse adapter", () => {
  it("discovers and normalizes jobs from a board response", async () => {
    const adapter = createGreenhouseAdapter(entry);
    const raw = await adapter.discover(
      contextWithFetch(async () => jsonResponse(greenhouseFixture)),
    );
    expect(raw).toHaveLength(3);

    const first = adapter.normalize(must(raw[0]));
    expect(first).not.toBeNull();
    expect(first?.company).toBe("ExampleCo");
    expect(first?.title).toBe("Backend Software Engineer");
    expect(first?.location).toBe("New York, NY");
    expect(first?.workplaceType).toBe("unknown");
    expect(first?.description).toContain("Backend Software Engineer");
    expect(first?.description).not.toContain("<p>");
    expect(first?.sourceJobId).toBe("4001");

    const remote = adapter.normalize(must(raw[1]));
    expect(remote?.workplaceType).toBe("remote");
  });

  it("throws SourceFetchError on non-200 responses", async () => {
    const adapter = createGreenhouseAdapter(entry);
    await expect(
      adapter.discover(contextWithFetch(async () => jsonResponse({}, 404))),
    ).rejects.toThrow(SourceFetchError);
  });

  it("throws SourceFetchError on malformed JSON", async () => {
    const adapter = createGreenhouseAdapter(entry);
    await expect(
      adapter.discover(contextWithFetch(async () => new Response("not json", { status: 200 }))),
    ).rejects.toThrow(SourceFetchError);
  });

  it("throws SourceFetchError on schema-invalid payloads", async () => {
    const adapter = createGreenhouseAdapter(entry);
    await expect(
      adapter.discover(contextWithFetch(async () => jsonResponse({ jobs: [{ nope: 1 }] }))),
    ).rejects.toThrow(SourceFetchError);
  });
});
