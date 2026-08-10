import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("returns 200 with ok status when the database is reachable", async () => {
    const response = await SELF.fetch("http://localhost/health");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      checks: { db: boolean };
      environment: string;
      timestamp: string;
    };

    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe(true);
    expect(body.environment).toBe(env.ENVIRONMENT);
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await SELF.fetch("http://localhost/nope");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("has a D1 binding available", () => {
    expect(env.DB).toBeDefined();
  });
});
