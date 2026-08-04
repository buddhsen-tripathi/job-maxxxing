import { describe, expect, it } from "vitest";
import type { SearchPreferences } from "../../src/candidate/preferences";
import type { DiscoveryContext } from "../../src/jobs/types";
import { noopLogger } from "../../src/shared/logger";
import greenhouseFixture from "../../src/sources/fixtures/greenhouse-board.json";
import { createGreenhouseAdapter } from "../../src/sources/greenhouse";
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

const entry = { source: "greenhouse" as const, company: "ExampleCo", boardToken: "exampleco" };

describe("greenhouse adapter", () => {
  it("lists jobs then hydrates details for relevant titles", async () => {
    const listOnly = {
      jobs: greenhouseFixture.jobs.map(({ content: _c, ...rest }) => rest),
    };
    const byId = new Map(greenhouseFixture.jobs.map((job) => [job.id, job]));

    const adapter = createGreenhouseAdapter(entry);
    const raw = await adapter.discover(
      contextWithFetch(async (input) => {
        const url = String(input);
        if (url.endsWith("/jobs")) return jsonResponse(listOnly);
        const match = url.match(/\/jobs\/(\d+)$/);
        if (match) {
          const job = byId.get(Number(match[1]));
          return job ? jsonResponse(job) : jsonResponse({}, 404);
        }
        return jsonResponse({}, 404);
      }),
    );
    expect(raw.length).toBeGreaterThan(0);

    const first = adapter.normalize(must(raw[0]));
    expect(first).not.toBeNull();
    expect(first?.company).toBe("ExampleCo");
    expect(first?.title).toBeTruthy();
    expect(first?.description).not.toContain("<p>");
  });

  it("skips excluded titles when selecting details", async () => {
    const listOnly = {
      jobs: [
        {
          id: 1,
          title: "Engineering Manager, Platform",
          absolute_url: "https://boards.greenhouse.io/exampleco/jobs/1",
          location: { name: "Remote" },
        },
        {
          id: 2,
          title: "Software Engineer",
          absolute_url: "https://boards.greenhouse.io/exampleco/jobs/2",
          location: { name: "New York, NY" },
        },
      ],
    };
    const adapter = createGreenhouseAdapter(entry);
    const raw = await adapter.discover(
      contextWithFetch(async (input) => {
        const url = String(input);
        if (url.endsWith("/jobs")) return jsonResponse(listOnly);
        if (url.endsWith("/jobs/2")) {
          return jsonResponse({
            ...listOnly.jobs[1],
            content: "<p>Build APIs in TypeScript.</p>",
          });
        }
        if (url.endsWith("/jobs/1")) {
          throw new Error("should not hydrate excluded title");
        }
        return jsonResponse({}, 404);
      }),
    );
    expect(raw).toHaveLength(1);
    expect(adapter.normalize(must(raw[0]))?.title).toBe("Software Engineer");
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
