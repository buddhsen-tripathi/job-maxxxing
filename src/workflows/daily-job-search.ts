import {
  loadActiveProfiles,
  loadCandidateProfile,
  loadSourcesForIngest,
  parseScoreThresholds,
  parseSecrets,
  parseTelegramSecrets,
  parseVars,
} from "../config";
import { markBoardPolled } from "../db/repositories/boards";
import {
  clipJobDescription,
  getJobByFingerprint,
  getLatestScoreForJob,
  insertJobScore,
  persistDiscoveredJobs,
  setJobStatus,
} from "../db/repositories/jobs";
import { listBlockedCompanyKeys } from "../db/repositories/meta";
import {
  countPendingMatches,
  deletePendingMatches,
  listPendingMatchJobs,
} from "../db/repositories/pending-matches";
import {
  acquireIngestMutex,
  completeRun,
  createRun,
  failRun,
  failStaleRuns,
  releaseIngestMutex,
} from "../db/repositories/runs";
import { userHasSkippedJob } from "../db/repositories/user-jobs";
import type { JobRow } from "../db/schema";
import type { Env } from "../env";
import { discoverFromSources, type SourceFailure } from "../jobs/discover";
import { applyHardFilters } from "../jobs/filters";
import { chooseDigestJobs, type ScoredJob, type ScoreThresholds, scoreJobs } from "../jobs/scoring";
import type { LlmClient } from "../llm/client";
import { createMockLlmClient } from "../llm/mock";
import { createOpenRouterLlmClient } from "../llm/openrouter";
import { chunkArray } from "../shared/array";
import { errorMessage } from "../shared/errors";
import { createLogger, type Logger } from "../shared/logger";
import { createTelegramClient } from "../telegram/client";
import { createTelegramNotifier } from "../telegram/notifier";

/** Boards fetched concurrently before we checkpoint last_polled_at. */
const INGEST_CHUNK_SIZE = 4;
/** Leave headroom under the ~15 minute Worker scheduled limit. */
export const DEFAULT_INGEST_BUDGET_MS = 8 * 60 * 1000;
export const DEFAULT_MATCH_BUDGET_MS = 5 * 60 * 1000;
const LEFTOVER_MATCH_BUDGET_MS = 2 * 60 * 1000;
const RUN_HARD_STOP_MS = 13 * 60 * 1000;
const PENDING_DRAIN_BATCH = 40;

export interface DigestInput {
  runId: string;
  date: Date;
  sourcesChecked: number;
  discoveredCount: number;
  newCount: number;
  eligibleCount: number;
  jobs: ScoredJob[];
}

export interface DigestNotifier {
  sendDailyDigest(input: DigestInput): Promise<void>;
  sendNoMatchesNotice(input: Omit<DigestInput, "jobs">): Promise<void>;
  sendFailureNotification(input: { runId: string; error: string }): Promise<void>;
}

export function createConsoleNotifier(logger: Logger): DigestNotifier {
  return {
    async sendDailyDigest(input) {
      logger.info({
        operation: "digest",
        runId: input.runId,
        status: "digest_ready",
        jobCount: input.jobs.length,
      });
    },
    async sendNoMatchesNotice(input) {
      logger.info({ operation: "digest", runId: input.runId, status: "no_matches" });
    },
    async sendFailureNotification(input) {
      logger.error({
        operation: "digest",
        runId: input.runId,
        status: "run_failed",
        error: input.error,
      });
    },
  };
}

export interface RunSummary {
  runId: string | null;
  status: "completed" | "failed" | "skipped";
  dryRun: boolean;
  discoveredCount: number;
  newCount: number;
  eligibleCount: number;
  shortlistedCount: number;
  scoringFailures: number;
  sourceFailures: SourceFailure[];
  boardsPolled?: number;
  usersNotified?: number;
  filterRejects?: Record<string, number>;
  pendingRemaining?: number;
  error?: string;
}

