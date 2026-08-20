import { newId, nowIso } from "../client";
import type { ApplicationRow, ApplicationStatus } from "../schema";

export async function createApplication(
  db: D1Database,
  input: { jobId: string; userId?: string; now?: Date | undefined },
): Promise<ApplicationRow | null> {
  const id = newId();
  const now = nowIso(input.now);
  const userId = input.userId ?? "default";
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO applications (id, user_id, job_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'preparing', ?, ?)`,
    )
    .bind(id, userId, input.jobId, now, now)
    .run();
  if (result.meta.changes === 0) return null;
  return getApplicationById(db, id);
}

export async function getApplicationById(
  db: D1Database,
  id: string,
): Promise<ApplicationRow | null> {
  return db.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<ApplicationRow>();
}

export async function getApplicationByJobId(
  db: D1Database,
  jobId: string,
  userId = "default",
): Promise<ApplicationRow | null> {
  return db
    .prepare("SELECT * FROM applications WHERE job_id = ? AND user_id = ?")
    .bind(jobId, userId)
    .first<ApplicationRow>();
}

export async function listApplications(
  db: D1Database,
  options: { status?: ApplicationStatus; userId?: string; limit?: number } = {},
): Promise<ApplicationRow[]> {
  const limit = options.limit ?? 50;
  if (options.status && options.userId) {
    const result = await db
      .prepare(
        "SELECT * FROM applications WHERE status = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .bind(options.status, options.userId, limit)
      .all<ApplicationRow>();
    return result.results;
  }
  if (options.status) {
    const result = await db
      .prepare("SELECT * FROM applications WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
      .bind(options.status, limit)
      .all<ApplicationRow>();
    return result.results;
  }
  if (options.userId) {
    const result = await db
      .prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
      .bind(options.userId, limit)
      .all<ApplicationRow>();
    return result.results;
  }
  const result = await db
    .prepare("SELECT * FROM applications ORDER BY updated_at DESC LIMIT ?")
    .bind(limit)
    .all<ApplicationRow>();
  return result.results;
}

export async function updateApplication(
  db: D1Database,
  id: string,
  patch: {
    status?: ApplicationStatus;
    resumeVariant?: string | null;
    coverLetter?: string | null;
    preparedAnswersJson?: string | null;
    unresolvedQuestionsJson?: string | null;
    approvedAt?: string | null;
    submittedAt?: string | null;
    submissionReference?: string | null;
  },
  now?: Date | undefined,
): Promise<void> {
  const columns: Record<string, string | null | undefined> = {
    status: patch.status,
    resume_variant: patch.resumeVariant,
    cover_letter: patch.coverLetter,
    prepared_answers_json: patch.preparedAnswersJson,
    unresolved_questions_json: patch.unresolvedQuestionsJson,
    approved_at: patch.approvedAt,
    submitted_at: patch.submittedAt,
    submission_reference: patch.submissionReference,
  };
  const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([column]) => `${column} = ?`).join(", ");
  const values = entries.map(([, value]) => value ?? null);
  await db
    .prepare(`UPDATE applications SET ${setClause}, updated_at = ? WHERE id = ?`)
    .bind(...values, nowIso(now), id)
    .run();
}
