import type { Env } from "../env";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export function verifyTelegramSecret(env: Env, headers: Headers): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  return headers.get(SECRET_HEADER) === expected;
}

/** Open bot: any chat with an id is accepted. Operator allowlist is optional elsewhere. */
export function isAllowedChat(_env: Env, chatId: string | number | undefined): boolean {
  return chatId !== undefined && String(chatId).length > 0;
}
