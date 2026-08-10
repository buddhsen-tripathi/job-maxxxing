import { env, fetchMock, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertJob, insertJobScore, listActionsForJob } from "../../src/db/repositories/jobs";
import { listBlockedCompanies } from "../../src/db/repositories/meta";
import { getScoredJob } from "../../src/jobs/scoring";
import { createTelegramNotifier } from "../../src/telegram/notifier";
import { must } from "../helpers";

const db = env.DB;
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

interface CapturedCall {
  method: string;
  body: Record<string, unknown>;
}

const calls: CapturedCall[] = [];

function telegramResponse(body: unknown, method: string) {
  calls.push({ method, body: body as Record<string, unknown> });
  if (method === "sendMessage") {
    return { ok: true, result: { message_id: 100 + calls.length } };
  }
  return { ok: true, result: true };
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const origin = fetchMock.get("https://api.telegram.org");
  for (const method of ["sendMessage", "editMessageText", "answerCallbackQuery", "setMyCommands"]) {
    origin
      .intercept({ path: `/bottest-bot-token/${method}`, method: "POST" })
      .reply(200, (opts) => telegramResponse(JSON.parse(String(opts.body ?? "{}")), method))
      .persist();
  }
});

afterAll(() => {
  fetchMock.deactivate();
});

async function seedScoredJob(overrides: { company?: string } = {}) {
  const job = must(
    await insertJob(db, {
      fingerprint: `fp-${crypto.randomUUID()}`,
      source: "greenhouse",
      company: overrides.company ?? "ExampleCo",
      title: "Backend Software Engineer",
      description: "Build APIs.",
      applyUrl: "https://boards.greenhouse.io/exampleco/jobs/4001",
      canonicalUrl: `https://boards.greenhouse.io/exampleco/jobs/${crypto.randomUUID()}`,
    }),
  );
  await insertJobScore(db, {
    jobId: job.id,
    model: "mock-llm",
    totalScore: 91,
    technicalScore: 36,
    experienceScore: 25,
    domainScore: 10,
    locationScore: 10,
    evidenceScore: 10,
    recommendation: "strong_match",
    reasonsJson: JSON.stringify(["TypeScript and distributed-systems experience"]),
    risksJson: JSON.stringify(["Kubernetes preferred but not in profile"]),
    evidenceJson: JSON.stringify([
      {
        jobRequirement: "TypeScript",
        candidateEvidenceId: "ev-typescript-6y",
        assessment: "match",
      },
    ]),
  });
  return job;
}

function callbackUpdate(data: string, chatId = 12345) {
  return {
    update_id: 1,
    callback_query: {
      id: `cbq-${crypto.randomUUID()}`,
      data,
      message: { message_id: 555, chat: { id: chatId } },
    },
  };
}

function postWebhook(update: unknown, secret = "test-webhook-secret") {
  return SELF.fetch("http://localhost/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", [SECRET_HEADER]: secret },
    body: JSON.stringify(update),
  });
}

