import { Hono } from "hono";
import { getRun, listRuns } from "../db/repositories/runs";
import type { Env } from "../env";

export const runs = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    return c.json({ runs: await listRuns(c.env.DB) });
  })
  .get("/:id", async (c) => {
    const run = await getRun(c.env.DB, c.req.param("id"));
    if (!run) return c.json({ error: "not_found" }, 404);
    return c.json({ run });
  });
