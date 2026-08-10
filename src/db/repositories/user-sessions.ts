import { nowIso } from "../client";
import type { UserSessionRow, UserSessionState } from "../schema";

export async function getUserSession(
  db: D1Database,
  userId: string,
): Promise<UserSessionRow | null> {
  return db
    .prepare("SELECT * FROM user_sessions WHERE user_id = ?")
    .bind(userId)
    .first<UserSessionRow>();
}

export async function upsertUserSession(
  db: D1Database,
  input: {
    userId: string;
    state: UserSessionState;
    draftJson?: string | null;
    now?: Date;
  },
): Promise<void> {
  const stamp = nowIso(input.now);
  await db
    .prepare(
      `INSERT INTO user_sessions (user_id, state, draft_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         state = excluded.state,
         draft_json = excluded.draft_json,
         updated_at = excluded.updated_at`,
    )
    .bind(input.userId, input.state, input.draftJson ?? null, stamp)
    .run();
}

export async function clearUserSession(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(userId).run();
}
