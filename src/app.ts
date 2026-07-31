import { Hono } from "hono";
import type { Env } from "./env";
import { health } from "./routes/health";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/health", health);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(JSON.stringify({ operation: "unhandled_error", message: err.message }));
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
