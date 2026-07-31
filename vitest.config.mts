import { readFileSync } from "node:fs";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations/", import.meta.url).pathname);
  const candidateProfile = readFileSync(
    new URL("./candidate-profile.example.json", import.meta.url).pathname,
    "utf-8",
  );

  return {
    test: {
      globals: true,
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              TEST_MIGRATIONS: migrations,
              ADMIN_TOKEN: "test-admin-token",
              CANDIDATE_PROFILE_JSON: candidateProfile,
              TELEGRAM_BOT_TOKEN: "test-bot-token",
              TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
              TELEGRAM_ALLOWED_CHAT_ID: "12345",
            },
          },
        },
      },
    },
  };
});