export interface DailyRunOptions {
  triggerType?: string;
  dryRun?: boolean;
  sourceNames?: string[];
  limit?: number;
  now?: Date;
  fetchImpl?: typeof globalThis.fetch;
  llmClient?: LlmClient;
  notifier?: DigestNotifier;
  thresholds?: ScoreThresholds;
  /** Force SOURCES_JSON instead of D1 catalog (tests). */
  preferEnvSources?: boolean;
  standardBatchSize?: number;
  batchSize?: number;
  priorityCap?: number;
  /** Wall-clock budget for board polling. 0 skips ingest. */
  ingestBudgetMs?: number;
  /** Wall-clock budget for filter/score/notify of pending matches. */
  matchBudgetMs?: number;
}

function resolveLlmClient(env: Env, override: LlmClient | undefined, logger: Logger): LlmClient {
  if (override) return override;
  try {
    const secrets = parseSecrets(env);
    return createOpenRouterLlmClient({
      apiKey: secrets.OPENROUTER_API_KEY,
      model: secrets.OPENROUTER_MODEL,
      siteUrl: env.APP_BASE_URL,
      siteName: "job-maxxing",
    });
  } catch {
    logger.warn({
      operation: "daily_job_search",
      status: "llm_fallback",
      message: "LLM secrets missing; falling back to deterministic mock scorer.",
    });
    return createMockLlmClient();
  }
}

function resolveNotifier(
  env: Env,
  override: DigestNotifier | undefined,
  logger: Logger,
  chatIdOverride?: string | null,
): DigestNotifier {
  if (override) return override;
  try {
    const secrets = parseTelegramSecrets(env);
    const chatId = chatIdOverride || secrets.TELEGRAM_ALLOWED_CHAT_ID;
    if (!chatId) {
      throw new Error("no_telegram_chat");
    }
    return createTelegramNotifier({
      client: createTelegramClient({ token: secrets.TELEGRAM_BOT_TOKEN }),
      chatId,
      db: env.DB,
    });
  } catch {
    logger.warn({
      operation: "daily_job_search",
      status: "notifier_fallback",
      message: "Telegram secrets missing; digest will be logged instead.",
    });
    return createConsoleNotifier(logger);
  }
}

function jobToRow(
  job: {
    fingerprint: string;
    source: string;
    sourceJobId?: string;
    company: string;
    title: string;
    location?: string;
    employmentType?: string;
    workplaceType: string;
    description: string;
    applyUrl: string;
    canonicalUrl: string;
    salary?: { min?: number; max?: number; currency?: string };
    postedAt?: string;
    discoveredAt: string;
    rawPayload?: unknown;
  },
  id: string,
): JobRow {
  return {
    id,
    fingerprint: job.fingerprint,
    source: job.source,
    source_job_id: job.sourceJobId ?? null,
    company: job.company,
    title: job.title,
    location: job.location ?? null,
    employment_type: job.employmentType ?? null,
    workplace_type: job.workplaceType,
    description: clipJobDescription(job.description),
    apply_url: job.applyUrl,
    canonical_url: job.canonicalUrl,
    salary_min: job.salary?.min ?? null,
    salary_max: job.salary?.max ?? null,
    salary_currency: job.salary?.currency ?? null,
    posted_at: job.postedAt ?? null,
    discovered_at: job.discoveredAt,
    last_seen_at: job.discoveredAt,
    raw_payload: null,
    status: "discovered",
  };
}

export interface BoardIngestResult {
  sourcesChecked: number;
  discoveredCount: number;
  newJobs: JobRow[];
  sourceFailures: SourceFailure[];
  boardIds: string[];
  fromCatalog: boolean;
}

/**
 * Poll a shard of ATS boards in small concurrent chunks. Each chunk is
 * checkpointed (`last_polled_at`) so a killed tick does not redo finished boards.
 * New fingerprints are queued on `pending_matches` for a separate drain.
 */
