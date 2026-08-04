import type { SourceEntry } from "../../sources/source-adapter";
import { newId, nowIso } from "../client";
import type { AtsBoardRow, AtsBoardTier, AtsProvider } from "../schema";

export type { AtsBoardRow, AtsBoardTier, AtsProvider };

export interface UpsertAtsBoardInput {
  id?: string;
  provider: AtsProvider;
  slug: string;
  companyName: string;
  tier?: AtsBoardTier;
  active?: boolean;
  sector?: string | null;
  now?: Date;
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
  }
}

export async function upsertAtsBoard(
  db: D1Database,
  input: UpsertAtsBoardInput,
): Promise<AtsBoardRow> {
  const now = nowIso(input.now);
  const id = input.id ?? newId();
  await db
    .prepare(
      `INSERT INTO ats_boards (
         id, provider, slug, company_name, tier, active, sector, last_polled_at, last_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(provider, slug) DO UPDATE SET
         company_name = excluded.company_name,
         tier = excluded.tier,
         active = excluded.active,
         sector = excluded.sector,
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

/**
 * Boards to poll this cycle: all active priority boards, plus the least-recently
 * polled standard boards (round-robin via last_polled_at).
 */
export async function selectBoardsForIngest(
  db: D1Database,
  options: { standardBatchSize?: number } = {},
): Promise<AtsBoardRow[]> {
  const standardBatchSize = options.standardBatchSize ?? 8;
  const priority = await db
    .prepare(
      `SELECT * FROM ats_boards
       WHERE active = 1 AND tier = 'priority'
       ORDER BY company_name ASC`,
    )
    .all<AtsBoardRow>();

  const standard = await db
    .prepare(
      `SELECT * FROM ats_boards
       WHERE active = 1 AND tier = 'standard'
       ORDER BY last_polled_at IS NOT NULL, last_polled_at ASC, company_name ASC
       LIMIT ?`,
    )
    .bind(standardBatchSize)
    .all<AtsBoardRow>();

  return [...priority.results, ...standard.results];
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
