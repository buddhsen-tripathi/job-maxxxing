import { newId, nowIso } from "../client";
import type { JobActionRow, JobRow, JobScoreRow, JobStatus, ScoreRecommendation } from "../schema";

export interface InsertJobInput {
  fingerprint: string;
  source: string;
  sourceJobId?: string | null;
  company: string;
  title: string;
  location?: string | null;
  employmentType?: string | null;
  workplaceType?: string | null;
  description: string;
  applyUrl: string;
  canonicalUrl: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  postedAt?: string | null;
  rawPayload?: string | null;
  now?: Date;
}

export async function insertJob(db: D1Database, input: InsertJobInput): Promise<JobRow | null> {
  const id = newId();
  const now = nowIso(input.now);
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO jobs (
         id, fingerprint, source, source_job_id, company, title, location,
         employment_type, workplace_type, description, apply_url, canonical_url,
         salary_min, salary_max, salary_currency, posted_at, discovered_at,
         last_seen_at, raw_payload, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')`,
    )
    .bind(
      id,
      input.fingerprint,
      input.source,
      input.sourceJobId ?? null,
      input.company,
      input.title,
      input.location ?? null,
      input.employmentType ?? null,
      input.workplaceType ?? null,
      input.description,
      input.applyUrl,
      input.canonicalUrl,
      input.salaryMin ?? null,
      input.salaryMax ?? null,
      input.salaryCurrency ?? null,
      input.postedAt ?? null,
      now,
      now,
      input.rawPayload ?? null,
    )
    .run();
  if (result.meta.changes === 0) return null;
  return getJobById(db, id);
}

export async function getJobById(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

export async function getJobByFingerprint(
  db: D1Database,
  fingerprint: string,
): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE fingerprint = ?").bind(fingerprint).first<JobRow>();
}

export async function listJobs(
  db: D1Database,
  options: { status?: JobStatus; limit?: number } = {},
): Promise<JobRow[]> {
  const limit = options.limit ?? 50;
  if (options.status) {
    const result = await db
      .prepare("SELECT * FROM jobs WHERE status = ? ORDER BY discovered_at DESC LIMIT ?")
      .bind(options.status, limit)
      .all<JobRow>();
    return result.results;
  }
  const result = await db
    .prepare("SELECT * FROM jobs ORDER BY discovered_at DESC LIMIT ?")
    .bind(limit)
    .all<JobRow>();
  return result.results;
}

export async function touchJobLastSeen(db: D1Database, id: string, now?: Date): Promise<void> {
  await db.prepare("UPDATE jobs SET last_seen_at = ? WHERE id = ?").bind(nowIso(now), id).run();
}

export async function setJobStatus(db: D1Database, id: string, status: JobStatus): Promise<void> {
  await db.prepare("UPDATE jobs SET status = ? WHERE id = ?").bind(status, id).run();
}

export interface InsertScoreInput {
  jobId: string;
  model: string;
  totalScore: number;
  technicalScore: number;
  experienceScore: number;
  domainScore: number;
  locationScore: number;
  evidenceScore: number;
  recommendation: ScoreRecommendation;
  reasonsJson: string;
  risksJson: string;
  evidenceJson: string;
  now?: Date;
}

export async function insertJobScore(
  db: D1Database,
  input: InsertScoreInput,
): Promise<JobScoreRow | null> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO job_scores (
         id, job_id, model, total_score, technical_score, experience_score,
         domain_score, location_score, evidence_score, recommendation,
         reasons_json, risks_json, evidence_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.jobId,
      input.model,
      input.totalScore,
      input.technicalScore,
      input.experienceScore,
      input.domainScore,
      input.locationScore,
      input.evidenceScore,
      input.recommendation,
      input.reasonsJson,
      input.risksJson,
      input.evidenceJson,
      nowIso(input.now),
    )
    .run();
  return db.prepare("SELECT * FROM job_scores WHERE id = ?").bind(id).first<JobScoreRow>();
}

export async function getLatestScoreForJob(
  db: D1Database,
  jobId: string,
): Promise<JobScoreRow | null> {
  return db
    .prepare("SELECT * FROM job_scores WHERE job_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(jobId)
    .first<JobScoreRow>();
}

export async function insertJobAction(
  db: D1Database,
  input: {
    jobId: string;
    action: string;
    source: string;
    metadataJson?: string | null;
    now?: Date;
  },
): Promise<JobActionRow | null> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO job_actions (id, job_id, action, source, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.jobId,
      input.action,
      input.source,
      input.metadataJson ?? null,
      nowIso(input.now),
    )
    .run();
  return db.prepare("SELECT * FROM job_actions WHERE id = ?").bind(id).first<JobActionRow>();
}

export async function listActionsForJob(
  db: D1Database,
  jobId: string,
  action?: string,
): Promise<JobActionRow[]> {
  if (action) {
    const result = await db
      .prepare("SELECT * FROM job_actions WHERE job_id = ? AND action = ? ORDER BY created_at DESC")
      .bind(jobId, action)
      .all<JobActionRow>();
    return result.results;
  }
  const result = await db
    .prepare("SELECT * FROM job_actions WHERE job_id = ? ORDER BY created_at DESC")
    .bind(jobId)
    .all<JobActionRow>();
  return result.results;
}
