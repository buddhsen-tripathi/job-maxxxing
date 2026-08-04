import { Hono } from "hono";
import { z } from "zod";
import type { CandidateProfile } from "../candidate/profile";
import {
  loadCandidateProfile,
  parseSecrets,
  parseTelegramSecrets,
  type TelegramSecrets,
} from "../config";
import type { Env } from "../env";
import { createOpenRouterLlmClient } from "../llm/openrouter";
import { handleCallbackQuery } from "../telegram/callbacks";
import { createTelegramClient } from "../telegram/client";
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
    })
    .optional(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      text: z.string().optional(),
    })
    .optional(),
});

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

  if (update.callback_query) {
    const client = createTelegramClient({ token: secrets.TELEGRAM_BOT_TOKEN });
    let profile: CandidateProfile | undefined;
    try {
      profile = await loadCandidateProfile(c.env);
    } catch {
      profile = undefined;
    }
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
    await handleCallbackQuery(c.env.DB, client, update.callback_query, {
      ...(profile ? { profile } : {}),
      ...(llm ? { llm } : {}),
    });
    return c.json({ ok: true });
  }

  return c.json({ ok: true, ignored: true, reason: "unsupported_update" });
});
