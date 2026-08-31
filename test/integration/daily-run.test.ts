import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import candidateProfileExample from "../../candidate-profile.example.json";
import { insertJob, listJobs } from "../../src/db/repositories/jobs";
import { listAuditEvents } from "../../src/db/repositories/meta";
import {
  countPendingMatches,
  enqueuePendingMatches,
} from "../../src/db/repositories/pending-matches";
import { createRun, getRun, INGEST_MUTEX_KEY } from "../../src/db/repositories/runs";
import { setUserActive } from "../../src/db/repositories/users";
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
  const byId = new Map(greenhouseFixture.jobs.map((job) => [String(job.id), job]));
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("boards-api.greenhouse.io")) {
      const status = options.greenhouseStatus ?? 200;
      if (status !== 200) return new Response("error", { status });
      const match = url.match(/\/jobs\/(\d+)$/);
      if (match) {
        const job = byId.get(must(match[1]));
        return new Response(JSON.stringify(job ?? {}), {
          status: job ? 200 : 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          jobs: greenhouseFixture.jobs.map(({ content: _content, ...rest }) => rest),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
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
    "pending_matches",
    "jobs",
    "runs",
    "run_locks",
    "audit_events",
    "blocked_companies",
    "user_profiles",
    "ats_boards",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  env.CANDIDATE_PROFILE_JSON = JSON.stringify(candidateProfileExample);
  env.SOURCES_JSON = JSON.stringify(SOURCES);
  env.ADMIN_TOKEN = "test-admin-token";
  await db.prepare("UPDATE users SET active = 1 WHERE id = 'default'").run();
});

describe("runDailyJobSearch", () => {
  it("completes a full run: discovers, filters, scores, and sends one digest", async () => {
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, baseOptions(t));

    expect(summary.status).toBe("completed");
    expect(summary.discoveredCount).toBe(4);
    expect(summary.newCount).toBe(4);
    expect(summary.eligibleCount).toBe(3);
    expect(summary.shortlistedCount).toBe(3);
    expect(t.digests).toHaveLength(1);
    expect(t.digests[0]?.jobs.map((j) => j.score.totalScore)).toEqual([55, 55, 42]);

    const jobs = await listJobs(db);
    expect(jobs).toHaveLength(4);
    const scored = jobs.filter((j) => j.status === "scored");
    expect(scored).toHaveLength(3);
    const filteredOut = jobs.filter((j) => j.status === "rejected_by_filter");
    expect(filteredOut).toHaveLength(1);

    const scores = await db.prepare("SELECT COUNT(*) AS n FROM job_scores").first<{ n: number }>();
    expect(scores?.n).toBe(3);

    const run = must(await getRun(db, must(summary.runId)));
    expect(run.status).toBe("completed");
    expect(run.new_count).toBe(4);
    expect(await countPendingMatches(db)).toBe(0);
    const systemActions = await db
      .prepare("SELECT COUNT(*) AS n FROM job_actions WHERE source = 'system'")
      .first<{ n: number }>();
    expect(systemActions?.n).toBe(0);
  });

  it("skips when the ingest mutex is held", async () => {
    await db
      .prepare("INSERT INTO run_locks (date, run_id, created_at) VALUES (?, ?, ?)")
      .bind(INGEST_MUTEX_KEY, "held", new Date().toISOString())
      .run();

    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, baseOptions(t));
    expect(summary.status).toBe("skipped");
    expect(t.digests).toHaveLength(0);
    expect(await listJobs(db)).toHaveLength(0);
  });

  it("allows another run after the previous one completes", async () => {
    await runDailyJobSearch(env, baseOptions(createTestNotifier()));
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, baseOptions(t));
    expect(summary.status).toBe("completed");
    expect(summary.newCount).toBe(0);
    expect(t.noMatches).toHaveLength(1);
  });

  it("allows a run in a later UTC hour", async () => {
    await runDailyJobSearch(env, baseOptions(createTestNotifier()));
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, {
      ...baseOptions(t),
      now: new Date("2026-07-31T15:00:00.000Z"),
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
    expect(await listJobs(db)).toHaveLength(4);
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
    expect(summary.discoveredCount).toBe(4);
    expect(summary.newCount).toBe(4);
    expect(t.digests).toHaveLength(0);
    expect(t.noMatches).toHaveLength(0);
    expect(await listJobs(db)).toHaveLength(0);
    const actions = await db
      .prepare("SELECT COUNT(*) AS n FROM job_actions")
      .first<{ n: number }>();
    expect(actions?.n).toBe(0);
  });

  it("does not notify a paused user", async () => {
    await setUserActive(db, "default", false);
    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, baseOptions(t));
    expect(summary.status).toBe("completed");
    expect(summary.usersNotified).toBe(0);
    expect(t.digests).toHaveLength(0);
    expect(t.noMatches).toHaveLength(0);
  });

  it("fails stale running ticks before starting a new one", async () => {
    const stale = await createRun(db, {
      triggerType: "cron",
      now: new Date(NOW.getTime() - 20 * 60 * 1000),
    });
    const summary = await runDailyJobSearch(env, baseOptions(createTestNotifier()));
    expect(summary.status).toBe("completed");
    expect((await getRun(db, stale.id))?.status).toBe("failed");
    expect((await getRun(db, stale.id))?.error).toBe("stale_running");
  });

  it("drains queued pending matches even when ingest is skipped", async () => {
    const job = must(
      await insertJob(db, {
        fingerprint: "fp-pending-drain",
        source: "greenhouse",
        company: "ExampleCo",
        title: "Backend Software Engineer",
        location: "New York, NY",
        employmentType: "full_time",
        workplaceType: "remote",
        description: "Build APIs and distributed systems in TypeScript.",
        applyUrl: "https://boards.greenhouse.io/exampleco/jobs/9001",
        canonicalUrl: "https://boards.greenhouse.io/exampleco/jobs/9001",
        now: NOW,
      }),
    );
    await enqueuePendingMatches(db, [job.id], NOW);
    env.SOURCES_JSON = "[]";

    const t = createTestNotifier();
    const summary = await runDailyJobSearch(env, {
      ...baseOptions(t),
      ingestBudgetMs: 0,
    });
    expect(summary.status).toBe("completed");
    expect(summary.discoveredCount).toBe(0);
    expect(t.digests.length + t.noMatches.length).toBeGreaterThanOrEqual(1);
    expect(await countPendingMatches(db)).toBe(0);
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
      body: JSON.stringify({ dryRun: true, sync: true, sourceNames: [] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: RunSummary };
    expect(body.summary.dryRun).toBe(true);
    expect(body.summary.status).toBe("completed");
    expect(await listJobs(db)).toHaveLength(0);
  });

  it("accepts an async run and returns 202", async () => {
    const response = await SELF.fetch("http://localhost/api/admin/run-daily", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-admin-token",
      },
      body: JSON.stringify({ dryRun: true, sourceNames: [] }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean; dryRun: boolean };
    expect(body.accepted).toBe(true);
    expect(body.dryRun).toBe(true);
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
