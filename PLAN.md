# Job Application Agent — Implementation Plan

## 1. Objective

Build a personal job-search agent that runs once per day, discovers relevant
software-engineering roles, removes duplicates, scores each role against a
verified candidate profile, and sends a concise Telegram digest.

The first version must not submit applications automatically. It prepares
applications and requires explicit approval before any consequential action.

## 2. Product Principles

- Prefer precision over application volume.
- Never invent candidate information.
- Keep a human in the loop before submission.
- Use deterministic filters before an LLM.
- Store evidence for every match score and generated answer.
- Make every daily run idempotent and safe to retry.
- Build ATS-specific adapters instead of one unreliable universal browser agent.
- Respect website terms, rate limits, robots policies, and anti-automation controls.
- Do not attempt to bypass CAPTCHAs or access controls.
- Keep the architecture simple until scale requires additional infrastructure.

## 3. MVP Scope

Included: Worker API, one scheduled run/day, D1, Telegram bot + webhook,
validated candidate profile, configurable preferences, discovery adapters,
normalization, dedup, deterministic filters, LLM scoring, one daily digest,
review/shortlist/skip/block actions, application preparation, audit log,
fixtures, deployment docs.

Excluded: blind auto-submission, CAPTCHA solving, LinkedIn/Indeed scraping,
browser automation, autonomous form answers, demographic auto-responses, email
inbox, web dashboard, multi-user.

## 4. Stack

Cloudflare Workers, TypeScript strict, Hono, pnpm, Cron Trigger, Workflows
(only where waiting/retries help), D1, R2 later, Zod, provider-neutral LLM
interface, Telegram Bot API over fetch, Vitest, Biome, Wrangler. No Queues in
MVP unless a concrete limitation requires them.

## 5. High-Level Flow

Cron → discovery → normalize → fingerprint → dedupe vs D1 → hard filters →
LLM score → persist score+evidence → one Telegram digest → user actions
(Review/Shortlist/Skip/Block) → prepare application on demand → explicit
approval before submission.

## 6. Environment

See `src/env.ts`. Secrets via Wrangler secrets only. Cron `0 13 * * *`
(13:00 UTC = 9:00 AM NY EDT / 8:00 AM EST).

## 7. Candidate Profile Rules

Validated JSON (Zod). Every generated claim traces to a profile field. Unknown
stays unknown. Never infer protected/demographic info. Never auto-answer
self-identification. Never exaggerate years. Never add skills from job
descriptions. Prose may rephrase evidence, not create facts.

## 8. Database

Tables: runs, jobs, job_scores, job_actions, blocked_companies, applications,
telegram_messages, audit_events. Indexes on jobs(status/company/discovered_at/
posted_at), job_scores(job_id/total_score), job_actions(job_id,action),
applications(status), audit_events(entity_type,entity_id).

## 9. Source Adapters

Order: Greenhouse, Lever, Ashby, configured company career pages. Each sets a
descriptive User-Agent, bounded concurrency, timeouts, tolerates non-200,
returns partial results, logs source/company/duration/count, has fixture tests,
prefers public structured endpoints over scraping.

## 10. Fingerprinting / Dedup

fingerprint = sha256(normalized_company + normalized_title + normalized_location
+ canonical_url). Also detect: same source+source_job_id, same canonical_url,
same company + similar title, rediscovery within lookback (updates
last_seen_at only). Daily run must be idempotent; no duplicate digests.

## 11. Hard Filters (deterministic, before LLM)

Blocked company, excluded title/keyword, unsupported location, incompatible
workplace/employment type, authorization/sponsorship mismatch, experience
clearly above tolerance, already applied, previously skipped (unless posting
materially changed), closed/invalid apply URL. Persist filter decisions.

## 12. LLM Scoring

Eligible jobs only. Structured JSON validated by Zod. Components: technical 40,
experience 25, domain 15, location 10, evidence 10; total must equal sum.
Thresholds (configurable): 85+ strong_match, 70–84 review, <70 excluded from
digest. Malformed output → reject, retry once, then scoring_failed and continue.

## 13. Daily Workflow

`runDailyJobSearch()` idempotent; run-level lock/uniqueness per date; bounded
source and LLM concurrency; per-source and per-job error boundaries; counts at
every stage; "no strong matches today" status instead of empty digest.

