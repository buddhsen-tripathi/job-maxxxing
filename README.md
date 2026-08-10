# job-maxxing

Personal job-search agent on Cloudflare Workers. Polls public ATS boards
(Greenhouse, Lever, Ashby) every 3 hours, upserts new jobs into D1, scores them
against a verified candidate profile with an LLM, and sends a Telegram digest.
Applications are prepared on demand but **never submitted** — every
consequential action requires explicit human approval.

## Stack

- Cloudflare Workers + Hono + TypeScript (strict), Bun
- D1 (SQLite), Cron Trigger `0 */3 * * *` (every 3 hours UTC, 8 runs/day)
- Telegram Bot API over fetch, LLM scoring via OpenRouter (OpenAI-compatible API)
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
bun run test       # unit + integration + e2e smoke
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
| `TELEGRAM_ALLOWED_CHAT_ID` | Your personal chat ID (allowlist / default user) |
| `OPENROUTER_API_KEY` | [OpenRouter](https://openrouter.ai/keys) API key |
| `OPENROUTER_MODEL` | OpenRouter model id (e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4`) |
| `ADMIN_TOKEN` | Bearer token for `/api/admin/*` |

### Board catalog (production)

Discovery sources live in D1 table `ats_boards` (not Wrangler secrets). Migration
`0005_ats_boards_and_users.sql` seeds a **priority** set of Greenhouse / Lever /
Ashby boards (large tech, AI, fintech, consumer, infra) plus a smaller
**standard** rotation pool.

Each cron tick:

1. Polls **all active `tier=priority` boards**
2. Plus the next N least-recently-polled **standard** boards (`last_polled_at` round-robin)
3. Upserts jobs; only new fingerprints proceed to matching
4. Matches / scores / notifies each active `users` + `user_profiles` row

Add or update a board without redeploying:

```sh
curl -X POST https://<worker>.workers.dev/api/admin/boards \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "ashby",
    "slug": "ramp",
    "companyName": "Ramp",
    "tier": "priority",
    "sector": "fintech"
  }'
```

`SOURCES_JSON` remains a **fallback** for local/tests when `ats_boards` is empty
(see `sources.example.json`). Production should use the D1 catalog.

### Candidate profile

Prefer D1 `user_profiles` for user `default` (multi-tenant-ready). On first run the
worker migrates from `app_config.candidate_profile` or `CANDIDATE_PROFILE_JSON`
into `user_profiles` if needed.

## Production deployment (from a clean checkout)

```sh
bun install

# 1. Create the database and copy the printed database_id into wrangler.jsonc
bunx wrangler d1 create job-maxxing

# 2. Apply migrations (creates schema + seeds ats_boards + default user)
bunx wrangler d1 migrations apply job-maxxing --remote

# 3. Set secrets (SOURCES_JSON optional — prefer D1 catalog)
for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_ALLOWED_CHAT_ID \
         OPENROUTER_API_KEY OPENROUTER_MODEL ADMIN_TOKEN; do
  bunx wrangler secret put $s
done

# 4. Store candidate profile in D1 (secrets are capped ~5KB)
bunx wrangler d1 execute job-maxxing --remote --command \
  "INSERT INTO app_config (key, value_json, updated_at) VALUES ('candidate_profile', '$(jq -c . candidate-profile.json)', datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at"

# 5. Set APP_BASE_URL / ENVIRONMENT=production in wrangler.jsonc vars, then deploy
bun run deploy

# 6. Register the Telegram webhook
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... APP_BASE_URL=https://<worker>.workers.dev \
  ./scripts/setup-telegram-webhook.sh

# 7. Smoke check
curl https://<worker>.workers.dev/health
curl -X POST https://<worker>.workers.dev/api/admin/test-telegram \
  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST https://<worker>.workers.dev/api/admin/run-daily \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun": true, "limit": 5}'
```

The cron trigger then runs ingest + match every 3 hours UTC. A failed production
run sends a safe Telegram error notice.

## Growing coverage (toward consumer scale)

1. Keep adding boards via `POST /api/admin/boards` (or SQL upserts). Prefer public
   ATS JSON APIs only — Greenhouse `boards-api`, Lever `api.lever.co`, Ashby
   `api.ashbyhq.com/posting-api/job-board/{slug}`.
2. Start new companies as `tier=standard`; promote to `priority` when they
   consistently yield eng/AI roles.
3. Import larger community slug lists over time; deactivate dead boards with
   `"active": false`.
4. When one Worker invocation cannot finish the priority set, shard further
   (smaller priority subsets or a Cloudflare Queue of `board.poll` messages).
5. Cost guards already in place: score only new jobs; hard title/YOE/sponsor
   filters before LLM; Greenhouse/Ashby title prefilters cap detail volume.

Phase 1 keeps a single default operator but stores `users` / `user_profiles` so a
second user does not require a schema rewrite. Auth/billing UI is intentionally
out of scope until ingest+notify is stable.

## Operations

- **Manual run**: `POST /api/admin/run-daily` (`{"dryRun": false}`). Returns
  `202` and runs in the background by default; pass `"sync": true` to wait for
  the summary. Only one non-dry run executes per **3-hour UTC slot** (run lock).
- **Upsert board**: `POST /api/admin/boards` (see above).
- **Cost/usage limits**: scoring only runs on new, filter-eligible jobs; use
  `limit` in dry runs; LLM concurrency is capped; source concurrency is low.
- **Backup/export**: `bunx wrangler d1 export job-maxxing --remote --output backup.sql`
- **Recovery**: restore with `bunx wrangler d1 execute job-maxxing --remote --file backup.sql`.
  Re-running a slot is safe — discovery and digests are idempotent; to force a
  re-run, delete that slot's row in `run_locks`.
- **Rollback**: `bunx wrangler rollback` (or redeploy a previous git commit).
- **Logs**: `bunx wrangler tail` — structured JSON with runId/jobId/source,
  never tokens or personal data.

## API

- `GET /health`
- `POST /telegram/webhook` (Telegram only; secret header + chat allowlist)
  - Slash commands: `/shortlists`, `/skipped`, `/help` (also `/start`)
  - Inline buttons on digests: Review / Shortlist / Skip / Prepare / Open
- `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/shortlist|skip|prepare`
- `GET /api/runs`, `GET /api/runs/:id`
- `POST /api/admin/run-daily` (bearer auth, supports `dryRun`, `sourceNames`, `limit`)
- `POST /api/admin/boards` (bearer auth, upsert ATS board catalog row)
- `POST /api/admin/test-telegram` (bearer auth)

## Notes

- The MVP never submits applications. Preparation distinguishes verified,
  derived, and unknown answers; demographic questions stay unanswered.