export async function runBoardIngest(
  env: Env,
  options: DailyRunOptions & {
    logger: Logger;
    now: Date;
    preferences: import("../candidate/preferences").SearchPreferences;
    ingestDeadlineMs: number;
  },
): Promise<BoardIngestResult> {
  const loaded = await loadSourcesForIngest(env, {
    preferEnvSources: options.preferEnvSources === true,
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.priorityCap !== undefined ? { priorityCap: options.priorityCap } : {}),
    ...(options.standardBatchSize !== undefined
      ? { standardBatchSize: options.standardBatchSize }
      : {}),
    ...(options.sourceNames ? { sourceNames: options.sourceNames } : {}),
  });

  const pairs = loaded.entries.map((entry, index) => ({
    entry,
    boardId: loaded.boards[index]?.id,
  }));

  const newJobs: JobRow[] = [];
  const sourceFailures: SourceFailure[] = [];
  let discoveredCount = 0;
  let sourcesChecked = 0;
  let budgetHit = false;

  for (const chunk of chunkArray(pairs, INGEST_CHUNK_SIZE)) {
    if (Date.now() >= options.ingestDeadlineMs) {
      budgetHit = true;
      break;
    }

    const discovery = await discoverFromSources(
      chunk.map((pair) => pair.entry),
      {
        now: options.now,
        preferences: options.preferences,
        fetch: options.fetchImpl ?? globalThis.fetch,
        logger: options.logger,
      },
      { ...(options.limit !== undefined ? { limit: options.limit } : {}) },
    );
    sourcesChecked += chunk.length;
    discoveredCount += discovery.discoveredCount;
    sourceFailures.push(...discovery.failures);

    if (options.dryRun) {
      for (const job of discovery.jobs) {
        const existing = await getJobByFingerprint(env.DB, job.fingerprint);
        if (existing) continue;
        newJobs.push(jobToRow(job, `dry-${job.fingerprint}`));
      }
      continue;
    }

    const persisted = await persistDiscoveredJobs(
      env.DB,
      discovery.jobs.map((job) => ({
        fingerprint: job.fingerprint,
        source: job.source,
        sourceJobId: job.sourceJobId ?? null,
        company: job.company,
        title: job.title,
        location: job.location ?? null,
        employmentType: job.employmentType ?? null,
        workplaceType: job.workplaceType,
        description: job.description,
        applyUrl: job.applyUrl,
        canonicalUrl: job.canonicalUrl,
        salaryMin: job.salary?.min ?? null,
        salaryMax: job.salary?.max ?? null,
        salaryCurrency: job.salary?.currency ?? null,
        postedAt: job.postedAt ?? null,
        now: options.now,
      })),
    );
    newJobs.push(...persisted.newJobs);

    if (loaded.fromCatalog) {
      const failureByCompany = new Map(
        discovery.failures.map((failure) => [
          `${failure.source}:${failure.company}`,
          failure.error,
        ]),
      );
      for (const pair of chunk) {
        if (!pair.boardId) continue;
        const fail = failureByCompany.get(`${pair.entry.source}:${pair.entry.company}`);
        await markBoardPolled(
          env.DB,
          pair.boardId,
          fail ? `error:${fail.slice(0, 120)}` : "ok",
          options.now,
        );
      }
    }
  }

  if (budgetHit) {
    options.logger.info({
      operation: "board_ingest",
      status: "ingest_budget_hit",
      sourcesChecked,
      remaining: pairs.length - sourcesChecked,
    });
  }

  return {
    sourcesChecked,
    discoveredCount,
    newJobs,
    sourceFailures,
    boardIds: loaded.boards.map((board) => board.id),
    fromCatalog: loaded.fromCatalog,
  };
}

export interface UserMatchResult {
  userId: string;
  eligibleCount: number;
  shortlistedCount: number;
  scoringFailures: number;
  filterRejects?: Record<string, number>;
}

/**
 * Hard-filter + LLM-score new jobs for one user and send a Telegram digest when matches exist.
 */
