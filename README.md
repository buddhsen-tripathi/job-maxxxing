# job-maxxing

Personal job-search agent on Cloudflare Workers. Polls public ATS boards
(Greenhouse, Lever, Ashby, Workday), upserts new roles into D1, hard-filters and
LLM-scores them against each user’s candidate profile, and sends a Telegram digest
every **3 hours**. Anyone can DM the bot, upload a resume URL (or PDF), set
preferences, and receive matches. Applications can be **prepared** for review but
are **never auto-submitted**.

## How it works

```text
Cron (0 */3 * * *)
  → ingest shard of ats_boards (priority reserve + stale standard fill)
  → upsert jobs by fingerprint (only new jobs continue)
  → hard filters (location, YOE, title, employment type, …)
  → OpenRouter LLM score
  → Telegram digest per active user for matches ≥ review threshold
```

Anyone who DMs the bot can onboard: send a **public resume URL** (PDF/text/HTML)
or upload a **PDF**, answer preference prompts, then receive digests. Use **Save** /
Skip / Review / Prepare on cards. `/saved` lists your saved jobs with apply links.

## Stack

- Cloudflare Workers + Hono + TypeScript (strict), Bun
- D1 (SQLite), cron `0 */3 * * *` (8 runs/day UTC)
- Telegram Bot API (webhook + slash commands)
- LLM scoring via [OpenRouter](https://openrouter.ai/)
- Vitest (`@cloudflare/vitest-pool-workers`), Biome, Wrangler

## Local setup

```sh
bun install
cp .dev.vars.example .dev.vars   # fill in values; never commit
bunx wrangler d1 migrations apply job-maxxing --local
bun run dev                      # http://localhost:8787
```

## Commands

```sh
bun run dev          # local worker
bun run test         # unit + integration + e2e
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
bun run deploy       # wrangler deploy
bun run import:ats -- --remote   # bulk-import ~9.9k ATS boards into D1
```

## Configuration

### Secrets

Set with `bunx wrangler secret put <NAME>` in production, or `.dev.vars` locally:

| Name | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random string; verified on every webhook call |
| `TELEGRAM_ALLOWED_CHAT_ID` | Optional operator chat id (binds to user `default`; used for admin Telegram ping) |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | Model id (e.g. `deepseek/deepseek-v4-flash-0731`) |
| `ADMIN_TOKEN` | Bearer token for `/api/admin/*` |

### Wrangler vars (non-secret)

| Name | Default | Purpose |
| --- | --- | --- |
| `ENVIRONMENT` | — | `development` or `production` |
| `APP_BASE_URL` | — | Public worker URL (webhook + OpenRouter headers) |
| `BOARD_INGEST_BATCH_SIZE` | `48` | Boards polled per cron tick |
| `BOARD_PRIORITY_CAP` | `16` | Max priority boards reserved each tick |
| `SCORE_STRONG_MATCH_THRESHOLD` | `85` | Score for “strong match” |
| `SCORE_REVIEW_THRESHOLD` | `60` | Minimum score to appear in the digest |
| `SCORE_CAP_PER_USER` | `20` | Max LLM-scored jobs per user per cron tick |

US-based roles are prioritized when `preferUsBased` is set on the candidate
profile (scoring prompt + digest sort).

`SOURCES_JSON` is an optional **fallback** when `ats_boards` is empty
(tests/local). Prefer the D1 catalog in production. See `sources.example.json`.

### Candidate profile

Each Telegram user maps to a D1 `users` row (`tg:<chat_id>`, or `default` for the
optional operator chat). Profiles live in `user_profiles`. New users stay inactive
until onboarding finishes (`/start` → resume → preferences).

The seeded `default` user can still be hydrated from `app_config.candidate_profile`
or `CANDIDATE_PROFILE_JSON` for local/ops use. Profile JSON is too large for
Wrangler secrets (~5KB cap) — keep it in D1.

## Board catalog

Discovery sources live in D1 `ats_boards` (`greenhouse` | `lever` | `ashby` |
`workday`).

- Migrations seed a small **priority** set of well-known companies.
- Production typically also imports the open
  [LastRound ATS directory](https://github.com/fyrosofttech/lastroundai-hiring-data)
  (~9.9k Greenhouse / Lever / Ashby boards, CC BY 4.0):

```sh
bun scripts/import-ats-directory.ts --remote
```

Import upserts rows as `tier=standard` while **preserving** existing `priority`
and manually deactivated boards.

### Polling shard (each cron tick)

1. Take up to `BOARD_PRIORITY_CAP` least-recently-polled **priority** boards
2. Fill remaining `BOARD_INGEST_BATCH_SIZE` slots with least-recent **active**
   boards (mostly standard)
3. Upsert jobs; only **new fingerprints** go to filter → score → notify
4. Notify each active `users` / `user_profiles` row

At 8 ticks/day × ~32 standard slots ≈ **250 boards/day** → a 10k catalog rotates
in roughly **5–6 weeks**. Promote high-yield boards to `priority`.

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

Workday boards use slug form `host/tenant/site` (see migration `0006`).

## Telegram

Register webhook + command menu after deploy:

```sh
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
  APP_BASE_URL=https://<worker>.workers.dev \
  ./scripts/setup-telegram-webhook.sh
```

Slash commands (also in the bot menu):

| Command | What it does |
| --- | --- |
| `/saved` | List saved jobs with clickable apply links |
| `/skipped` | List skipped jobs with apply links |
| `/pause` | Halt job digests; profile and saved jobs are kept |
| `/resume` | Turn digests back on |
| `/help` | Show how to use the bot |

Digest / review buttons: **Save**, Skip, Review, Prepare, Open listing.
Save bookmarks a role; Prepare drafts answers — nothing is auto-submitted.

## Production deployment

```sh
bun install

# 1. Create DB; put database_id in wrangler.jsonc
bunx wrangler d1 create job-maxxing

# 2. Apply migrations
bunx wrangler d1 migrations apply job-maxxing --remote

# 3. Secrets
for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_ALLOWED_CHAT_ID \
         OPENROUTER_API_KEY OPENROUTER_MODEL ADMIN_TOKEN; do
  bunx wrangler secret put $s
done

# 4. Candidate profile in D1 (not a Wrangler secret)
bunx wrangler d1 execute job-maxxing --remote --command \
  "INSERT INTO app_config (key, value_json, updated_at) VALUES ('candidate_profile', '$(jq -c . candidate-profile.json)', datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at"

# 5. Optional: full ATS directory (~10k boards)
bun scripts/import-ats-directory.ts --remote

# 6. Deploy — set APP_BASE_URL outside git (Dashboard or secret), not in wrangler.jsonc
#    echo 'https://YOUR_SUBDOMAIN.workers.dev' | bunx wrangler secret put APP_BASE_URL
bun run deploy

# 7. Telegram webhook + command menu
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... APP_BASE_URL=https://<worker>.workers.dev \
  ./scripts/setup-telegram-webhook.sh

# 8. Smoke
curl https://<worker>.workers.dev/health
curl -X POST https://<worker>.workers.dev/api/admin/test-telegram \
  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST https://<worker>.workers.dev/api/admin/run-daily \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun": true, "limit": 5}'
```

Failed production runs send a safe Telegram error notice.

## Operations

- **Manual run**: `POST /api/admin/run-daily` (`{"dryRun": false}`). Default
  response is `202` (background). Pass `"sync": true` to wait for the summary.
  Only one non-dry run per **3-hour UTC slot** (`run_locks`). To force a re-run
  in the same slot, delete that slot’s row from `run_locks`.
- **Check runs**: `GET /api/runs`
- **Saved jobs**: Telegram `/saved`, or `GET /api/jobs?status=shortlisted`
- **Upsert board**: `POST /api/admin/boards`
- **Import catalog**: `bun scripts/import-ats-directory.ts --remote`
- **Cost guards**: score only new filter-eligible jobs; title prefilters on
  Greenhouse/Ashby; source concurrency capped
- **Backup**: `bunx wrangler d1 export job-maxxing --remote --output backup.sql`
- **Logs**: `bunx wrangler tail` — structured JSON; no tokens/PII

Common hard-filter rejects (by design): `unsupported_location`,
`experience_exceeds_tolerance`, `excluded_title`, `incompatible_employment_type`.

## API

- `GET /health`
- `POST /telegram/webhook` — secret header + chat allowlist; callbacks + slash commands
- `GET /api/jobs?status=…`, `GET /api/jobs/:id`
- `POST /api/jobs/:id/shortlist|skip|prepare` — `shortlist` is the API name for **Save**
- `GET /api/runs`, `GET /api/runs/:id`
- `POST /api/admin/run-daily` — `dryRun`, `sync`, `sourceNames`, `limit`
- `POST /api/admin/boards` — upsert catalog row (`greenhouse`/`lever`/`ashby`/`workday`)
- `POST /api/admin/test-telegram`

## Notes

- Never auto-submits applications. Prepared answers are marked verified /
  derived / unknown; demographic questions stay unanswered.
- Schema is multi-tenant-ready (`users`, `user_profiles`) with a single default
  operator in production today. Auth/billing UI is out of scope until
  ingest + notify stay stable at catalog scale.

## License

MIT — see [LICENSE](LICENSE).
