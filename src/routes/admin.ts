import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Env } from "../env";
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
  sourceNames: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export const admin = new Hono<{ Bindings: Env }>()
  .use("/*", adminAuth)
  .post("/run-daily", async (c) => {
    const parsed = RunDailyBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", details: parsed.error.message }, 400);
    }
    const summary = await runDailyJobSearch(c.env, {
      triggerType: "manual",
      dryRun: parsed.data.dryRun,
      ...(parsed.data.sourceNames ? { sourceNames: parsed.data.sourceNames } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    });
    return c.json({ summary }, summary.status === "failed" ? 500 : 200);
  });
