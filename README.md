# job-maxxing

Personal job-search agent on Cloudflare Workers. Runs once per day, discovers
software-engineering roles, deduplicates, scores against a verified candidate
profile, and sends a Telegram digest. Human approval is required before any
consequential action.

## Status

Milestones complete: 1 (bootstrap), 2 (data model). See PLAN.md for the roadmap.

## Stack

- Cloudflare Workers + Hono + TypeScript (strict)
- D1 (SQLite), Cron Trigger `0 13 * * *` (13:00 UTC = 9:00 AM New York EDT / 8:00 AM EST)
- Vitest via `@cloudflare/vitest-pool-workers`, Biome, Bun, Wrangler

## Setup

```sh
bun install
cp .dev.vars.example .dev.vars   # fill in secrets for local dev (never commit)
```

Secrets for production are set with Wrangler, e.g.:

```sh
bunx wrangler secret put TELEGRAM_BOT_TOKEN
```

## Commands

```sh
bun run dev     # start local worker (http://localhost:8787)
bun run test    # run tests
bun run typecheck # tsc --noEmit
bun run lint    # biome check
bun run lint:fix # biome check --write
```

## Endpoints

- `GET /health` — liveness + D1 connectivity check

## Database

Migrations live in `migrations/`. Apply them locally with:

```sh
bunx wrangler d1 migrations apply job-maxxing --local
```

Repositories live in `src/db/repositories/` (runs, jobs + scores + actions,
applications). Tests apply migrations automatically via
`@cloudflare/vitest-pool-workers`.

Candidate data is validated by Zod schemas in `src/candidate/`. Copy
`candidate-profile.example.json` and `search-preferences.example.json` to
create real local data (never commit real profiles).

## Notes

- `wrangler.jsonc` contains a placeholder D1 `database_id`; replace with the real
  ID after `bunx wrangler d1 create job-maxxing`.
- Secrets are optional at the type level in Milestone 1; `parseSecrets` in
  `src/config.ts` validates them with readable errors when a feature needs them.
