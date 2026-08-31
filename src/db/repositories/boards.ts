import type { SourceEntry } from "../../sources/source-adapter";
import { newId, nowIso } from "../client";
import type { AtsBoardRow, AtsBoardTier, AtsProvider } from "../schema";

export type { AtsBoardRow, AtsBoardTier, AtsProvider };

/** Default boards polled per cron tick (priority reserve + standard fill). */
export const DEFAULT_BOARD_BATCH_SIZE = 16;
/** Max priority boards taken each tick so standard boards still rotate. */
export const DEFAULT_PRIORITY_CAP = 6;

/**
 * Round-robin across ATS providers so a tick is not all Greenhouse (or all
 * of any one vendor) when many boards share the same last_polled_at.
 */
export function interleaveByProvider<T extends { provider: string }>(items: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.provider) ?? [];
    list.push(item);
    groups.set(item.provider, list);
  }
  const queues = [...groups.values()];
  const out: T[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

export interface UpsertAtsBoardInput {
  id?: string;
  provider: AtsProvider;
  slug: string;
  companyName: string;
  tier?: AtsBoardTier;
  active?: boolean;
  sector?: string | null;
  now?: Date;
  /** When true, do not demote an existing priority board to standard. */
  preservePriority?: boolean;
  /** When true, leave manually deactivated boards inactive. */
  preserveInactive?: boolean;
}

export function boardToSourceEntry(board: AtsBoardRow): SourceEntry {
  switch (board.provider) {
    case "greenhouse":
      return {
        source: "greenhouse",
        company: board.company_name,
        boardToken: board.slug,
      };
    case "lever":
      return {
        source: "lever",
        company: board.company_name,
        account: board.slug,
      };
    case "ashby":
      return {
        source: "ashby",
        company: board.company_name,
        boardSlug: board.slug,
      };
    case "workday": {
      const [host, tenant, site] = board.slug.split("/");
      if (!host || !tenant || !site) {
        throw new Error(`Invalid workday board slug "${board.slug}"; expected host/tenant/site.`);
      }
      return { source: "workday", company: board.company_name, host, tenant, site, limit: 50 };
    }
  }
}

export async function upsertAtsBoard(
  db: D1Database,
  input: UpsertAtsBoardInput,
): Promise<AtsBoardRow> {
  const now = nowIso(input.now);
  const id = input.id ?? newId();
  const preservePriority = input.preservePriority === true;
  const preserveInactive = input.preserveInactive === true;
  const tierExpr = preservePriority
    ? `CASE WHEN ats_boards.tier = 'priority' THEN ats_boards.tier ELSE excluded.tier END`
    : `excluded.tier`;
  const activeExpr = preserveInactive
    ? `CASE WHEN ats_boards.active = 0 THEN 0 ELSE excluded.active END`
    : `excluded.active`;

  await db
    .prepare(
      `INSERT INTO ats_boards (
         id, provider, slug, company_name, tier, active, sector, last_polled_at, last_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(provider, slug) DO UPDATE SET
         company_name = excluded.company_name,
         tier = ${tierExpr},
         active = ${activeExpr},
         sector = COALESCE(excluded.sector, ats_boards.sector),
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      input.provider,
      input.slug,
      input.companyName,
      input.tier ?? "standard",
      input.active === false ? 0 : 1,
      input.sector ?? null,
      now,
      now,
    )
    .run();

  const row = await db
    .prepare("SELECT * FROM ats_boards WHERE provider = ? AND slug = ?")
    .bind(input.provider, input.slug)
    .first<AtsBoardRow>();
  if (!row) throw new Error(`Failed to upsert ats_board ${input.provider}/${input.slug}`);
  return row;
}

export async function countActiveAtsBoards(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM ats_boards WHERE active = 1")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listActiveAtsBoards(db: D1Database): Promise<AtsBoardRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM ats_boards WHERE active = 1
       ORDER BY CASE tier WHEN 'priority' THEN 0 ELSE 1 END, company_name ASC`,
    )
    .all<AtsBoardRow>();
  return result.results;
}

export interface SelectBoardsOptions {
  /** @deprecated Prefer batchSize — kept for call-site compatibility. */
  standardBatchSize?: number;
  batchSize?: number;
  priorityCap?: number;
}

/**
 * Boards to poll this cycle: up to `priorityCap` least-recently-polled priority
 * boards, then fill remaining `batchSize` slots with the least-recently-polled
 * active boards (mostly standard). This keeps priority hot while rotating a
 * large standard catalog.
 */
export async function selectBoardsForIngest(
  db: D1Database,
  options: SelectBoardsOptions = {},
): Promise<AtsBoardRow[]> {
  const batchSize = options.batchSize ?? options.standardBatchSize ?? DEFAULT_BOARD_BATCH_SIZE;
  const priorityCap = options.priorityCap ?? DEFAULT_PRIORITY_CAP;

  const priority = await db
    .prepare(
      `SELECT * FROM ats_boards
       WHERE active = 1 AND tier = 'priority'
       ORDER BY last_polled_at IS NOT NULL, last_polled_at ASC, company_name ASC
       LIMIT ?`,
    )
    .bind(Math.min(priorityCap, batchSize))
    .all<AtsBoardRow>();

  const remaining = Math.max(0, batchSize - priority.results.length);
  if (remaining === 0) return interleaveByProvider(priority.results);

  const oversample = remaining * 4;
  if (priority.results.length === 0) {
    const rest = await db
      .prepare(
        `SELECT * FROM ats_boards
         WHERE active = 1
         ORDER BY last_polled_at IS NOT NULL, last_polled_at ASC, company_name ASC
         LIMIT ?`,
      )
      .bind(oversample)
      .all<AtsBoardRow>();
    return interleaveByProvider(rest.results).slice(0, remaining);
  }

  const placeholders = priority.results.map(() => "?").join(", ");
  const rest = await db
    .prepare(
      `SELECT * FROM ats_boards
       WHERE active = 1 AND id NOT IN (${placeholders})
       ORDER BY last_polled_at IS NOT NULL, last_polled_at ASC, company_name ASC
       LIMIT ?`,
    )
    .bind(...priority.results.map((b) => b.id), oversample)
    .all<AtsBoardRow>();

  const mixedRest = interleaveByProvider(rest.results).slice(0, remaining);
  return interleaveByProvider([...priority.results, ...mixedRest]);
}

export async function markBoardPolled(
  db: D1Database,
  boardId: string,
  status: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE ats_boards
       SET last_polled_at = ?, last_status = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(nowIso(now), status, nowIso(now), boardId)
    .run();
}
