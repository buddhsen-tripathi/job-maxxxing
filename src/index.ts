import { createApp } from "./app";
import type { Env } from "./env";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(
      JSON.stringify({
        operation: "daily_job_search",
        status: "not_implemented",
        message: "Daily job search is implemented in Milestone 5.",
      }),
    );
  },
};
