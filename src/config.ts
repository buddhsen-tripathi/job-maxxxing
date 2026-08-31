import { z } from "zod";
import { type CandidateProfile, parseCandidateProfile } from "./candidate/profile";
import {
  type AtsBoardRow,
  boardToSourceEntry,
  countActiveAtsBoards,
  DEFAULT_BOARD_BATCH_SIZE,
  DEFAULT_PRIORITY_CAP,
  selectBoardsForIngest,
} from "./db/repositories/boards";
import { getAppConfigValue } from "./db/repositories/meta";
import {
  ensureUser,
  getUser,
  listActiveUsersWithProfiles,
  loadProfileForUser,
  upsertUserProfile,
} from "./db/repositories/users";
import type { Env } from "./env";
import { type SourceEntry, SourcesConfigSchema } from "./sources/source-adapter";

const SecretsSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  /** Optional operator chat for legacy default user + admin ping fallback. */
  TELEGRAM_ALLOWED_CHAT_ID: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1),
});

export type Secrets = z.infer<typeof SecretsSchema>;

const VarsSchema = z.object({
  APP_BASE_URL: z.string().url(),
  ENVIRONMENT: z.enum(["development", "production"]),
});

export type AppConfig = z.infer<typeof VarsSchema> & { db: D1Database };

export function parseVars(env: Env): AppConfig {
  const result = VarsSchema.safeParse({
    APP_BASE_URL: env.APP_BASE_URL,
    ENVIRONMENT: env.ENVIRONMENT,
  });
  if (!result.success) {
    throw new Error(`Invalid environment variables: ${result.error.message}`);
  }
  return { ...result.data, db: env.DB };
}

export function parseSecrets(env: Env): Secrets {
  const result = SecretsSchema.safeParse({
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
    ...(env.TELEGRAM_ALLOWED_CHAT_ID
      ? { TELEGRAM_ALLOWED_CHAT_ID: env.TELEGRAM_ALLOWED_CHAT_ID }
      : {}),
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: env.OPENROUTER_MODEL,
  });
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid secrets: ${missing}`);
  }
  return result.data;
}

const TelegramSecretsSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_ID: z.string().min(1).optional(),
});

export type TelegramSecrets = z.infer<typeof TelegramSecretsSchema>;

export function parseTelegramSecrets(env: Env): TelegramSecrets {
  const result = TelegramSecretsSchema.safeParse({
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
    ...(env.TELEGRAM_ALLOWED_CHAT_ID
      ? { TELEGRAM_ALLOWED_CHAT_ID: env.TELEGRAM_ALLOWED_CHAT_ID }
      : {}),
  });
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid Telegram secrets: ${missing}`);
  }
  return result.data;
}

function parseJsonEnv(raw: string | undefined, name: string): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Environment variable ${name} is not valid JSON`);
  }
}

/** Sync env-only source list (tests / local override). Prefer D1 ats_boards in prod. */
export function parseSourcesConfig(env: Env): SourceEntry[] {
  const raw = parseJsonEnv(env.SOURCES_JSON, "SOURCES_JSON");
  if (raw === null) return [];
  const result = SourcesConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid SOURCES_JSON: ${result.error.message}`);
  }
  return result.data;
}