export async function runUserMatchAndNotify(
  env: Env,
  options: {
    userId: string;
    profile: import("../candidate/profile").CandidateProfile;
    telegramChatId?: string | null;
    newJobs: JobRow[];
    runId: string;
    now: Date;
    dryRun: boolean;
    sourcesChecked: number;
    discoveredCount: number;
    logger: Logger;
    llmClient?: LlmClient;
    notifier?: DigestNotifier;
    thresholds?: ScoreThresholds;
    /** When false, skip the empty-digest Telegram notice (caller may send one later). */
    sendNoMatches?: boolean;
  },
): Promise<UserMatchResult> {
  const llm = resolveLlmClient(env, options.llmClient, options.logger);
  const notifier = resolveNotifier(env, options.notifier, options.logger, options.telegramChatId);
  const thresholds = options.thresholds ?? parseScoreThresholds(env);
  const blockedCompanies = await listBlockedCompanyKeys(env.DB);
  const eligible: JobRow[] = [];
  const filterRejects: Record<string, number> = {};
  /** Cap LLM calls per user per tick to control OpenRouter spend for public bots. */
  const scoreCap = Math.max(1, Number(env.SCORE_CAP_PER_USER ?? "20") || 20);

  for (const row of options.newJobs) {
    if (!options.dryRun) {
      const alreadyScored = await getLatestScoreForJob(env.DB, row.id, options.userId);
      if (alreadyScored) continue;
    }
    const previouslySkipped = options.dryRun
      ? false
      : await userHasSkippedJob(env.DB, options.userId, row.id);
    // Applications are per-user; do not treat another user's prepare as applied.
    const filter = applyHardFilters(row, {
      preferences: options.profile.preferences,
      profile: options.profile,
      blockedCompanies,
      hasApplied: false,
      previouslySkipped,
    });

    if (!options.dryRun) {
      await setJobStatus(env.DB, row.id, filter.eligible ? "eligible" : "rejected_by_filter");
    }

    if (filter.eligible) {
      eligible.push(row);
    } else {
      filterRejects[filter.reasonCode] = (filterRejects[filter.reasonCode] ?? 0) + 1;
    }
  }

  const toScore = eligible.slice(0, scoreCap);
  const scoring = await scoreJobs(toScore, { client: llm, profile: options.profile, thresholds });

  if (!options.dryRun) {
    for (const failure of scoring.failures) {
      await setJobStatus(env.DB, failure.jobId, "scoring_failed");
    }
    for (const { job, score } of scoring.scored) {
      await insertJobScore(env.DB, {
        jobId: job.id,
        userId: options.userId,
        model: llm.model,
        totalScore: score.totalScore,
        technicalScore: score.technicalScore,
        experienceScore: score.experienceScore,
        domainScore: score.domainScore,
        locationScore: score.locationScore,
        evidenceScore: score.evidenceScore,
        recommendation: score.recommendation,
        reasonsJson: JSON.stringify(score.reasons),
        risksJson: JSON.stringify(score.risks),
        evidenceJson: JSON.stringify(score.evidence),
        now: options.now,
      });
      await setJobStatus(env.DB, job.id, "scored");
    }
  }

  const digestJobs = chooseDigestJobs(scoring.scored, thresholds, {
    preferUsBased: options.profile.preferences.preferUsBased,
  });

  if (!options.dryRun) {
    const digestBase = {
      runId: options.runId,
      date: options.now,
      sourcesChecked: options.sourcesChecked,
      discoveredCount: options.discoveredCount,
      newCount: options.newJobs.length,
      eligibleCount: eligible.length,
    };
    if (digestJobs.length > 0) {
      await notifier.sendDailyDigest({ ...digestBase, jobs: digestJobs });
    } else if (options.sendNoMatches !== false) {
      await notifier.sendNoMatchesNotice(digestBase);
    }
  }

  return {
    userId: options.userId,
    eligibleCount: eligible.length,
    shortlistedCount: digestJobs.length,
    scoringFailures: scoring.failures.length,
    filterRejects,
  };
}

/**
 * Filter/score a slice of pending_matches for every active user, then drop those
 * jobs from the queue so a killed tick can retry whatever is left.
 */
