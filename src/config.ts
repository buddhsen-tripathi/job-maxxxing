import { z } from "zod";
import { type CandidateProfile, parseCandidateProfile } from "./candidate/profile";
import type { Env } from "./env";
import { type SourceEntry, SourcesConfigSchema } from "./sources/source-adapter";

const SecretsSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_ID: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
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
    TELEGRAM_ALLOWED_CHAT_ID: env.TELEGRAM_ALLOWED_CHAT_ID,
    LLM_API_KEY: env.LLM_API_KEY,
    LLM_MODEL: env.LLM_MODEL,
  });
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid secrets: ${missing}`);
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

export function parseSourcesConfig(env: Env): SourceEntry[] {
  const raw = parseJsonEnv(env.SOURCES_JSON, "SOURCES_JSON");
  if (raw === null) return [];
  const result = SourcesConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid SOURCES_JSON: ${result.error.message}`);
  }
  return result.data;
}

export function parseCandidateProfileEnv(env: Env): CandidateProfile {
  const raw = parseJsonEnv(env.CANDIDATE_PROFILE_JSON, "CANDIDATE_PROFILE_JSON");
  if (raw === null) {
    throw new Error("Missing CANDIDATE_PROFILE_JSON environment variable");
  }
  return parseCandidateProfile(raw);
}
