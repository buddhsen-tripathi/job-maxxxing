import { describe, expect, it } from "vitest";
import type { SearchPreferences } from "../../src/candidate/preferences";
import { deduplicateInMemory } from "../../src/jobs/deduplicate";
import { discoverFromSources } from "../../src/jobs/discover";
import { noopLogger } from "../../src/shared/logger";
import greenhouseFixture from "../../src/sources/fixtures/greenhouse-board.json";
import leverFixture from "../../src/sources/fixtures/lever-postings.json";

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

function fetchRouting(routes: Record<string, () => Response>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, handler] of Object.entries(routes)) {
      if (url.includes(needle)) return handler();
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("deduplicateInMemory", () => {
  it("keeps the first occurrence of each fingerprint", () => {
    const jobs = [
      { fingerprint: "a", id: 1 },
      { fingerprint: "b", id: 2 },
      { fingerprint: "a", id: 3 },
    ];
    const { unique, duplicateCount } = deduplicateInMemory(jobs);
    expect(unique.map((j) => j.id)).toEqual([1, 2]);
    expect(duplicateCount).toBe(1);
  });
});

describe("discoverFromSources", () => {
  const entries = [
    { source: "greenhouse" as const, company: "ExampleCo", boardToken: "exampleco" },
    { source: "lever" as const, company: "SampleInc", account: "sampleinc" },
  ];

  it("aggregates normalized jobs across sources", async () => {
    const outcome = await discoverFromSources(entries, {
      now: new Date("2026-07-31T13:00:00.000Z"),
      preferences,
      fetch: fetchRouting({
        "boards-api.greenhouse.io": () => json(greenhouseFixture),
        "api.lever.co": () => json(leverFixture),
      }),
      logger: noopLogger,
    });
    expect(outcome.failures).toEqual([]);
    expect(outcome.discoveredCount).toBe(5);
    expect(outcome.jobs.length).toBe(5);
    for (const job of outcome.jobs) {
      expect(job.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(job.discoveredAt).toBe("2026-07-31T13:00:00.000Z");
    }
  });

  it("isolates a failing source and still returns partial results", async () => {
    const outcome = await discoverFromSources(entries, {
      now: new Date(),
      preferences,
      fetch: fetchRouting({
        "boards-api.greenhouse.io": () => json({}, 500),
        "api.lever.co": () => json(leverFixture),
      }),
      logger: noopLogger,
    });
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.source).toBe("greenhouse");
    expect(outcome.jobs.length).toBe(2);
  });

  it("applies the limit option", async () => {
    const outcome = await discoverFromSources(
      entries,
      {
        now: new Date(),
        preferences,
        fetch: fetchRouting({
          "boards-api.greenhouse.io": () => json(greenhouseFixture),
          "api.lever.co": () => json(leverFixture),
        }),
        logger: noopLogger,
      },
      { limit: 2 },
    );
    expect(outcome.jobs.length).toBe(2);
  });
});
