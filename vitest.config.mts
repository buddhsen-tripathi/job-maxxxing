import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations/", import.meta.url).pathname);

  return {
    test: {
      globals: true,
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            compatibilityFlags: ["nodejs_compat"],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
