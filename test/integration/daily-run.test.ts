import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import candidateProfileExample from "../../candidate-profile.example.json";
import { listJobs } from "../../src/db/repositories/jobs";
import { listAuditEvents } from "../../src/db/repositories/meta";
import { getRun } from "../../src/db/repositories/runs";
import { createMockLlmClient } from "../../src/llm/mock";
import greenhouseFixture from "../../src/sources/fixtures/greenhouse-board.json";
import leverFixture from "../../src/sources/fixtures/lever-postings.json";
import {
  type DigestInput,
  type RunSummary,
  runDailyJobSearch,
} from "../../src/workflows/daily-job-search";
import { must } from "../helpers";

const db = env.DB;

const SOURCES = [
  { source: "greenhouse", company: "ExampleCo", boardToken: "exampleco" },
  { source: "lever", company: "SampleInc", account: "sampleinc" },
];

function fixtureFetch(options: { greenhouseStatus?: number } = {}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("boards-api.greenhouse.io")) {
      const status = options.greenhouseStatus ?? 200;
      return new Response(status === 200 ? JSON.stringify(greenhouseFixture) : "error", { status });
    }
    if (url.includes("api.lever.co")) {
      return new Response(JSON.stringify(leverFixture), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

function createTestNotifier() {
  const digests: DigestInput[] = [];
  const noMatches: Array<Omit<DigestInput, "jobs">> = [];
  const failures: Array<{ runId: string; error: string }> = [];
  return {
    digests,
    noMatches,
    failures,
    notifier: {
      sendDailyDigest: async (input: DigestInput) => {
        digests.push(input);
      },
      sendNoMatchesNotice: async (input: Omit<DigestInput, "jobs">) => {
        noMatches.push(input);
      },
      sendFailureNotification: async (input: { runId: string; error: string }) => {
        failures.push(input);
      },
    },
  };
}

const NOW = new Date("2026-07-31T13:00:00.000Z");

function baseOptions(notifier: ReturnType<typeof createTestNotifier>) {
  return {
    now: NOW,
    fetchImpl: fixtureFetch(),
    llmClient: createMockLlmClient(),
    notifier: notifier.notifier,
    thresholds: { strongMatch: 85, review: 40 },
  };
}

beforeEach(async () => {
  for (const table of [
    "job_actions",
    "job_scores",
    "applications",
    "jobs",
    "runs",
    "run_locks",
    "audit_events",
    "blocked_companies",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  env.CANDIDATE_PROFILE_JSON = JSON.stringify(candidateProfileExample);
  env.SOURCES_JSON = JSON.stringify(SOURCES);
  env.ADMIN_TOKEN = "test-admin-token";
});

describe("runDailyJobSearch", () => {
  it("completes a full run: discovers, filters, scores, and sends one digest", async () => {
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, baseOptions(t));

    expect(summary.status).toBe("completed");
    expect(summary.discoveredCount).toBe(5);
    expect(summary.newCount).toBe(5);
    expect(summary.eligibleCount).toBe(3);
    expect(summary.shortlistedCount).toBe(3);
    expect(t.digests).toHaveLength(1);
    expect(t.digests[0]?.jobs.map((j) => j.score.totalScore)).toEqual([55, 55, 42]);

    const jobs = await listJobs(db);
    expect(jobs).toHaveLength(5);
    const scored = jobs.filter((j) => j.status === "scored");
    expect(scored).toHaveLength(3);
    const filteredOut = jobs.filter((j) => j.status === "rejected_by_filter");
    expect(filteredOut).toHaveLength(2);

    const scores = await db.prepare("SELECT COUNT(*) AS n FROM job_scores").first<{ n: number }>();
    expect(scores?.n).toBe(3);

    const run = must(await getRun(db, must(summary.runId)));
    expect(run.status).toBe("completed");
    expect(run.new_count).toBe(5);
  });

  it("prevents a second run in the same 6-hour UTC slot (run lock)", async () => {
    const t1 = createTestNotifier();
    const first = await runDailyJobSearch(env, baseOptions(t1));
    expect(first.status).toBe("completed");

    const t2 = createTestNotifier();
    const second = await runDailyJobSearch(env, baseOptions(t2));
    expect(second.status).toBe("skipped");
    expect(t2.digests).toHaveLength(0);
    expect(await listJobs(db)).toHaveLength(5);
  });

  it("allows a run in the next 6-hour UTC slot", async () => {
    await runDailyJobSearch(env, baseOptions(createTestNotifier()));
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, {
      ...baseOptions(t),
      now: new Date("2026-07-31T18:00:00.000Z"),
    });
    expect(summary.status).toBe("completed");
    expect(summary.newCount).toBe(0);
    expect(t.noMatches).toHaveLength(1);
  });

  it("a next-day run rediscovers without duplicating jobs or digests", async () => {
    await runDailyJobSearch(env, baseOptions(createTestNotifier()));
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, {
      ...baseOptions(t),
      now: new Date("2026-08-01T13:00:00.000Z"),
    });
    expect(summary.status).toBe("completed");
    expect(summary.newCount).toBe(0);
    expect(summary.eligibleCount).toBe(0);
    expect(t.digests).toHaveLength(0);
    expect(t.noMatches).toHaveLength(1);
    expect(await listJobs(db)).toHaveLength(5);
  });

  it("isolates a failing source and still completes", async () => {
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, {
      ...baseOptions(t),
      fetchImpl: fixtureFetch({ greenhouseStatus: 500 }),
    });
    expect(summary.status).toBe("completed");
    expect(summary.sourceFailures).toHaveLength(1);
    expect(summary.sourceFailures[0]?.source).toBe("greenhouse");
    expect(summary.discoveredCount).toBe(2);
  });

  it("dry run sends nothing and persists no jobs, statuses, or actions", async () => {
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, { ...baseOptions(t), dryRun: true });
    expect(summary.status).toBe("completed");
    expect(summary.dryRun).toBe(true);
    expect(summary.discoveredCount).toBe(5);
    expect(summary.newCount).toBe(5);
    expect(t.digests).toHaveLength(0);
    expect(t.noMatches).toHaveLength(0);
    expect(await listJobs(db)).toHaveLength(0);
    const actions = await db
      .prepare("SELECT COUNT(*) AS n FROM job_actions")
      .first<{ n: number }>();
    expect(actions?.n).toBe(0);
  });
});

