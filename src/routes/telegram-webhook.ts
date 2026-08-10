import { Hono } from "hono";
import { z } from "zod";
import {
  ensureDefaultUserProfile,
  parseSecrets,
  parseTelegramSecrets,
  type TelegramSecrets,
} from "../config";
import { ensureTelegramUser, loadProfileForUser } from "../db/repositories/users";
import type { Env } from "../env";
import { createOpenRouterLlmClient } from "../llm/openrouter";
import { handleCallbackQuery } from "../telegram/callbacks";
import { createTelegramClient } from "../telegram/client";
import { handleBotCommand, parseBotCommand } from "../telegram/commands";
import { handleOnboardingMessage, startOnboarding } from "../telegram/onboarding";
import { isAllowedChat, verifyTelegramSecret } from "../telegram/security";

const UpdateSchema = z.object({
  update_id: z.number(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z
        .object({
          message_id: z.number(),
          chat: z.object({ id: z.union([z.number(), z.string()]) }),
        })
        .optional(),
      from: z
        .object({
          first_name: z.string().optional(),
          username: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      text: z.string().optional(),
      from: z
        .object({
          first_name: z.string().optional(),
          username: z.string().optional(),
        })
        .optional(),
      document: z
        .object({
          file_id: z.string(),
          file_name: z.string().optional(),
          mime_type: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

function displayNameFrom(from?: {
  first_name?: string | undefined;
  username?: string | undefined;
}): string | null {
  if (!from) return null;
  return from.first_name ?? from.username ?? null;
}

function isOnboardingCommand(text: string): boolean {
  return /^\/(restart|status)(?:@\S+)?(?:\s|$)/i.test(text);
}

export const telegramWebhook = new Hono<{ Bindings: Env }>().post("/", async (c) => {
  if (!verifyTelegramSecret(c.env, c.req.raw.headers)) {
    return c.json({ error: "forbidden" }, 403);
  }

  let secrets: TelegramSecrets;
  try {
    secrets = parseTelegramSecrets(c.env);
  } catch {
    return c.json({ error: "telegram_not_configured" }, 503);
  }

  const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ ok: true, ignored: true, reason: "unsupported_update" });
  }
  const update = parsed.data;

  const chatId = update.callback_query?.message?.chat.id ?? update.message?.chat.id;
  if (!isAllowedChat(c.env, chatId)) {
    return c.json({ ok: true, ignored: true, reason: "chat_not_allowed" });
  }

  const chatIdStr = String(chatId);
  const from = update.callback_query?.from ?? update.message?.from;
  const user = await ensureTelegramUser(c.env.DB, {
    chatId: chatIdStr,
    displayName: displayNameFrom(from),
    operatorChatId: secrets.TELEGRAM_ALLOWED_CHAT_ID ?? null,
  });

  const client = createTelegramClient({ token: secrets.TELEGRAM_BOT_TOKEN });

  let llm: ReturnType<typeof createOpenRouterLlmClient> | undefined;
  try {
    const llmSecrets = parseSecrets(c.env);
    llm = createOpenRouterLlmClient({
      apiKey: llmSecrets.OPENROUTER_API_KEY,
      model: llmSecrets.OPENROUTER_MODEL,
      siteUrl: c.env.APP_BASE_URL,
      siteName: "job-maxxing",
    });
  } catch {
    llm = undefined;
  }

  if (update.callback_query) {
    await ensureDefaultUserProfile(c.env);
    const profile = await loadProfileForUser(c.env.DB, user.id);
    await handleCallbackQuery(c.env.DB, client, update.callback_query, {
      userId: user.id,
      ...(profile ? { profile } : {}),
      ...(llm ? { llm } : {}),
    });
    return c.json({ ok: true });
  }

  const message = update.message;
  if (!message) {
    return c.json({ ok: true, ignored: true, reason: "unsupported_update" });
  }

  const text = message.text?.trim() ?? "";
  const isStart = /^\/start(?:@\S+)?(?:\s|$)/i.test(text);

  if (isStart && user.active !== 1) {
    await startOnboarding(c.env.DB, client, user, chatIdStr);
    return c.json({ ok: true });
  }

  const knownBotCommand = text ? parseBotCommand(text) : null;
  const routeToOnboarding =
    Boolean(message.document) ||
    isOnboardingCommand(text) ||
    (user.active !== 1 && !knownBotCommand && Boolean(text || message.document));

  if (routeToOnboarding) {
    if (!llm) {
      await client.sendMessage({
        chatId: chatIdStr,
        text: "Bot is warming up (LLM not configured). Try again shortly.",
      });
      return c.json({ ok: true });
    }
    const onboarding = await handleOnboardingMessage({
      db: c.env.DB,
      client,
      user,
      chatId: chatIdStr,
      ...(message.text ? { text: message.text } : {}),
      ...(message.document
        ? {
            document: {
              fileId: message.document.file_id,
              ...(message.document.file_name ? { fileName: message.document.file_name } : {}),
              ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {}),
            },
          }
        : {}),
      botToken: secrets.TELEGRAM_BOT_TOKEN,
      llm,
    });
    if (onboarding.handled) return c.json({ ok: true });
  }

  if (message.text) {
    const result = await handleBotCommand(c.env.DB, client, chatIdStr, message.text, {
      userId: user.id,
    });
    if (result.handled) return c.json({ ok: true });
    return c.json({ ok: true, ignored: true, reason: "unsupported_message" });
  }

  return c.json({ ok: true, ignored: true, reason: "unsupported_update" });
});
