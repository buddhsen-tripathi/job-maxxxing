import { nowIso } from "../client";
import type { UserResumeRow } from "../schema";

export async function getUserResume(db: D1Database, userId: string): Promise<UserResumeRow | null> {
  return db
    .prepare("SELECT * FROM user_resumes WHERE user_id = ?")
    .bind(userId)
    .first<UserResumeRow>();
}

export async function upsertUserResume(
  db: D1Database,
  input: {
    userId: string;
    r2Key: string;
    contentType: string;
    fileName: string;
    now?: Date;
  },
): Promise<void> {
  const stamp = nowIso(input.now);
  await db
    .prepare(
      `INSERT INTO user_resumes (user_id, r2_key, content_type, file_name, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         r2_key = excluded.r2_key,
         content_type = excluded.content_type,
         file_name = excluded.file_name,
         updated_at = excluded.updated_at`,
    )
    .bind(input.userId, input.r2Key, input.contentType, input.fileName, stamp)
    .run();
}