describe("admin run-daily endpoint", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await SELF.fetch("http://localhost/api/admin/run-daily", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(response.status).toBe(401);
  });

  it("runs a dry run with a valid token and persists nothing", async () => {
    const response = await SELF.fetch("http://localhost/api/admin/run-daily", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-admin-token",
      },
      body: JSON.stringify({ dryRun: true, sourceNames: [] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: RunSummary };
    expect(body.summary.dryRun).toBe(true);
    expect(body.summary.status).toBe("completed");
    expect(await listJobs(db)).toHaveLength(0);
  });
});

describe("job action endpoints", () => {
  it("shortlists and skips jobs with actions and audit events", async () => {
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, baseOptions(t));
    const jobs = await listJobs(db, { status: "scored" });
    const target = must(jobs[0]);

    const shortlistResponse = await SELF.fetch(`http://localhost/api/jobs/${target.id}/shortlist`, {
      method: "POST",
    });
    expect(shortlistResponse.status).toBe(200);
    expect((await listJobs(db, { status: "shortlisted" }))[0]?.id).toBe(target.id);

    const audit = await listAuditEvents(db, "job", target.id);
    expect(audit.map((event) => event.event_type)).toContain("shortlisted");

    const other = must(jobs[1]);
    const skipResponse = await SELF.fetch(`http://localhost/api/jobs/${other.id}/skip`, {
      method: "POST",
    });
    expect(skipResponse.status).toBe(200);
    expect((await listJobs(db, { status: "skipped" }))[0]?.id).toBe(other.id);

    expect(summary.runId).not.toBeNull();
  });
});
