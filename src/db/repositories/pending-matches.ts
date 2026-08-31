import { chunkArray } from "../../shared/array";
import { nowIso } from "../client";
import type { JobRow } from "../schema";

const WRITE_CHUNK = 20;

export async function enqueuePendingMatches(
  db: D1Database,
  jobIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  if (jobIds.length === 0) return;
  const createdAt = nowIso(now);
  for (const chunk of chunkArray([...jobIds], WRITE_CHUNK)) {
    await db.batch(
      chunk.map((jobId) =>
        db
          .prepare("INSERT OR IGNORE INTO pending_matches (job_id, created_at) VALUES (?, ?)")
          .bind(jobId, createdAt),
      ),
    );
  }
}

export async function listPendingMatchJobs(db: D1Database, limit = 40): Promise<JobRow[]> {
  const result = await db
    .prepare(
      `SELECT j.*
       FROM pending_matches pm
       INNER JOIN jobs j ON j.id = pm.job_id
       ORDER BY pm.created_at ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<JobRow>();
  return result.results;
}

export async function deletePendingMatches(
  db: D1Database,
  jobIds: readonly string[],
): Promise<void> {
  if (jobIds.length === 0) return;
  for (const chunk of chunkArray([...jobIds], WRITE_CHUNK)) {
    const placeholders = chunk.map(() => "?").join(", ");
    await db
      .prepare(`DELETE FROM pending_matches WHERE job_id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
}

export async function countPendingMatches(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM pending_matches").first<{ n: number }>();
  return row?.n ?? 0;
}