async function drainPendingMatches(
  env: Env,
  options: {
    users: Awaited<ReturnType<typeof loadActiveProfiles>>;
    runId: string;
    now: Date;
    sourcesChecked: number;
    discoveredCount: number;
    logger: Logger;
    llmClient?: LlmClient;
    notifier?: DigestNotifier;
    thresholds?: ScoreThresholds;
    matchDeadlineMs: number;
  },
): Promise<{
  eligibleCount: number;
  shortlistedCount: number;
  scoringFailures: number;
  filterRejects?: Record<string, number>;
}> {
  let eligibleCount = 0;
  let shortlistedCount = 0;
  let scoringFailures = 0;
  let filterRejects: Record<string, number> | undefined;

  if (options.users.length === 0) {
    return { eligibleCount, shortlistedCount, scoringFailures };
  }

  while (Date.now() < options.matchDeadlineMs) {
    const batch = await listPendingMatchJobs(env.DB, PENDING_DRAIN_BATCH);
    if (batch.length === 0) break;

    for (const { user, profile } of options.users) {
      const match = await runUserMatchAndNotify(env, {
        userId: user.id,
        profile,
        telegramChatId: user.telegram_chat_id,
        newJobs: batch,
        runId: options.runId,
        now: options.now,
        dryRun: false,
        sourcesChecked: options.sourcesChecked,
        discoveredCount: options.discoveredCount,
        logger: options.logger,
        sendNoMatches: false,
        ...(options.llmClient ? { llmClient: options.llmClient } : {}),
        ...(options.notifier ? { notifier: options.notifier } : {}),
        ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      });
      eligibleCount += match.eligibleCount;
      shortlistedCount += match.shortlistedCount;
      scoringFailures += match.scoringFailures;
      if (match.filterRejects) filterRejects = match.filterRejects;
    }

    await deletePendingMatches(
      env.DB,
      batch.map((job) => job.id),
    );
  }

  return {
    eligibleCount,
    shortlistedCount,
    scoringFailures,
    ...(filterRejects ? { filterRejects } : {}),
  };
}

/**
 * Orchestrates board ingest + per-user match/notify for one cron/manual tick.
 * Work is split: leftover pending matches first, then a time-boxed ingest,
 * then another drain. A killed tick leaves checkpoints (`last_polled_at`)
 * and queued jobs for the next 15-minute cron.
 */
