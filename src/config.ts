import { z } from "zod";
import type { Env } from "./env";

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
