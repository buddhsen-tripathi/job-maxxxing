# job-maxxing

Personal job-search agent on Cloudflare Workers. Runs once per day, discovers
software-engineering roles from Greenhouse and Lever boards, deduplicates,
scores against a verified candidate profile with an LLM, and sends a Telegram
digest. Applications are prepared on demand but **never submitted** — every
consequential action requires explicit human approval.

## Stack

- Cloudflare Workers + Hono + TypeScript (strict), Bun
- D1 (SQLite), Cron Trigger `0 13 * * *` (13:00 UTC = 9:00 AM New York EDT / 8:00 AM EST)
- Telegram Bot API over fetch, provider-neutral LLM client (OpenAI-compatible)
- Vitest via `@cloudflare/vitest-pool-workers`, Biome, Wrangler

## Local setup

```sh
bun install
cp .dev.vars.example .dev.vars   # fill in values; never commit
bunx wrangler d1 migrations apply job-maxxing --local
bun run dev                      # http://localhost:8787
```

## Commands

```sh
bun run dev        # local worker
bun run test       # 108 tests (unit + integration + e2e smoke)
bun run typecheck  # tsc --noEmit
bun run lint       # biome check
bun run deploy     # wrangler deploy
```

## Configuration

Secrets (set with `bunx wrangler secret put <NAME>` in production, `.dev.vars` locally):

| Name | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random string; verified on every webhook call |
| `TELEGRAM_ALLOWED_CHAT_ID` | Your personal chat ID (allowlist) |
| `LLM_API_KEY` | OpenAI-compatible API key |
| `LLM_MODEL` | Model name (e.g. `gpt-4o-mini`) |
| `ADMIN_TOKEN` | Bearer token for `/api/admin/*` |

Non-secret JSON vars (can also be `.dev.vars` or wrangler `vars`):

- `SOURCES_JSON` — discovery sources, e.g.
  `[{"source":"greenhouse","company":"Acme","boardToken":"acme"},{"source":"lever","company":"Beta","account":"beta"}]`
- `CANDIDATE_PROFILE_JSON` — validated candidate profile (see
  `candidate-profile.example.json`; every generated claim traces to this data)

## Production deployment (from a clean checkout)

```sh
bun install

# 1. Create the database and copy the printed database_id into wrangler.jsonc
bunx wrangler d1 create job-maxxing

# 2. Apply migrations
bunx wrangler d1 migrations apply job-maxxing --remote

# 3. Set secrets
for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_ALLOWED_CHAT_ID \
         LLM_API_KEY LLM_MODEL ADMIN_TOKEN SOURCES_JSON CANDIDATE_PROFILE_JSON; do
  bunx wrangler secret put $s
done

# 4. Set APP_BASE_URL / ENVIRONMENT=production in wrangler.jsonc vars, then deploy
bun run deploy

# 5. Register the Telegram webhook
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... APP_BASE_URL=https://<worker>.workers.dev \
  ./scripts/setup-telegram-webhook.sh

# 6. Smoke check
curl https://<worker>.workers.dev/health
curl -X POST https://<worker>.workers.dev/api/admin/test-telegram \
  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST https://<worker>.workers.dev/api/admin/run-daily \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun": true, "limit": 5}'
```

The cron trigger then runs the search daily at 13:00 UTC with no manual
intervention. A failed production run sends a safe Telegram error notice.

## Operations

- **Manual run**: `POST /api/admin/run-daily` (`{"dryRun": false}`). Only one
  non-dry run executes per UTC date (run lock).
- **Cost/usage limits**: scoring only runs on new, filter-eligible jobs; use
  `limit` in dry runs; LLM concurrency is capped at 2; source concurrency at 3.
- **Backup/export**: `bunx wrangler d1 export job-maxxing --remote --output backup.sql`
- **Recovery**: restore with `bunx wrangler d1 execute job-maxxing --remote --file backup.sql`.
  Re-running a day is safe — discovery and digests are idempotent; to force a
  re-run, delete that date's row in `run_locks`.
- **Rollback**: `bunx wrangler rollback` (or redeploy a previous git commit).
- **Logs**: `bunx wrangler tail` — structured JSON with runId/jobId/source,
  never tokens or personal data.

## API

- `GET /health`
- `POST /telegram/webhook` (Telegram only; secret header + chat allowlist)
- `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/shortlist|skip|prepare`
- `GET /api/runs`, `GET /api/runs/:id`
- `POST /api/admin/run-daily` (bearer auth, supports `dryRun`, `sourceNames`, `limit`)
- `POST /api/admin/test-telegram` (bearer auth)

## Notes

- The MVP never submits applications. Preparation distinguishes verified,
  derived, and unknown answers; demographic questions stay unanswered.
- See PLAN.md for the full implementation plan and milestone history.
