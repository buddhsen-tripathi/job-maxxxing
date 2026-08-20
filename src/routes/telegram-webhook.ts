import { Hono } from "hono";
import { z } from "zod";
import {
  ensureDefaultUserProfile,
  parseSecrets,
  parseTelegramSecrets,
  type TelegramSecrets,
} from "../config";
import { getUserSession } from "../db/repositories/user-sessions";
import { ensureTelegramUser, getUserProfile, loadProfileForUser } from "../db/repositories/users";
import type { Env } from "../env";
import { createOpenRouterLlmClient } from "../llm/openrouter";
import { handleApplyMessage, isApplySessionState } from "../telegram/apply";
import { handleCallbackQuery } from "../telegram/callbacks";
import { createTelegramClient } from "../telegram/client";
import { handleBotCommand, parseBotCommand, resumeDigests } from "../telegram/commands";
import {
  handleOnboardingMessage,
  isOnboardingInProgress,
  startOnboarding,
} from "../telegram/onboarding";
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
      resumes: c.env.RESUMES,
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
    const session = await getUserSession(c.env.DB, user.id);
    if (!isOnboardingInProgress(session)) {
      const profile = await getUserProfile(c.env.DB, user.id);
      if (profile) {
        await resumeDigests(c.env.DB, client, chatIdStr, user.id);
        return c.json({ ok: true });
      }
    }
    await startOnboarding(c.env.DB, client, user, chatIdStr);
    return c.json({ ok: true });
  }

  const knownBotCommand = text ? parseBotCommand(text) : null;

  if (text && !knownBotCommand && !isOnboardingCommand(text)) {
    const applySession = await getUserSession(c.env.DB, user.id);
    if (applySession && isApplySessionState(applySession.state)) {
      const profile = await loadProfileForUser(c.env.DB, user.id);
      if (profile) {
        const apply = await handleApplyMessage({
          db: c.env.DB,
          client,
          chatId: chatIdStr,
          userId: user.id,
          profile,
          text,
        });
        if (apply.handled) return c.json({ ok: true });
      }
    }
  }

  const session = user.active !== 1 ? await getUserSession(c.env.DB, user.id) : null;
  const awaitingOnboarding =
    user.active !== 1 &&
    (isOnboardingInProgress(session) || !(await getUserProfile(c.env.DB, user.id)));
  const routeToOnboarding =
    isOnboardingCommand(text) ||
    (awaitingOnboarding && !knownBotCommand && Boolean(text || message.document));

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
      resumes: c.env.RESUMES,
    });
    if (onboarding.handled) return c.json({ ok: true });
  }

  if (message.text) {
    const result = await handleBotCommand(c.env.DB, client, chatIdStr, message.text, {
      userId: user.id,
    });
    if (result.handled) return c.json({ ok: true });
  }

  if (user.active !== 1 && (await getUserProfile(c.env.DB, user.id))) {
    await client.sendMessage({
      chatId: chatIdStr,
      text: "Digests are paused. /resume to continue, /restart to rebuild your profile.",
    });
    return c.json({ ok: true });
  }

  if (message.text) {
    return c.json({ ok: true, ignored: true, reason: "unsupported_message" });
  }

  return c.json({ ok: true, ignored: true, reason: "unsupported_update" });
});
