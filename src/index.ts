import { createApp } from "./app";
import type { Env } from "./env";
import { runDailyJobSearch } from "./workflows/daily-job-search";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await runDailyJobSearch(env, { triggerType: "cron" });
  },
};
