import { env, fetchMock, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getApplicationByJobId } from "../../src/db/repositories/applications";
import { insertJob } from "../../src/db/repositories/jobs";
import { getUserResume, upsertUserResume } from "../../src/db/repositories/user-resumes";
import identityQuestions from "../../src/sources/fixtures/greenhouse-questions.json";
import extraQuestions from "../../src/sources/fixtures/greenhouse-questions-extra.json";
import { must } from "../helpers";

const db = env.DB;
const SECRET_HEADER = "x-telegram-bot-api-secret-token";
const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
const greenhousePosts: Array<{ path: string; body: string }> = [];

function telegramResponse(body: unknown, method: string) {
  calls.push({ method, body: body as Record<string, unknown> });
  if (method === "sendMessage") return { ok: true, result: { message_id: 300 + calls.length } };
  return { ok: true, result: true };
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const telegram = fetchMock.get("https://api.telegram.org");
  for (const method of ["sendMessage", "editMessageText", "answerCallbackQuery"]) {
    telegram
      .intercept({ path: `/bottest-bot-token/${method}`, method: "POST" })
      .reply(200, (opts) => telegramResponse(JSON.parse(String(opts.body ?? "{}")), method))
      .persist();
  }

  const greenhouse = fetchMock.get("https://boards-api.greenhouse.io");
  greenhouse
    .intercept({ path: /\/v1\/boards\/exampleco\/jobs\/4001/, method: "GET" })
    .reply(200, identityQuestions)
    .persist();
  greenhouse
    .intercept({ path: /\/v1\/boards\/exampleco\/jobs\/4002/, method: "GET" })
    .reply(200, extraQuestions)
    .persist();
  greenhouse
    .intercept({ path: /\/v1\/boards\/exampleco\/jobs\/4001/, method: "POST" })
    .reply(200, (opts) => {
      greenhousePosts.push({ path: "/4001", body: String(opts.body ?? "") });
      return { id: "app-4001" };
    })
    .persist();
  greenhouse
    .intercept({ path: /\/v1\/boards\/exampleco\/jobs\/4002/, method: "POST" })
    .reply(200, (opts) => {
      greenhousePosts.push({ path: "/4002", body: String(opts.body ?? "") });
      return { id: "app-4002" };
    })
    .persist();
});

afterAll(() => fetchMock.deactivate());

beforeEach(async () => {
  for (const table of [
    "applications",
    "user_resumes",
    "user_sessions",
    "user_profiles",
    "job_actions",
    "job_scores",
    "pending_matches",
    "jobs",
    "audit_events",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("UPDATE users SET active = 1 WHERE id = 'default'").run();
  calls.length = 0;
  greenhousePosts.length = 0;

  const bytes = new TextEncoder().encode("%PDF-1.4 resume");
  await env.RESUMES.put("users/default/resume", bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { fileName: "resume.pdf" },
  });
  await upsertUserResume(db, {
    userId: "default",
    r2Key: "users/default/resume",
    contentType: "application/pdf",
    fileName: "resume.pdf",
  });
});

function postWebhook(update: unknown) {
  return SELF.fetch("http://localhost/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", [SECRET_HEADER]: "test-webhook-secret" },
    body: JSON.stringify(update),
  });
}

async function seedGreenhouseJob(jobNumericId: string) {
  return must(
    await insertJob(db, {
      fingerprint: `fp-${jobNumericId}-${crypto.randomUUID()}`,
      source: "greenhouse",
      sourceJobId: jobNumericId,
      company: "ExampleCo",
      title: "Backend Software Engineer",
      description: "Build APIs.",
      applyUrl: `https://boards.greenhouse.io/exampleco/jobs/${jobNumericId}`,
      canonicalUrl: `https://boards.greenhouse.io/exampleco/jobs/${jobNumericId}`,
    }),
  );
}