export interface LoadSourcesOptions {
  /** Force SOURCES_JSON even when D1 has boards (tests). */
  preferEnvSources?: boolean;
  /** @deprecated Prefer batchSize. */
  standardBatchSize?: number;
  batchSize?: number;
  priorityCap?: number;
  sourceNames?: string[];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function loadSourcesForIngest(
  env: Env,
  options: LoadSourcesOptions = {},
): Promise<{ entries: SourceEntry[]; boards: AtsBoardRow[]; fromCatalog: boolean }> {
  const catalogCount = options.preferEnvSources ? 0 : await countActiveAtsBoards(env.DB);

  if (catalogCount > 0) {
    const batchSize =
      options.batchSize ??
      options.standardBatchSize ??
      parsePositiveInt(env.BOARD_INGEST_BATCH_SIZE, DEFAULT_BOARD_BATCH_SIZE);
    const priorityCap =
      options.priorityCap ?? parsePositiveInt(env.BOARD_PRIORITY_CAP, DEFAULT_PRIORITY_CAP);
    let boards = await selectBoardsForIngest(env.DB, { batchSize, priorityCap });
    if (options.sourceNames?.length) {
      boards = boards.filter((board) => options.sourceNames?.includes(board.provider));
    }
    return {
      entries: boards.map(boardToSourceEntry),
      boards,
      fromCatalog: true,
    };
  }

  let entries = parseSourcesConfig(env);
  if (options.sourceNames?.length) {
    entries = entries.filter((entry) => options.sourceNames?.includes(entry.source));
  }
  return { entries, boards: [], fromCatalog: false };
}

async function readLegacyProfile(env: Env): Promise<CandidateProfile | null> {
  const fromDb = await getAppConfigValue(env.DB, "candidate_profile");
  if (fromDb) {
    return parseCandidateProfile(JSON.parse(fromDb));
  }
  const raw = parseJsonEnv(env.CANDIDATE_PROFILE_JSON, "CANDIDATE_PROFILE_JSON");
  if (raw === null) return null;
  return parseCandidateProfile(raw);
}

/**
 * Ensure the default user has a profile row, migrating from app_config / env if needed.
 * Also stamps telegram_chat_id from secrets when present.
 */
export async function ensureDefaultUserProfile(env: Env): Promise<void> {
  let telegramChatId: string | null = null;
  try {
    telegramChatId = parseTelegramSecrets(env).TELEGRAM_ALLOWED_CHAT_ID ?? null;
  } catch {
    // optional during dry runs / tests without telegram
  }

  const existingUser = await getUser(env.DB, "default");
  await ensureUser(env.DB, {
    id: "default",
    displayName: "Default operator",
    telegramChatId,
    active: existingUser ? existingUser.active === 1 : true,
  });

  const existing = await loadProfileForUser(env.DB, "default");
  if (existing) return;

  const legacy = await readLegacyProfile(env);
  if (legacy) {
    await upsertUserProfile(env.DB, "default", legacy);
  }
}

export async function loadCandidateProfile(env: Env): Promise<CandidateProfile> {
  await ensureDefaultUserProfile(env);
  const fromUser = await loadProfileForUser(env.DB, "default");
  if (fromUser) return fromUser;

  const legacy = await readLegacyProfile(env);
  if (legacy) return legacy;

  throw new Error(
    "Missing candidate profile: set user_profiles for user 'default', app_config.candidate_profile, or CANDIDATE_PROFILE_JSON",
  );
}

export async function loadActiveProfiles(env: Env) {
  await ensureDefaultUserProfile(env);
  const withProfiles = await listActiveUsersWithProfiles(env.DB);
  if (withProfiles.length > 0) return withProfiles;

  const defaultUser = await getUser(env.DB, "default");
  if (defaultUser && defaultUser.active !== 1) return [];

  const profile = await loadCandidateProfile(env);
  return [
    {
      user: {
        id: "default",
        display_name: "Default operator",
        telegram_chat_id: env.TELEGRAM_ALLOWED_CHAT_ID ?? null,
        active: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      profile,
    },
  ];
}

/** @deprecated Prefer loadCandidateProfile — sync env-only path for tests. */
export function parseCandidateProfileEnv(env: Env): CandidateProfile {
  const raw = parseJsonEnv(env.CANDIDATE_PROFILE_JSON, "CANDIDATE_PROFILE_JSON");
  if (raw === null) {
    throw new Error("Missing CANDIDATE_PROFILE_JSON environment variable");
  }
  return parseCandidateProfile(raw);
}

export function parseScoreThresholds(env: Env): { strongMatch: number; review: number } {
  const strongRaw = env.SCORE_STRONG_MATCH_THRESHOLD;
  const reviewRaw = env.SCORE_REVIEW_THRESHOLD;
  const strongMatch = strongRaw === undefined ? 85 : Number(strongRaw);
  const review = reviewRaw === undefined ? 60 : Number(reviewRaw);
  for (const [name, value] of [
    ["SCORE_STRONG_MATCH_THRESHOLD", strongMatch],
    ["SCORE_REVIEW_THRESHOLD", review],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error(`${name} must be an integer between 0 and 100, got "${value}"`);
    }
  }
  if (strongMatch <= review) {
    throw new Error(
      `SCORE_STRONG_MATCH_THRESHOLD (${strongMatch}) must be greater than SCORE_REVIEW_THRESHOLD (${review})`,
    );
  }
  return { strongMatch, review };
}
