import type { applyD1Migrations } from "cloudflare:test";
import type { Env } from "../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  }
}
