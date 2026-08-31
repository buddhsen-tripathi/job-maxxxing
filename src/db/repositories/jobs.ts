import { extractJobRequirements } from "../../jobs/requirements";
import { chunkArray } from "../../shared/array";
import { newId, nowIso } from "../client";
import type { JobActionRow, JobRow, JobScoreRow, JobStatus, ScoreRecommendation } from "../schema";

const LOOKUP_CHUNK = 80;
const WRITE_CHUNK = 20;
/** Rows longer than this still look like a full posting and get compacted. */
const FAT_DESCRIPTION_CHARS = 2_000;
const COMPACT_BATCH = 250;

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
  now?: Date | undefined;
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
      extractJobRequirements(input.description),
      input.applyUrl,
      input.canonicalUrl,
      input.salaryMin ?? null,
      input.salaryMax ?? null,
      input.salaryCurrency ?? null,
      input.postedAt ?? null,
      now,
      now,
      null,
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

export async function getJobByCanonicalUrl(
  db: D1Database,
  canonicalUrl: string,
): Promise<JobRow | null> {
  return db
    .prepare("SELECT * FROM jobs WHERE canonical_url = ?")
    .bind(canonicalUrl)
    .first<JobRow>();
}

export async function listJobsByFingerprints(
  db: D1Database,
  fingerprints: readonly string[],
): Promise<JobRow[]> {
  if (fingerprints.length === 0) return [];
  const out: JobRow[] = [];
  for (const chunk of chunkArray([...fingerprints], LOOKUP_CHUNK)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM jobs WHERE fingerprint IN (${placeholders})`)
      .bind(...chunk)
      .all<JobRow>();
    out.push(...result.results);
  }
  return out;
}

export async function listJobsByCanonicalUrls(
  db: D1Database,
  urls: readonly string[],
): Promise<JobRow[]> {
  if (urls.length === 0) return [];
  const out: JobRow[] = [];
  for (const chunk of chunkArray([...urls], LOOKUP_CHUNK)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM jobs WHERE canonical_url IN (${placeholders})`)
      .bind(...chunk)
      .all<JobRow>();
    out.push(...result.results);
  }
  return out;
}

/**
 * Insert only jobs that are new by fingerprint or canonical URL. Existing rows
 * get last_seen_at touched and description rewritten to extracted requirements.
 * New rows are queued on pending_matches in the same batch.
 */
export async function persistDiscoveredJobs(
  db: D1Database,
  inputs: InsertJobInput[],
): Promise<{ newJobs: JobRow[]; existingCount: number }> {
  if (inputs.length === 0) return { newJobs: [], existingCount: 0 };

  const fingerprints = inputs.map((input) => input.fingerprint);
  const byFingerprint = await listJobsByFingerprints(db, fingerprints);
  const seenFingerprints = new Set(byFingerprint.map((job) => job.fingerprint));
  const remaining = inputs.filter((input) => !seenFingerprints.has(input.fingerprint));

  const urls = remaining.map((input) => input.canonicalUrl);
  const byUrl = await listJobsByCanonicalUrls(db, urls);
  const seenUrls = new Set(byUrl.map((job) => job.canonical_url));
  const toInsert = remaining.filter((input) => !seenUrls.has(input.canonicalUrl));

  const extractedByFingerprint = new Map(
    inputs.map((input) => [input.fingerprint, extractJobRequirements(input.description)]),
  );
  const extractedByUrl = new Map(
    inputs.map((input) => [input.canonicalUrl, extractJobRequirements(input.description)]),
  );
  const seenAt = nowIso(inputs[0]?.now);
  const existingById = new Map<string, JobRow>();
  for (const job of [...byFingerprint, ...byUrl]) existingById.set(job.id, job);
  const touchStatements = [...existingById.values()].map((job) => {
    const description =
      extractedByFingerprint.get(job.fingerprint) ??
      extractedByUrl.get(job.canonical_url) ??
      extractJobRequirements(job.description);
    return db
      .prepare("UPDATE jobs SET last_seen_at = ?, description = ? WHERE id = ?")
      .bind(seenAt, description, job.id);
  });
  for (const chunk of chunkArray(touchStatements, WRITE_CHUNK)) {
    await db.batch(chunk);
  }

  const newJobs: JobRow[] = [];
  for (const chunk of chunkArray(toInsert, WRITE_CHUNK)) {
    const statements = chunk.flatMap((input) => {
      const id = newId();
      const now = nowIso(input.now);
      return [
        db
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
            extractJobRequirements(input.description),
            input.applyUrl,
            input.canonicalUrl,
            input.salaryMin ?? null,
            input.salaryMax ?? null,
            input.salaryCurrency ?? null,
            input.postedAt ?? null,
            now,
            now,
            null,
          ),
        db
          .prepare("INSERT OR IGNORE INTO pending_matches (job_id, created_at) VALUES (?, ?)")
          .bind(id, now),
      ];
    });
    await db.batch(statements);
    const inserted = await listJobsByFingerprints(
      db,
      chunk.map((input) => input.fingerprint),
    );
    newJobs.push(...inserted);
  }

  return { newJobs, existingCount: inputs.length - newJobs.length };
}

