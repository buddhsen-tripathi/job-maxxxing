import type { Env } from "../env";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export function verifyTelegramSecret(env: Env, headers: Headers): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  return headers.get(SECRET_HEADER) === expected;
}

export function isAllowedChat(env: Env, chatId: string | number | undefined): boolean {
  if (chatId === undefined) return false;
  return String(chatId) === String(env.TELEGRAM_ALLOWED_CHAT_ID ?? "");
}
