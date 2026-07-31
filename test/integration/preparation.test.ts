import { env, fetchMock, SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import candidateProfileExample from "../../candidate-profile.example.json";
import { prepareApplication } from "../../src/applications/prepare";
import type { PreparedAnswer } from "../../src/applications/types";
import { parseCandidateProfile } from "../../src/candidate/profile";
import { getApplicationByJobId } from "../../src/db/repositories/applications";
import { insertJob } from "../../src/db/repositories/jobs";
import { listAuditEvents } from "../../src/db/repositories/meta";
import { must } from "../helpers";

const db = env.DB;
const profile = parseCandidateProfile(candidateProfileExample);
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const calls: Array<{ method: string; body: Record<string, unknown> }> = [];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const origin = fetchMock.get("https://api.telegram.org");
  for (const method of ["sendMessage", "editMessageText", "answerCallbackQuery"]) {
    origin
      .intercept({ path: `/bottest-bot-token/${method}`, method: "POST" })
      .reply(200, (opts) => {
        calls.push({ method, body: JSON.parse(String(opts.body ?? "{}")) });
        if (method === "sendMessage") return { ok: true, result: { message_id: 1 } };
        return { ok: true, result: true };
      })
      .persist();
  }
});

afterAll(() => fetchMock.deactivate());

beforeEach(async () => {
  for (const table of ["applications", "job_actions", "job_scores", "jobs", "audit_events"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  calls.length = 0;
});

async function seedJob() {
  return must(
    await insertJob(db, {
      fingerprint: `fp-${crypto.randomUUID()}`,
      source: "greenhouse",
      company: "ExampleCo",
      title: "Backend Software Engineer",
      description: "Build APIs and distributed systems.",
      applyUrl: "https://boards.greenhouse.io/exampleco/jobs/4001",
      canonicalUrl: `https://boards.greenhouse.io/exampleco/jobs/${crypto.randomUUID()}`,
    }),
  );
}

describe("prepareApplication", () => {
  it("prepares a package with verified, derived, and unknown answers", async () => {
    const job = await seedJob();
    const prepared = await prepareApplication(db, { jobId: job.id, profile });

    expect(prepared.status).toBe("prepared");
    expect(prepared.resumeVariant).toBe("backend-systems");

    const byConfidence = (c: PreparedAnswer["confidence"]) =>
      prepared.answers.filter((a) => a.confidence === c);
    expect(byConfidence("verified").length).toBeGreaterThanOrEqual(2);
    expect(byConfidence("derived").length).toBeGreaterThanOrEqual(1);
    expect(prepared.unresolvedQuestions).toContain("What are your salary expectations?");

    const application = must(await getApplicationByJobId(db, job.id));
    expect(application.status).toBe("prepared");
    expect(application.resume_variant).toBe("backend-systems");

    const audit = await listAuditEvents(db, "application", application.id);
    expect(audit.map((event) => event.event_type)).toContain("prepared");
  });

  it("never fills unknown facts", async () => {
    const job = await seedJob();
    const prepared = await prepareApplication(db, {
      jobId: job.id,
      profile,
      questions: ["Describe your leadership experience managing teams.", "What is your race?"],
    });
    for (const answer of prepared.answers) {
      expect(answer.confidence).toBe("unknown");
      expect(answer.answer).toBeUndefined();
    }
  });

  it("rejects re-preparation of an already prepared application", async () => {
    const job = await seedJob();
    await prepareApplication(db, { jobId: job.id, profile });
    await expect(prepareApplication(db, { jobId: job.id, profile })).rejects.toThrow(
      /already "prepared"/,
    );
  });
});

describe("POST /api/jobs/:id/prepare", () => {
  it("returns the prepared package", async () => {
    const job = await seedJob();
    const response = await SELF.fetch(`http://localhost/api/jobs/${job.id}/prepare`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { prepared: { resumeVariant: string } };
    expect(body.prepared.resumeVariant).toBe("backend-systems");
  });
});

describe("telegram prepare flow", () => {
  it("sends a preparation summary via the prepare callback", async () => {
    const job = await seedJob();
    const response = await SELF.fetch("http://localhost/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", [SECRET_HEADER]: "test-webhook-secret" },
      body: JSON.stringify({
        update_id: 1,
        callback_query: {
          id: "cbq-1",
          data: `job:prepare:${job.id}`,
          message: { message_id: 42, chat: { id: 12345 } },
        },
      }),
    });
    expect(response.status).toBe(200);
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(String(sends[0]?.body.text)).toContain("Application prepared");
    expect(String(sends[0]?.body.text)).toContain("Resume variant: backend-systems");
  });
});
