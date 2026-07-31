import { Hono } from "hono";
import { z } from "zod";
import {
  getJobById,
  getLatestScoreForJob,
  insertJobAction,
  listJobs,
  setJobStatus,
} from "../db/repositories/jobs";
import { insertAuditEvent } from "../db/repositories/meta";
import type { JobStatus } from "../db/schema";
import type { Env } from "../env";

const JobStatusSchema = z.enum([
  "discovered",
  "eligible",
  "scored",
  "shortlisted",
  "skipped",
  "blocked",
  "rejected_by_filter",
  "scoring_failed",
]);

export const jobs = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const statusParam = c.req.query("status");
    const parsed = JobStatusSchema.safeParse(statusParam);
    const status = parsed.success ? (parsed.data as JobStatus) : undefined;
    const rows = await listJobs(c.env.DB, { ...(status ? { status } : {}) });
    return c.json({ jobs: rows });
  })
  .get("/:id", async (c) => {
    const job = await getJobById(c.env.DB, c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    const score = await getLatestScoreForJob(c.env.DB, job.id);
    return c.json({ job, score });
  })
  .post("/:id/shortlist", async (c) => {
    const job = await getJobById(c.env.DB, c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    await setJobStatus(c.env.DB, job.id, "shortlisted");
    await insertJobAction(c.env.DB, { jobId: job.id, action: "shortlist", source: "api" });
    await insertAuditEvent(c.env.DB, {
      entityType: "job",
      entityId: job.id,
      eventType: "shortlisted",
      payload: { source: "api" },
    });
    return c.json({ ok: true });
  })
  .post("/:id/skip", async (c) => {
    const job = await getJobById(c.env.DB, c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    await setJobStatus(c.env.DB, job.id, "skipped");
    await insertJobAction(c.env.DB, { jobId: job.id, action: "skip", source: "api" });
    await insertAuditEvent(c.env.DB, {
      entityType: "job",
      entityId: job.id,
      eventType: "skipped",
      payload: { source: "api" },
    });
    return c.json({ ok: true });
  })
  .post("/:id/prepare", async (c) => {
    const job = await getJobById(c.env.DB, c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json(
      { error: "not_implemented", message: "Application preparation ships in Milestone 7." },
      501,
    );
  });
