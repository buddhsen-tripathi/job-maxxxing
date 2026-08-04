import type { CandidateProfile } from "../../candidate/profile";
import { parseCandidateProfile } from "../../candidate/profile";
import { nowIso } from "../client";
import type { UserProfileRow, UserRow } from "../schema";

export async function listActiveUsers(db: D1Database): Promise<UserRow[]> {
  const result = await db
    .prepare("SELECT * FROM users WHERE active = 1 ORDER BY created_at ASC")
    .all<UserRow>();
  return result.results;
}

export async function getUser(db: D1Database, userId: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function getUserProfile(
  db: D1Database,
  userId: string,
): Promise<UserProfileRow | null> {
  return db
    .prepare("SELECT * FROM user_profiles WHERE user_id = ?")
    .bind(userId)
    .first<UserProfileRow>();
}

export async function upsertUserProfile(
  db: D1Database,
  userId: string,
  profile: CandidateProfile,
  now: Date = new Date(),
): Promise<void> {
  const stamp = nowIso(now);
  await db
    .prepare(
      `INSERT INTO user_profiles (user_id, profile_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         profile_json = excluded.profile_json,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify(profile), stamp)
    .run();
}

export async function ensureUser(
  db: D1Database,
  input: {
    id: string;
    displayName?: string | null;
    telegramChatId?: string | null;
    active?: boolean;
    now?: Date;
  },
): Promise<UserRow> {
  const stamp = nowIso(input.now);
  await db
    .prepare(
      `INSERT INTO users (id, display_name, telegram_chat_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name),
         telegram_chat_id = COALESCE(excluded.telegram_chat_id, users.telegram_chat_id),
         active = excluded.active,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.displayName ?? null,
      input.telegramChatId ?? null,
      input.active === false ? 0 : 1,
      stamp,
      stamp,
    )
    .run();
  const row = await getUser(db, input.id);
  if (!row) throw new Error(`Failed to ensure user ${input.id}`);
  return row;
}

export async function loadProfileForUser(
  db: D1Database,
  userId: string,
): Promise<CandidateProfile | null> {
  const row = await getUserProfile(db, userId);
  if (!row) return null;
  return parseCandidateProfile(JSON.parse(row.profile_json));
}

export interface ActiveUserWithProfile {
  user: UserRow;
  profile: CandidateProfile;
}

export async function listActiveUsersWithProfiles(
  db: D1Database,
): Promise<ActiveUserWithProfile[]> {
  const users = await listActiveUsers(db);
  const out: ActiveUserWithProfile[] = [];
  for (const user of users) {
    const profile = await loadProfileForUser(db, user.id);
    if (profile) out.push({ user, profile });
  }
  return out;
}