export async function runDailyJobSearch(
  env: Env,
  options: DailyRunOptions = {},
): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const logger = createLogger({ operation: "daily_job_search" });
  const notifier = resolveNotifier(env, options.notifier, logger);

  const emptySummary: RunSummary = {
    runId: null,
    status: "skipped",
    dryRun,
    discoveredCount: 0,
    newCount: 0,
    eligibleCount: 0,
    shortlistedCount: 0,
    scoringFailures: 0,
    sourceFailures: [],
    boardsPolled: 0,
    usersNotified: 0,
  };

  if (!dryRun) {
    await failStaleRuns(env.DB, now);
    const locked = await acquireIngestMutex(env.DB);
    if (!locked) {
      logger.warn({
        operation: "daily_job_search",
        status: "skipped",
        reason: "ingest_mutex_held",
      });
      return { ...emptySummary, status: "skipped" };
    }
  }

  const run = await createRun(env.DB, {
    triggerType: dryRun ? "dry_run" : (options.triggerType ?? "cron"),
    now,
  });
  const runLogger = logger.child({ runId: run.id });
  const summary: RunSummary = { ...emptySummary, runId: run.id, status: "completed" };
  const startedMs = Date.now();
  const hardStopMs = startedMs + RUN_HARD_STOP_MS;
  const ingestBudgetMs = options.ingestBudgetMs ?? DEFAULT_INGEST_BUDGET_MS;
  const matchBudgetMs = options.matchBudgetMs ?? DEFAULT_MATCH_BUDGET_MS;

  try {
    const seedProfile = await loadCandidateProfile(env);
    const users = await loadActiveProfiles(env);
    summary.usersNotified = users.length;

    let totalEligible = 0;
    let totalShortlisted = 0;
    let totalScoringFailures = 0;
    let filterRejects: Record<string, number> | undefined;
    let fromCatalog = false;

    if (!dryRun && users.length > 0) {
      const leftover = await drainPendingMatches(env, {
        users,
        runId: run.id,
        now,
        sourcesChecked: 0,
        discoveredCount: 0,
        logger: runLogger,
        matchDeadlineMs: Math.min(Date.now() + LEFTOVER_MATCH_BUDGET_MS, hardStopMs),
        ...(options.llmClient ? { llmClient: options.llmClient } : {}),
        ...(options.notifier ? { notifier: options.notifier } : {}),
        ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      });
      totalEligible += leftover.eligibleCount;
      totalShortlisted += leftover.shortlistedCount;
      totalScoringFailures += leftover.scoringFailures;
      if (leftover.filterRejects) filterRejects = leftover.filterRejects;
    }

    const ingest = await runBoardIngest(env, {
      ...options,
      dryRun,
      now,
      logger: runLogger,
      preferences: seedProfile.preferences,
      ingestDeadlineMs: Math.min(Date.now() + ingestBudgetMs, hardStopMs),
    });
    fromCatalog = ingest.fromCatalog;
    summary.discoveredCount = ingest.discoveredCount;
    summary.newCount = ingest.newJobs.length;
    summary.sourceFailures = ingest.sourceFailures;
    summary.boardsPolled = ingest.sourcesChecked;

    if (dryRun) {
      for (const { user, profile } of users) {
        const match = await runUserMatchAndNotify(env, {
          userId: user.id,
          profile,
          telegramChatId: user.telegram_chat_id,
          newJobs: ingest.newJobs,
          runId: run.id,
          now,
          dryRun: true,
          sourcesChecked: ingest.sourcesChecked,
          discoveredCount: ingest.discoveredCount,
          logger: runLogger,
          ...(options.llmClient ? { llmClient: options.llmClient } : {}),
          ...(options.notifier ? { notifier: options.notifier } : {}),
          ...(options.thresholds ? { thresholds: options.thresholds } : {}),
        });
        totalEligible += match.eligibleCount;
        totalShortlisted += match.shortlistedCount;
        totalScoringFailures += match.scoringFailures;
        if (match.filterRejects) filterRejects = match.filterRejects;
      }
    } else if (users.length > 0) {
      const drained = await drainPendingMatches(env, {
        users,
        runId: run.id,
        now,
        sourcesChecked: ingest.sourcesChecked,
        discoveredCount: ingest.discoveredCount,
        logger: runLogger,
        matchDeadlineMs: Math.min(Date.now() + matchBudgetMs, hardStopMs),
        ...(options.llmClient ? { llmClient: options.llmClient } : {}),
        ...(options.notifier ? { notifier: options.notifier } : {}),
        ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      });
      totalEligible += drained.eligibleCount;
      totalShortlisted += drained.shortlistedCount;
      totalScoringFailures += drained.scoringFailures;
      if (drained.filterRejects) filterRejects = drained.filterRejects;

      if (totalShortlisted === 0) {
        for (const { user } of users) {
          const userNotifier = resolveNotifier(
            env,
            options.notifier,
            runLogger,
            user.telegram_chat_id,
          );
          await userNotifier.sendNoMatchesNotice({
            runId: run.id,
            date: now,
            sourcesChecked: ingest.sourcesChecked,
            discoveredCount: ingest.discoveredCount,
            newCount: ingest.newJobs.length,
            eligibleCount: totalEligible,
          });
        }
      }
    }

    summary.eligibleCount = totalEligible;
    summary.shortlistedCount = totalShortlisted;
    summary.scoringFailures = totalScoringFailures;
    if (dryRun && filterRejects) summary.filterRejects = filterRejects;
    if (!dryRun) {
      summary.pendingRemaining = await countPendingMatches(env.DB);
    }

    if (dryRun) {
      runLogger.info({
        operation: "daily_job_search",
        status: "dry_run_filters",
        filterRejects: summary.filterRejects,
        eligibleCount: summary.eligibleCount,
      });
    }

    await completeRun(env.DB, run.id, {
      discoveredCount: summary.discoveredCount,
      newCount: summary.newCount,
      eligibleCount: summary.eligibleCount,
      shortlistedCount: summary.shortlistedCount,
    });
    runLogger.info({
      operation: "daily_job_search",
      status: "completed",
      dryRun,
      discoveredCount: summary.discoveredCount,
      newCount: summary.newCount,
      eligibleCount: summary.eligibleCount,
      shortlistedCount: summary.shortlistedCount,
      scoringFailures: summary.scoringFailures,
      sourceFailures: summary.sourceFailures.length,
      boardsPolled: summary.boardsPolled,
      usersNotified: summary.usersNotified,
      pendingRemaining: summary.pendingRemaining,
      fromCatalog,
    });
    return summary;
  } catch (error) {
    const message = errorMessage(error);
    summary.status = "failed";
    summary.error = message;
    await failRun(env.DB, run.id, message);
    runLogger.error({ operation: "daily_job_search", status: "failed", error: message });
    if (!dryRun && parseVars(env).ENVIRONMENT === "production") {
      await notifier.sendFailureNotification({
        runId: run.id,
        error: "Daily run failed; check logs.",
      });
    }
    return summary;
  } finally {
    if (!dryRun) {
      await releaseIngestMutex(env.DB);
    }
  }
}
