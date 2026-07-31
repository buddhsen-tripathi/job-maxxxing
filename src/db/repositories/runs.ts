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
