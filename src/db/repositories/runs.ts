import { newId, nowIso } from "../client";
import type { RunRow, RunStatus } from "../schema";

export interface RunCounts {
  discoveredCount: number;
  newCount: number;
  eligibleCount: number;
  shortlistedCount: number;
}

export async function createRun(
  db: D1Database,
  input: { triggerType: string; now?: Date | undefined },
): Promise<RunRow> {
  const id = newId();
  const startedAt = nowIso(input.now);
  await db
    .prepare(
      `INSERT INTO runs (id, trigger_type, status, started_at)
       VALUES (?, ?, 'running', ?)`,
    )
    .bind(id, input.triggerType, startedAt)
    .run();
  const run = await getRun(db, id);
  if (!run) throw new Error(`Failed to create run ${id}`);
  return run;
}

export async function getRun(db: D1Database, id: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
}

export async function listRuns(db: D1Database, limit = 20): Promise<RunRow[]> {
  const result = await db
    .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
    .bind(limit)
    .all<RunRow>();
  return result.results;
}

export async function completeRun(
  db: D1Database,
  id: string,
  counts: RunCounts,
  now?: Date | undefined,
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs
       SET status = 'completed', completed_at = ?,
           discovered_count = ?, new_count = ?, eligible_count = ?, shortlisted_count = ?
       WHERE id = ?`,
    )
    .bind(
      nowIso(now),
      counts.discoveredCount,
      counts.newCount,
      counts.eligibleCount,
      counts.shortlistedCount,
      id,
    )
    .run();
}

export async function failRun(
  db: D1Database,
  id: string,
  error: string,
  now?: Date | undefined,
): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?")
    .bind(nowIso(now), error, id)
    .run();
}

export async function setRunStatus(db: D1Database, id: string, status: RunStatus): Promise<void> {
  await db.prepare("UPDATE runs SET status = ? WHERE id = ?").bind(status, id).run();
}

/** Wall-clock age after which a `running` row is treated as a killed cron tick. */
export const STALE_RUN_MS = 15 * 60 * 1000;
export const INGEST_MUTEX_KEY = "ingest_mutex";
export const INGEST_MUTEX_STALE_MS = 15 * 60 * 1000;

export async function failStaleRuns(
  db: D1Database,
  now: Date,
  maxAgeMs = STALE_RUN_MS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE runs
       SET status = 'failed', completed_at = ?, error = 'stale_running'
       WHERE status = 'running' AND started_at < ?`,
    )
    .bind(nowIso(now), cutoff)
    .run();
  return result.meta.changes;
}

/**
 * Single-row mutex so overlapping cron ticks do not double-poll. A lock older
 * than 15 minutes is stolen (previous tick was killed by the Worker limit).
 */
export async function acquireIngestMutex(db: D1Database): Promise<boolean> {
  const existing = await db
    .prepare("SELECT created_at FROM run_locks WHERE date = ?")
    .bind(INGEST_MUTEX_KEY)
    .first<{ created_at: string }>();
  if (existing) {
    const age = Date.now() - Date.parse(existing.created_at);
    if (Number.isFinite(age) && age < INGEST_MUTEX_STALE_MS) return false;
    await db.prepare("DELETE FROM run_locks WHERE date = ?").bind(INGEST_MUTEX_KEY).run();
  }
  const result = await db
    .prepare("INSERT OR IGNORE INTO run_locks (date, run_id, created_at) VALUES (?, ?, ?)")
    .bind(INGEST_MUTEX_KEY, crypto.randomUUID(), new Date().toISOString())
    .run();
  return result.meta.changes === 1;
}

export async function releaseIngestMutex(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM run_locks WHERE date = ?").bind(INGEST_MUTEX_KEY).run();
}