## 14. Telegram

`POST /telegram/webhook`: validate secret header, allowlist chat ID, reject
unsupported updates, no token logging, idempotent callbacks. One summary
message + paginated job cards. Callback data uses opaque IDs
(`job:review:<jobId>` etc.), validated server-side. Block company requires a
second confirmation.

## 15. Application Preparation

MVP prepares, never submits. Verified/derived/unknown answer confidence labels.
Salary requires explicit config or approval. Work authorization copied only
from verified profile fields. Demographics unanswered. "Why this company?"
drafted but reviewed. No Submit action until a tested ATS adapter exists.

## 16. State Machine

discovered → eligible → scored → shortlisted → preparing → prepared →
awaiting_review → approved → submitting → submitted. Terminal: skipped,
blocked, rejected_by_filter, preparation_failed, submission_blocked,
submission_failed. One central `transitionApplication()`; audit event per
transition.

## 17. API Routes

`GET /health`, `POST /telegram/webhook`, `/api/jobs*` (list/get/shortlist/skip/
prepare), `/api/runs*`, `/api/admin/run-daily` (supports dryRun), `/api/admin/
test-telegram`. Admin endpoints behind bearer token or Cloudflare Access. Dry
run sends no Telegram and mutates no permanent statuses.

## 18. Observability

Structured logs with runId/jobId/source/company/operation/durationMs/status.
Never log tokens, keys, résumé content, phone, email, authorization details,
sensitive answers. Telegram error summary on production failure without
secrets or stack traces.

## 19. Testing

Unit: profile/prefs validation, normalization, fingerprint stability, dedup,
every filter rule, score arithmetic, thresholds, state transitions, callback
parsing/auth, answer confidence. Fixtures: Greenhouse/Lever/Ashby + edge cases.
Integration: migrations, idempotent discovery, source failure isolation, LLM
retry-once, callback status change, unauthorized chat rejection, digest
thresholds, dry-run purity, preparation never fills unknowns. E2E smoke with
local fixtures.

## 20. Security Checklist

Wrangler secrets; webhook secret verified; chat allowlist; admin auth; URL
validation before server-side fetch; bounded redirects/timeouts/response
sizes; schema-validated LLM output; opaque callback IDs; bound SQL params;
clean logs; evidence-linked claims; manual sensitive questions; no CAPTCHA
bypass; rate limits respected.

## 21. Milestones

1. **Bootstrap** — Worker, Hono, TS strict, Wrangler, D1 binding, /health,
   Biome, Vitest, env validation. ✅ Done.
2. **Data Model** — migrations, repositories, profile/prefs schemas, seeds. ✅ Done.
3. **Discovery** — adapter interface, Greenhouse, Lever, fixtures,
   normalization, fingerprinting, dedup. ✅ Done.
4. **Filtering & Scoring** — filter engine, LLM interface + mock + provider,
   structured scoring, evidence verification, thresholds. ✅ Done.
5. **Daily Run** — scheduled handler, run locking, orchestration, partial
   failure, summaries, dry-run endpoint. ✅ Done.
6. **Telegram** — client, secure webhook, digest, inline actions, review/
   shortlist flow, block confirmation, error notifications. ✅ Done.
7. **Application Preparation** — state machine, resume variants, draft
   answers, evidence links, unknown handling, Telegram review. ✅ Done.
8. **Production Hardening** — deploy guide, secrets, webhook setup script,
   prod migrations, logging, retries, cost limits, backup/rollback docs. ✅ Done.

Do not begin a later milestone until the current milestone's acceptance
criteria pass.

## 22. Coding Rules

Strict TS, no `any`, validate external input, small pure functions, dependency
injection for fetch/time/db/Telegram/LLM, adapters isolated from persistence,
versioned prompts, no Telegram rendering mixed with business logic, no
hardcoded personal data, no silent error swallowing, no unnecessary
abstractions, idempotency throughout, UTC internally (NY time only in
user-facing messages), comments only where reasoning is non-obvious.

## 23. Definition of Done

One logical run/day; Greenhouse + Lever discovery; normalization + dedup; hard
filters; evidence-backed scores; Telegram digest; secure actions; application
package with verified/derived/unknown answers; no submission; tests on
critical paths; production docs.
