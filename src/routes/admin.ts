import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { parseTelegramSecrets, type TelegramSecrets } from "../config";
import { upsertAtsBoard } from "../db/repositories/boards";
import type { Env } from "../env";
import { createTelegramClient } from "../telegram/client";
import { runDailyJobSearch } from "../workflows/daily-job-search";

export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (!c.env.ADMIN_TOKEN) {
    return c.json({ error: "admin_disabled", message: "ADMIN_TOKEN is not configured." }, 503);
  }
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

const RunDailyBodySchema = z.object({
  dryRun: z.boolean().default(false),
  /** When false (default), run in background and return 202 immediately. */
  sync: z.boolean().default(false),
  sourceNames: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(100).optional(),
  preferEnvSources: z.boolean().optional(),
});

const UpsertBoardBodySchema = z.object({
  provider: z.enum(["greenhouse", "lever", "ashby", "workday"]),
  slug: z.string().min(1),
  companyName: z.string().min(1),
  tier: z.enum(["priority", "standard"]).default("standard"),
  active: z.boolean().default(true),
  sector: z.string().nullable().optional(),
});

export const admin = new Hono<{ Bindings: Env }>()
  .use("/*", adminAuth)
  .post("/run-daily", async (c) => {
    const parsed = RunDailyBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", details: parsed.error.message }, 400);
    }
    const options = {
      triggerType: "manual" as const,
      dryRun: parsed.data.dryRun,
      ...(parsed.data.sourceNames ? { sourceNames: parsed.data.sourceNames } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.preferEnvSources !== undefined
        ? { preferEnvSources: parsed.data.preferEnvSources }
        : {}),
    };

    if (parsed.data.sync) {
      const summary = await runDailyJobSearch(c.env, options);
      return c.json({ summary }, summary.status === "failed" ? 500 : 200);
    }

    c.executionCtx.waitUntil(
      runDailyJobSearch(c.env, options).catch(() => {
        // Errors are persisted on the run row / logged inside the workflow.
      }),
    );
    return c.json(
      {
        accepted: true,
        dryRun: parsed.data.dryRun,
        message: "Run started in background. Check /api/runs or Telegram for results.",
      },
      202,
    );
  })
  .post("/boards", async (c) => {
    const parsed = UpsertBoardBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", details: parsed.error.message }, 400);
    }
    const board = await upsertAtsBoard(c.env.DB, {
      provider: parsed.data.provider,
      slug: parsed.data.slug,
      companyName: parsed.data.companyName,
      tier: parsed.data.tier,
      active: parsed.data.active,
      sector: parsed.data.sector ?? null,
    });
    return c.json({ board }, 200);
  })
  .post("/test-telegram", async (c) => {
    let secrets: TelegramSecrets;
    try {
      secrets = parseTelegramSecrets(c.env);
    } catch {
      return c.json({ error: "telegram_not_configured" }, 503);
    }
    const client = createTelegramClient({ token: secrets.TELEGRAM_BOT_TOKEN });
    const message = await client.sendMessage({
      chatId: secrets.TELEGRAM_ALLOWED_CHAT_ID,
      text: "job-maxxing test message — Telegram is configured correctly.",
    });
    return c.json({ ok: true, messageId: message.messageId });
  });
