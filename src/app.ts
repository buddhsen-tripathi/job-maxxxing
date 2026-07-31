import { Hono } from "hono";
import type { Env } from "./env";
import { admin } from "./routes/admin";
import { health } from "./routes/health";
import { jobs } from "./routes/jobs";
import { runs } from "./routes/runs";
import { telegramWebhook } from "./routes/telegram-webhook";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/health", health);
  app.route("/api/jobs", jobs);
  app.route("/api/runs", runs);
  app.route("/api/admin", admin);
  app.route("/telegram/webhook", telegramWebhook);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(JSON.stringify({ operation: "unhandled_error", message: err.message }));
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
