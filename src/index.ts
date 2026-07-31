import { createApp } from "./app";
import type { Env } from "./env";
import { runDailyJobSearch } from "./workflows/daily-job-search";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyJobSearch(env, { triggerType: "cron" }));
  },
};
