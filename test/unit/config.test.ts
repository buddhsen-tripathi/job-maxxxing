import { describe, expect, it } from "vitest";
import { parseSecrets, parseVars } from "../../src/config";
import type { Env } from "../../src/env";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    APP_BASE_URL: "http://localhost:8787",
    ENVIRONMENT: "development",
    ...overrides,
  };
}

describe("parseVars", () => {
  it("parses valid vars", () => {
    const config = parseVars(baseEnv());
    expect(config.APP_BASE_URL).toBe("http://localhost:8787");
    expect(config.ENVIRONMENT).toBe("development");
  });

  it("rejects an invalid APP_BASE_URL", () => {
    expect(() => parseVars(baseEnv({ APP_BASE_URL: "not-a-url" }))).toThrow(
      /Invalid environment variables/,
    );
  });

  it("rejects an invalid ENVIRONMENT", () => {
    expect(() => parseVars(baseEnv({ ENVIRONMENT: "staging" as Env["ENVIRONMENT"] }))).toThrow(
      /Invalid environment variables/,
    );
  });
});

describe("parseSecrets", () => {
  const secrets = {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_ALLOWED_CHAT_ID: "123",
    LLM_API_KEY: "key",
    LLM_MODEL: "model",
  };

  it("parses when all secrets are present", () => {
    expect(parseSecrets(baseEnv(secrets))).toEqual(secrets);
  });

  it("reports which secrets are missing", () => {
    expect(() => parseSecrets(baseEnv({ TELEGRAM_BOT_TOKEN: "token" }))).toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
  });

  it("rejects empty secret values", () => {
    expect(() => parseSecrets(baseEnv({ ...secrets, LLM_API_KEY: "" }))).toThrow(/LLM_API_KEY/);
  });
});