export async function upsertDiscoveredJob(
  db: D1Database,
  input: InsertJobInput & { fingerprint: string },
): Promise<{ job: JobRow; isNew: boolean }> {
  const existing =
    (await getJobByFingerprint(db, input.fingerprint)) ??
    (input.canonicalUrl ? await getJobByCanonicalUrl(db, input.canonicalUrl) : null);
  if (existing) {
    const description = extractJobRequirements(input.description);
    await db
      .prepare("UPDATE jobs SET last_seen_at = ?, description = ? WHERE id = ?")
      .bind(nowIso(input.now), description, existing.id)
      .run();
    const updated = await getJobById(db, existing.id);
    return { job: updated ?? existing, isNew: false };
  }
  const job = await insertJob(db, input);
  if (!job) {
    const raced = await getJobByFingerprint(db, input.fingerprint);
    if (raced) return { job: raced, isNew: false };
    throw new Error(`Failed to insert job with fingerprint ${input.fingerprint}`);
  }
  return { job, isNew: true };
}

export async function touchJobLastSeen(
  db: D1Database,
  id: string,
  now?: Date | undefined,
): Promise<void> {
  await db.prepare("UPDATE jobs SET last_seen_at = ? WHERE id = ?").bind(nowIso(now), id).run();
}

export async function setJobStatus(db: D1Database, id: string, status: JobStatus): Promise<void> {
  await db.prepare("UPDATE jobs SET status = ? WHERE id = ?").bind(status, id).run();
}

/** Rewrite oversized stored postings down to requirements. Used to shrink legacy rows. */
export async function compactFatJobDescriptions(
  db: D1Database,
  limit = COMPACT_BATCH,
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT id, description FROM jobs
       WHERE length(description) > ?
       ORDER BY length(description) DESC
       LIMIT ?`,
    )
    .bind(FAT_DESCRIPTION_CHARS, limit)
    .all<{ id: string; description: string }>();

  const statements: D1PreparedStatement[] = [];
  for (const row of result.results) {
    const next = extractJobRequirements(row.description);
    if (next.length < row.description.length) {
      statements.push(
        db.prepare("UPDATE jobs SET description = ? WHERE id = ?").bind(next, row.id),
      );
    }
  }
  let updated = 0;
  for (const chunk of chunkArray(statements, WRITE_CHUNK)) {
    await db.batch(chunk);
    updated += chunk.length;
  }
  return updated;
}

export interface InsertScoreInput {
  jobId: string;
  userId?: string;
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
  now?: Date | undefined;
}

export async function insertJobScore(
  db: D1Database,
  input: InsertScoreInput,
): Promise<JobScoreRow | null> {
  const id = newId();
  const userId = input.userId ?? "default";
  await db
    .prepare(
      `INSERT INTO job_scores (
         id, job_id, user_id, model, total_score, technical_score, experience_score,
         domain_score, location_score, evidence_score, recommendation,
         reasons_json, risks_json, evidence_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.jobId,
      userId,
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
  userId = "default",
): Promise<JobScoreRow | null> {
  return db
    .prepare(
      `SELECT * FROM job_scores
       WHERE job_id = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(jobId, userId)
    .first<JobScoreRow>();
}

export async function insertJobAction(
  db: D1Database,
  input: {
    jobId: string;
    action: string;
    source: string;
    metadataJson?: string | null;
    now?: Date | undefined;
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