describe("telegram apply flow", () => {
  it("confirms and submits a Greenhouse job when all fields are known", async () => {
    const job = await seedGreenhouseJob("4001");
    const apply = await postWebhook({
      update_id: 1,
      callback_query: {
        id: "cbq-apply",
        data: `job:apply:${job.id}`,
        message: { message_id: 1, chat: { id: 12345 } },
      },
    });
    expect(apply.status).toBe(200);
    const preview = String(calls.filter((c) => c.method === "sendMessage").at(-1)?.body.text);
    expect(preview).toContain("Ready to apply");
    expect(preview).toContain("Alex");

    const confirm = await postWebhook({
      update_id: 2,
      callback_query: {
        id: "cbq-confirm",
        data: `job:confirm:${job.id}`,
        message: { message_id: 2, chat: { id: 12345 } },
      },
    });
    expect(confirm.status).toBe(200);
    expect(greenhousePosts.some((p) => p.path === "/4001")).toBe(true);
    expect(String(calls.filter((c) => c.method === "sendMessage").at(-1)?.body.text)).toContain(
      "Applied",
    );
    const application = must(await getApplicationByJobId(db, job.id, "default"));
    expect(application.status).toBe("submitted");
    expect(application.submission_reference).toBe("app-4001");
  });

  it("asks a required unknown question, stores the answer, and reuses it", async () => {
    const first = await seedGreenhouseJob("4002");
    await postWebhook({
      update_id: 3,
      callback_query: {
        id: "cbq-apply-2",
        data: `job:apply:${first.id}`,
        message: { message_id: 3, chat: { id: 12345 } },
      },
    });
    expect(String(calls.at(-1)?.body.text)).toContain("How did you hear");

    await postWebhook({
      update_id: 4,
      message: { message_id: 4, chat: { id: 12345 }, text: "A friend referred me" },
    });
    expect(String(calls.at(-1)?.body.text)).toContain("Ready to apply");
    expect(String(calls.at(-1)?.body.text)).toContain("A friend referred me");

    await postWebhook({
      update_id: 5,
      callback_query: {
        id: "cbq-confirm-2",
        data: `job:confirm:${first.id}`,
        message: { message_id: 5, chat: { id: 12345 } },
      },
    });
    expect(greenhousePosts.some((p) => p.path === "/4002")).toBe(true);

    const second = await seedGreenhouseJob("4002");
    calls.length = 0;
    await postWebhook({
      update_id: 6,
      callback_query: {
        id: "cbq-apply-3",
        data: `job:apply:${second.id}`,
        message: { message_id: 6, chat: { id: 12345 } },
      },
    });
    const text = String(calls.filter((c) => c.method === "sendMessage").at(-1)?.body.text);
    expect(text).toContain("Ready to apply");
    expect(text).toContain("A friend referred me");
    expect(text).not.toContain("Greenhouse needs this");
  });

  it("does not POST for non-Greenhouse jobs", async () => {
    const job = must(
      await insertJob(db, {
        fingerprint: `fp-lever-${crypto.randomUUID()}`,
        source: "lever",
        company: "SampleInc",
        title: "Backend Software Engineer",
        description: "Build APIs.",
        applyUrl: "https://jobs.lever.co/sampleinc/abc",
        canonicalUrl: "https://jobs.lever.co/sampleinc/abc",
      }),
    );
    await postWebhook({
      update_id: 7,
      callback_query: {
        id: "cbq-lever",
        data: `job:apply:${job.id}`,
        message: { message_id: 7, chat: { id: 12345 } },
      },
    });
    expect(String(calls.at(-1)?.body.text)).toContain("Can't submit this board yet");
    expect(greenhousePosts).toHaveLength(0);
  });

  it("asks for a resume file then continues apply after a URL upload", async () => {
    await db.prepare("DELETE FROM user_resumes").run();
    const job = await seedGreenhouseJob("4001");
    await postWebhook({
      update_id: 8,
      callback_query: {
        id: "cbq-missing-resume",
        data: `job:apply:${job.id}`,
        message: { message_id: 8, chat: { id: 12345 } },
      },
    });
    expect(String(calls.at(-1)?.body.text)).toContain("Please upload a resume");

    fetchMock
      .get("https://files.example.com")
      .intercept({ path: "/resume.txt", method: "GET" })
      .reply(200, "Alex Example software engineer resume with enough text. ".repeat(3), {
        headers: { "Content-Type": "text/plain" },
      });

    await postWebhook({
      update_id: 9,
      message: {
        message_id: 9,
        chat: { id: 12345 },
        text: "https://files.example.com/resume.txt",
      },
    });
    expect(String(calls.filter((c) => c.method === "sendMessage").at(-1)?.body.text)).toContain(
      "Ready to apply",
    );
    const stored = must(await getUserResume(db, "default"));
    expect(stored.file_name).toBe("resume.txt");
  });
});
