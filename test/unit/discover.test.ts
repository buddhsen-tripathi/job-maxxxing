import { describe, expect, it } from "vitest";
import type { SearchPreferences } from "../../src/candidate/preferences";
import { deduplicateInMemory } from "../../src/jobs/deduplicate";
import { discoverFromSources } from "../../src/jobs/discover";
import { noopLogger } from "../../src/shared/logger";
import ashbyFixture from "../../src/sources/fixtures/ashby-board.json";
import greenhouseFixture from "../../src/sources/fixtures/greenhouse-board.json";
import leverFixture from "../../src/sources/fixtures/lever-postings.json";

const preferences = {
  titles: ["Software Engineer", "Backend Engineer"],
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fixtureFetch(options: { greenhouseStatus?: number } = {}): typeof globalThis.fetch {
  const byId = new Map(greenhouseFixture.jobs.map((job) => [job.id, job]));
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.lever.co")) {
      return json(leverFixture);
    }
    if (url.includes("api.ashbyhq.com")) {
      return json(ashbyFixture);
    }
    if (url.includes("boards-api.greenhouse.io")) {
      const status = options.greenhouseStatus ?? 200;
      if (status !== 200) return json({}, status);
      const match = url.match(/\/jobs\/(\d+)$/);
      if (match) {
        const job = byId.get(Number(match[1]));
        return job ? json(job) : json({}, 404);
      }
      return json({
        jobs: greenhouseFixture.jobs.map(({ content: _content, ...rest }) => rest),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

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
    { source: "ashby" as const, company: "ExampleAshby", boardSlug: "example" },
  ];

  it("aggregates normalized jobs across sources", async () => {
    const outcome = await discoverFromSources(entries, {
      now: new Date("2026-07-31T13:00:00.000Z"),
      preferences,
      fetch: fixtureFetch(),
      logger: noopLogger,
    });
    expect(outcome.failures).toEqual([]);
    // Greenhouse: 2 eng titles + Lever 2 + Ashby 1 (Software Engineer; intern may lack desc) = 5+
    expect(outcome.discoveredCount).toBeGreaterThanOrEqual(5);
    expect(outcome.jobs.length).toBe(outcome.discoveredCount);
    for (const job of outcome.jobs) {
      expect(job.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(job.discoveredAt).toBe("2026-07-31T13:00:00.000Z");
    }
    expect(outcome.jobs.some((j) => j.source === "ashby")).toBe(true);
  });

  it("isolates a failing source and still returns partial results", async () => {
    const outcome = await discoverFromSources(entries, {
      now: new Date(),
      preferences,
      fetch: fixtureFetch({ greenhouseStatus: 500 }),
      logger: noopLogger,
    });
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.source).toBe("greenhouse");
    expect(outcome.jobs.length).toBeGreaterThanOrEqual(2);
  });

  it("applies the limit option", async () => {
    const outcome = await discoverFromSources(
      entries,
      {
        now: new Date(),
        preferences,
        fetch: fixtureFetch(),
        logger: noopLogger,
      },
      { limit: 2 },
    );
    expect(outcome.jobs.length).toBe(2);
  });
});
