import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createApplication,
  getApplicationByJobId,
  updateApplication,
} from "../../src/db/repositories/applications";
import {
  getJobByFingerprint,
  getJobById,
  getLatestScoreForJob,
  insertJob,
  insertJobAction,
  insertJobScore,
  listActionsForJob,
  listJobs,
  setJobStatus,
  touchJobLastSeen,
} from "../../src/db/repositories/jobs";
import { completeRun, createRun, failRun, getRun, listRuns } from "../../src/db/repositories/runs";
import { must } from "../helpers";

const db = env.DB;

async function clearTables() {
  await db
    .batch([
      db.prepare("DELETE FROM job_actions"),
      db.prepare("DELETE FROM job_scores"),
      db.prepare("DELETE FROM applications"),
      db.prepare("DELETE FROM pending_matches"),
      db.prepare("DELETE FROM jobs"),
      db.prepare("DELETE FROM runs"),
    ])
    .catch(() => {});
}

function jobInput(overrides: Record<string, unknown> = {}) {
  return {
    fingerprint: `fp-${crypto.randomUUID()}`,
    source: "greenhouse",
    company: "Example Corp",
    title: "Backend Software Engineer",
    description: "Build APIs.",
    applyUrl: "https://boards.greenhouse.io/example/jobs/1",
    canonicalUrl: "https://boards.greenhouse.io/example/jobs/1",
    ...overrides,
  };
}

beforeEach(clearTables);

describe("runs repository", () => {
  it("creates, completes, and lists runs", async () => {
    const run = await createRun(db, { triggerType: "cron" });
    expect(run.status).toBe("running");

    await completeRun(db, run.id, {
      discoveredCount: 10,
      newCount: 4,
      eligibleCount: 3,
      shortlistedCount: 2,
    });

    const completed = await getRun(db, run.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.discovered_count).toBe(10);
    expect(completed?.completed_at).not.toBeNull();

    const runs = await listRuns(db);
    expect(runs).toHaveLength(1);
  });

  it("marks runs as failed with an error message", async () => {
    const run = await createRun(db, { triggerType: "manual" });
    await failRun(db, run.id, "boom");
    const failed = await getRun(db, run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
  });
});

describe("jobs repository", () => {
  it("inserts a job and reads it back by id and fingerprint", async () => {
    const input = jobInput({ fingerprint: "fp-1", postedAt: "2026-07-30T00:00:00.000Z" });
    const job = await insertJob(db, input);
    expect(job).not.toBeNull();
    expect(job?.status).toBe("discovered");

    const byId = await getJobById(db, must(job).id);
    expect(byId?.fingerprint).toBe("fp-1");

    const byFingerprint = await getJobByFingerprint(db, "fp-1");
    expect(byFingerprint?.id).toBe(must(job).id);
  });

  it("ignores duplicate fingerprints (idempotent insert)", async () => {
    const input = jobInput({ fingerprint: "fp-dup" });
    const first = await insertJob(db, input);
    const second = await insertJob(db, input);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await listJobs(db)).toHaveLength(1);
  });

  it("updates last_seen_at on rediscovery without duplicating", async () => {
    const job = must(await insertJob(db, jobInput({ fingerprint: "fp-seen" })));
    const later = new Date(Date.now() + 60_000);
    await touchJobLastSeen(db, job.id, later);
    const updated = await getJobById(db, job.id);
    expect(updated?.last_seen_at).toBe(later.toISOString());
    expect(await listJobs(db)).toHaveLength(1);
  });

  it("filters jobs by status", async () => {
    const a = must(await insertJob(db, jobInput()));
    await insertJob(db, jobInput());
    await setJobStatus(db, a.id, "shortlisted");
    const shortlisted = await listJobs(db, { status: "shortlisted" });
    expect(shortlisted).toHaveLength(1);
    expect(shortlisted[0]?.id).toBe(a.id);
  });
});

describe("job_scores repository", () => {
  it("inserts a score and returns the latest for a job", async () => {
    const job = must(await insertJob(db, jobInput()));
    await insertJobScore(db, {
      jobId: job.id,
      model: "test-model",
      totalScore: 80,
      technicalScore: 32,
      experienceScore: 20,
      domainScore: 12,
      locationScore: 8,
      evidenceScore: 8,
      recommendation: "review",
      reasonsJson: "[]",
      risksJson: "[]",
      evidenceJson: "[]",
    });
    const score = await getLatestScoreForJob(db, job.id);
    expect(score?.total_score).toBe(80);
    expect(score?.recommendation).toBe("review");
  });
});

describe("job_actions repository", () => {
  it("records actions and filters by action type", async () => {
    const job = must(await insertJob(db, jobInput()));
    await insertJobAction(db, { jobId: job.id, action: "shortlist", source: "telegram" });
    await insertJobAction(db, { jobId: job.id, action: "skip", source: "telegram" });
    expect(await listActionsForJob(db, job.id)).toHaveLength(2);
    const shortlists = await listActionsForJob(db, job.id, "shortlist");
    expect(shortlists).toHaveLength(1);
    expect(shortlists[0]?.source).toBe("telegram");
  });
});

describe("applications repository", () => {
  it("creates one application per job and updates it", async () => {
    const job = must(await insertJob(db, jobInput()));
    const application = await createApplication(db, { jobId: job.id });
    expect(application?.status).toBe("preparing");

    const duplicate = await createApplication(db, { jobId: job.id });
    expect(duplicate).toBeNull();

    await updateApplication(db, must(application).id, {
      status: "prepared",
      resumeVariant: "backend-systems",
    });
    const updated = await getApplicationByJobId(db, job.id);
    expect(updated?.status).toBe("prepared");
    expect(updated?.resume_variant).toBe("backend-systems");
  });
});
