import { env, fetchMock, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getApplicationByJobId } from "../../src/db/repositories/applications";
import { listJobs } from "../../src/db/repositories/jobs";
import { listAuditEvents } from "../../src/db/repositories/meta";
import { getRun } from "../../src/db/repositories/runs";
import { createMockLlmClient } from "../../src/llm/mock";
import greenhouseFixture from "../../src/sources/fixtures/greenhouse-board.json";
import leverFixture from "../../src/sources/fixtures/lever-postings.json";
import { runDailyJobSearch } from "../../src/workflows/daily-job-search";
import { must } from "../helpers";

const db = env.DB;
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const origin = fetchMock.get("https://api.telegram.org");
  for (const method of ["sendMessage", "editMessageText", "answerCallbackQuery"]) {
    origin
      .intercept({ path: `/bottest-bot-token/${method}`, method: "POST" })
      .reply(200, (opts) => {
        telegramCalls.push({ method, body: JSON.parse(String(opts.body ?? "{}")) });
        if (method === "sendMessage") {
          return { ok: true, result: { message_id: 200 + telegramCalls.length } };
        }
        return { ok: true, result: true };
      })
      .persist();
  }
});

afterAll(() => fetchMock.deactivate());

function fixtureFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("boards-api.greenhouse.io")) {
      return new Response(JSON.stringify(greenhouseFixture), { status: 200 });
    }
    if (url.includes("api.lever.co")) {
      return new Response(JSON.stringify(leverFixture), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

function webhookCallback(data: string) {
  return SELF.fetch("http://localhost/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", [SECRET_HEADER]: "test-webhook-secret" },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      callback_query: {
        id: `cbq-${crypto.randomUUID()}`,
        data,
        message: { message_id: 1, chat: { id: 12345 } },
      },
    }),
  });
}

beforeEach(async () => {
  for (const table of [
    "job_actions",
    "job_scores",
    "applications",
    "jobs",
    "runs",
    "run_locks",
    "telegram_messages",
    "audit_events",
    "blocked_companies",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  telegramCalls.length = 0;
  env.SOURCES_JSON = JSON.stringify([
    { source: "greenhouse", company: "ExampleCo", boardToken: "exampleco" },
    { source: "lever", company: "SampleInc", account: "sampleinc" },
  ]);
});

describe("end-to-end smoke", () => {
  it("dry run → real run → digest → review → shortlist → prepare", async () => {
    const options = {
      now: new Date("2026-07-31T13:00:00.000Z"),
      fetchImpl: fixtureFetch(),
      llmClient: createMockLlmClient(),
      thresholds: { strongMatch: 85, review: 40 },
    };

    // 1. Manual dry run: nothing persisted, nothing sent.
    const dry = await runDailyJobSearch(env, { ...options, dryRun: true });
    expect(dry.status).toBe("completed");
    expect(await listJobs(db)).toHaveLength(0);
    expect(telegramCalls).toHaveLength(0);

    // 2. Real run via the production notifier path (Telegram secrets from bindings).
    const summary = await runDailyJobSearch(env, options);
    expect(summary.status).toBe("completed");
    expect(summary.newCount).toBe(5);

    // 3. Digest sent: one summary + one card per digest job; recorded in D1.
    const sends = telegramCalls.filter((c) => c.method === "sendMessage");
    expect(sends.length).toBe(1 + summary.shortlistedCount);
    const recorded = await db
      .prepare("SELECT COUNT(*) AS n FROM telegram_messages")
      .first<{ n: number }>();
    expect(recorded?.n).toBe(sends.length);

    const run = must(await getRun(db, must(summary.runId)));
    expect(run.status).toBe("completed");

    // 4. Click Review on the top match.
    const target = must((await listJobs(db, { status: "scored" }))[0]);
    const reviewResponse = await webhookCallback(`job:review:${target.id}`);
    expect(reviewResponse.status).toBe(200);
    const reviewSend = telegramCalls.filter((c) => c.method === "sendMessage").at(-1);
    expect(String(reviewSend?.body.text)).toContain(target.title);

    // 5. Click Shortlist; verify action and audit event in D1.
    const shortlistResponse = await webhookCallback(`job:shortlist:${target.id}`);
    expect(shortlistResponse.status).toBe(200);
    expect((await listJobs(db, { status: "shortlisted" }))[0]?.id).toBe(target.id);
    const audit = await listAuditEvents(db, "job", target.id);
    expect(audit.map((event) => event.event_type)).toContain("shortlisted");

    // 6. Prepare an application; unknown answers remain unresolved.
    const prepareResponse = await SELF.fetch(`http://localhost/api/jobs/${target.id}/prepare`, {
      method: "POST",
    });
    expect(prepareResponse.status).toBe(200);
    const body = (await prepareResponse.json()) as {
      prepared: { unresolvedQuestions: string[]; answers: Array<{ confidence: string }> };
    };
    expect(body.prepared.unresolvedQuestions.length).toBeGreaterThan(0);
    const application = must(await getApplicationByJobId(db, target.id));
    expect(application.status).toBe("prepared");
    expect(application.submitted_at).toBeNull();
  });
});