beforeEach(async () => {
  for (const table of [
    "user_job_states",
    "user_sessions",
    "job_actions",
    "job_scores",
    "applications",
    "jobs",
    "telegram_messages",
    "audit_events",
    "blocked_companies",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM users WHERE id != 'default'").run();
  calls.length = 0;
});

describe("telegram webhook security", () => {
  it("rejects requests with a wrong secret header", async () => {
    const response = await postWebhook(callbackUpdate(`job:skip:${crypto.randomUUID()}`), "wrong");
    expect(response.status).toBe(403);
  });

  it("accepts updates from any chat (open bot)", async () => {
    const response = await postWebhook(callbackUpdate(`job:skip:${crypto.randomUUID()}`, 999));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; ignored?: boolean };
    expect(body.ok).toBe(true);
    expect(body.ignored).toBeUndefined();
  });

  it("ignores unsupported update types", async () => {
    const response = await postWebhook({
      update_id: 1,
      edited_message: { message_id: 1, chat: { id: 12345 }, text: "hello" },
    });
    const body = (await response.json()) as { ignored: boolean };
    expect(body.ignored).toBe(true);
  });
});

describe("telegram slash commands", () => {
  it("lists shortlisted jobs via /shortlists as a link list", async () => {
    const job = await seedScoredJob();
    await postWebhook(callbackUpdate(`job:shortlist:${job.id}`));
    calls.length = 0;

    const response = await postWebhook({
      update_id: 2,
      message: { message_id: 2, chat: { id: 12345 }, text: "/saved" },
    });
    expect(response.status).toBe(200);
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    const text = String(sends[0]?.body.text);
    expect(text).toContain("Saved");
    expect(text).toContain("Backend Software Engineer");
    expect(text).toContain('href="https://boards.greenhouse.io/exampleco/jobs/4001"');
  });

  it("replies to /help", async () => {
    const response = await postWebhook({
      update_id: 3,
      message: { message_id: 3, chat: { id: 12345 }, text: "/help" },
    });
    expect(response.status).toBe(200);
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(String(sends.at(-1)?.body.text)).toContain("/saved");
  });
});

describe("telegram callbacks", () => {
  it("shortlists a job and is idempotent on retry", async () => {
    const job = await seedScoredJob();
    const update = callbackUpdate(`job:shortlist:${job.id}`);

    const first = await postWebhook(update);
    expect(first.status).toBe(200);
    const actions = await listActionsForJob(db, job.id, "shortlist");
    expect(actions).toHaveLength(1);

    const second = await postWebhook(update);
    expect(second.status).toBe(200);
    expect(await listActionsForJob(db, job.id, "shortlist")).toHaveLength(1);
    const answers = calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.at(-1)?.body.text).toBe("Already saved.");
  });

  it("requires confirmation before blocking a company", async () => {
    const job = await seedScoredJob({ company: "Spammy LLC" });

    await postWebhook(callbackUpdate(`job:block:${job.id}`));
    const edits = calls.filter((c) => c.method === "editMessageText");
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.body.text)).toContain("Block");
    expect(await listBlockedCompanies(db)).toHaveLength(0);

    await postWebhook(callbackUpdate(`job:blockconfirm:${job.id}`));
    const blocked = await listBlockedCompanies(db);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.normalized_company).toBe("spammy");
  });

  it("rejects unknown job ids and malformed callback data", async () => {
    const missing = await postWebhook(callbackUpdate(`job:skip:${crypto.randomUUID()}`));
    expect(missing.status).toBe(200);
    const answers = calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.at(-1)?.body.text).toBe("Job not found.");

    await postWebhook(callbackUpdate("https://evil.example.com/steal"));
    expect(calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toBe(
      "Unsupported action.",
    );
  });
});

describe("telegram notifier", () => {
  it("sends one summary plus one card per digest job and records messages", async () => {
    const job = await seedScoredJob();
    const scored = must(await getScoredJob(db, job.id));
    const notifier = createTelegramNotifier({
      client: (await import("../../src/telegram/client")).createTelegramClient({
        token: "test-bot-token",
      }),
      chatId: "12345",
      db,
    });

    await notifier.sendDailyDigest({
      runId: null as unknown as string,
      date: new Date("2026-07-31T13:00:00.000Z"),
      sourcesChecked: 2,
      discoveredCount: 5,
      newCount: 1,
      eligibleCount: 1,
      jobs: [scored],
    });

    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(2);
    expect(String(sends[0]?.body.text)).toContain("Job Search");
    expect(String(sends[1]?.body.text)).toContain("Backend Software Engineer");

    const recorded = await db
      .prepare("SELECT * FROM telegram_messages ORDER BY created_at ASC")
      .all<{ kind: string }>();
    expect(recorded.results.map((row) => row.kind)).toEqual(["digest_summary", "job_card"]);
  });
});
