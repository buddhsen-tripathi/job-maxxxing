import { nowIso } from "../client";
import type { JobRow, UserJobStateRow, UserJobStatus } from "../schema";

export async function upsertUserJobState(
  db: D1Database,
  input: {
    userId: string;
    jobId: string;
    status: UserJobStatus;
    now?: Date;
  },
): Promise<void> {
  const stamp = nowIso(input.now);
  await db
    .prepare(
      `INSERT INTO user_job_states (user_id, job_id, status, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, job_id) DO UPDATE SET
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .bind(input.userId, input.jobId, input.status, stamp)
    .run();
}

export async function getUserJobState(
  db: D1Database,
  userId: string,
  jobId: string,
): Promise<UserJobStateRow | null> {
  return db
    .prepare("SELECT * FROM user_job_states WHERE user_id = ? AND job_id = ?")
    .bind(userId, jobId)
    .first<UserJobStateRow>();
}

export async function listUserJobsByStatus(
  db: D1Database,
  userId: string,
  status: UserJobStatus,
  limit = 40,
): Promise<JobRow[]> {
  const result = await db
    .prepare(
      `SELECT j.* FROM jobs j
       INNER JOIN user_job_states ujs ON ujs.job_id = j.id
       WHERE ujs.user_id = ? AND ujs.status = ?
       ORDER BY ujs.updated_at DESC
       LIMIT ?`,
    )
    .bind(userId, status, limit)
    .all<JobRow>();
  return result.results;
}

export async function userHasSkippedJob(
  db: D1Database,
  userId: string,
  jobId: string,
): Promise<boolean> {
  const row = await getUserJobState(db, userId, jobId);
  return row?.status === "skipped";
}
