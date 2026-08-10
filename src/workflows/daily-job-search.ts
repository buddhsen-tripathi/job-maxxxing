import {
  loadActiveProfiles,
  loadCandidateProfile,
  loadSourcesForIngest,
  parseScoreThresholds,
  parseSecrets,
  parseTelegramSecrets,
  parseVars,
} from "../config";
import { getApplicationByJobId } from "../db/repositories/applications";
import { markBoardPolled, selectBoardsForIngest } from "../db/repositories/boards";
import {
  getJobByFingerprint,
  insertJobAction,
  insertJobScore,
  listActionsForJob,
  setJobStatus,
  upsertDiscoveredJob,
} from "../db/repositories/jobs";
import { listBlockedCompanyKeys } from "../db/repositories/meta";
import { completeRun, createRun, failRun } from "../db/repositories/runs";
import type { AtsBoardRow, JobRow } from "../db/schema";
import type { Env } from "../env";
import { discoverFromSources, type SourceFailure } from "../jobs/discover";
import { applyHardFilters } from "../jobs/filters";
import { chooseDigestJobs, type ScoredJob, type ScoreThresholds, scoreJobs } from "../jobs/scoring";
import type { LlmClient } from "../llm/client";
import { createMockLlmClient } from "../llm/mock";
import { createOpenRouterLlmClient } from "../llm/openrouter";
import { errorMessage } from "../shared/errors";
import { createLogger, type Logger } from "../shared/logger";
import { utcThreeHourSlotKey } from "../shared/time";
import type { SourceEntry } from "../sources/source-adapter";
import { createTelegramClient } from "../telegram/client";
import { createTelegramNotifier } from "../telegram/notifier";

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
}

async function acquireRunLock(db: D1Database, slotKey: string, runId: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO run_locks (date, run_id, created_at) VALUES (?, ?, ?)")
    .bind(slotKey, runId, new Date().toISOString())
    .run();
  return result.meta.changes === 1;
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
    return createTelegramNotifier({
      client: createTelegramClient({ token: secrets.TELEGRAM_BOT_TOKEN }),
      chatId: chatIdOverride || secrets.TELEGRAM_ALLOWED_CHAT_ID,
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
    description: job.description,
    apply_url: job.applyUrl,
    canonical_url: job.canonicalUrl,
    salary_min: job.salary?.min ?? null,
    salary_max: job.salary?.max ?? null,
    salary_currency: job.salary?.currency ?? null,
    posted_at: job.postedAt ?? null,
    discovered_at: job.discoveredAt,
    last_seen_at: job.discoveredAt,
    raw_payload: job.rawPayload === undefined ? null : JSON.stringify(job.rawPayload),
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
 * Poll a shard of ATS boards and upsert jobs. Only newly fingerprinted jobs are returned.
 */
export async function runBoardIngest(
  env: Env,
  options: DailyRunOptions & {
    logger: Logger;
    now: Date;
    preferences: import("../candidate/preferences").SearchPreferences;
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

  // Pair board ids with entries when using catalog so we can mark poll status.
  let boardsByCompany = new Map<string, AtsBoardRow>();
  if (loaded.fromCatalog) {
    const boards = await selectBoardsForIngest(env.DB, {
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      ...(options.priorityCap !== undefined ? { priorityCap: options.priorityCap } : {}),
      ...(options.standardBatchSize !== undefined
        ? { standardBatchSize: options.standardBatchSize }
        : {}),
    });
    boardsByCompany = new Map(boards.map((b) => [`${b.provider}:${b.slug}`, b]));
  }

  const discovery = await discoverFromSources(
    loaded.entries,
    {
      now: options.now,
      preferences: options.preferences,
      fetch: options.fetchImpl ?? globalThis.fetch,
      logger: options.logger,
    },
    { ...(options.limit !== undefined ? { limit: options.limit } : {}) },
  );

  if (loaded.fromCatalog && !options.dryRun) {
    const failureByCompany = new Map(
      discovery.failures.map((f) => [`${f.source}:${f.company}`, f.error]),
    );
    for (const entry of loaded.entries) {
      const key = sourceEntryKey(entry);
      const board = boardsByCompany.get(key);
      if (!board) continue;
      const fail = failureByCompany.get(`${entry.source}:${entry.company}`);
      await markBoardPolled(
        env.DB,
        board.id,
        fail ? `error:${fail.slice(0, 120)}` : "ok",
        options.now,
      );
    }
  }

  const newJobs: JobRow[] = [];
  if (options.dryRun) {
    for (const job of discovery.jobs) {
      const existing = await getJobByFingerprint(env.DB, job.fingerprint);
      if (existing) continue;
      newJobs.push(jobToRow(job, `dry-${job.fingerprint}`));
    }
  } else {
    for (const job of discovery.jobs) {
      const { job: row, isNew } = await upsertDiscoveredJob(env.DB, {
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
        rawPayload: job.rawPayload === undefined ? null : JSON.stringify(job.rawPayload),
        now: options.now,
      });
      if (isNew) newJobs.push(row);
    }
  }

  return {
    sourcesChecked: loaded.entries.length,
    discoveredCount: discovery.discoveredCount,
    newJobs,
    sourceFailures: discovery.failures,
    boardIds: loaded.boardIds,
    fromCatalog: loaded.fromCatalog,
  };
}

function sourceEntryKey(entry: SourceEntry): string {
  switch (entry.source) {
    case "greenhouse":
      return `greenhouse:${entry.boardToken}`;
    case "lever":
      return `lever:${entry.account}`;
    case "ashby":
      return `ashby:${entry.boardSlug}`;
    case "workday":
      return `workday:${entry.host}/${entry.tenant}/${entry.site}`;
  }
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
  },
): Promise<UserMatchResult> {
  const llm = resolveLlmClient(env, options.llmClient, options.logger);
  const notifier = resolveNotifier(env, options.notifier, options.logger, options.telegramChatId);
  const thresholds = options.thresholds ?? parseScoreThresholds(env);
  const blockedCompanies = await listBlockedCompanyKeys(env.DB);
  const eligible: JobRow[] = [];
  const filterRejects: Record<string, number> = {};

  for (const row of options.newJobs) {
    const application = options.dryRun ? null : await getApplicationByJobId(env.DB, row.id);
    const skips = options.dryRun ? [] : await listActionsForJob(env.DB, row.id, "skip");
    const filter = applyHardFilters(row, {
      preferences: options.profile.preferences,
      profile: options.profile,
      blockedCompanies,
      hasApplied: application !== null,
      previouslySkipped: skips.length > 0,
    });

    if (!options.dryRun) {
      await insertJobAction(env.DB, {
        jobId: row.id,
        action: filter.eligible ? "filter_passed" : "filter_rejected",
        source: "system",
        metadataJson: JSON.stringify(
          filter.eligible
            ? { warnings: filter.warnings, userId: options.userId }
            : {
                reasonCode: filter.reasonCode,
                explanation: filter.explanation,
                userId: options.userId,
              },
        ),
        now: options.now,
      });
      await setJobStatus(env.DB, row.id, filter.eligible ? "eligible" : "rejected_by_filter");
    }

    if (filter.eligible) {
      eligible.push(row);
    } else {
      filterRejects[filter.reasonCode] = (filterRejects[filter.reasonCode] ?? 0) + 1;
    }
  }

  const scoring = await scoreJobs(eligible, { client: llm, profile: options.profile, thresholds });

  if (!options.dryRun) {
    for (const failure of scoring.failures) {
      await setJobStatus(env.DB, failure.jobId, "scoring_failed");
    }
    for (const { job, score } of scoring.scored) {
      await insertJobScore(env.DB, {
        jobId: job.id,
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
    } else {
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
 * Orchestrates board ingest + per-user match/notify for one cron/manual tick.
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
    const locked = await acquireRunLock(env.DB, utcThreeHourSlotKey(now), crypto.randomUUID());
    if (!locked) {
      logger.warn({
        operation: "daily_job_search",
        status: "skipped",
        reason: "run_already_exists",
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

  try {
    // Use default profile prefs for title prefilters during ingest (shared catalog).
    const seedProfile = await loadCandidateProfile(env);
    const ingest = await runBoardIngest(env, {
      ...options,
      dryRun,
      now,
      logger: runLogger,
      preferences: seedProfile.preferences,
    });
    summary.discoveredCount = ingest.discoveredCount;
    summary.newCount = ingest.newJobs.length;
    summary.sourceFailures = ingest.sourceFailures;
    summary.boardsPolled = ingest.sourcesChecked;

    const users = await loadActiveProfiles(env);
    let totalEligible = 0;
    let totalShortlisted = 0;
    let totalScoringFailures = 0;
    let filterRejects: Record<string, number> | undefined;

    for (const { user, profile } of users) {
      const match = await runUserMatchAndNotify(env, {
        userId: user.id,
        profile,
        telegramChatId: user.telegram_chat_id,
        newJobs: ingest.newJobs,
        runId: run.id,
        now,
        dryRun,
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

    summary.eligibleCount = totalEligible;
    summary.shortlistedCount = totalShortlisted;
    summary.scoringFailures = totalScoringFailures;
    summary.usersNotified = users.length;
    if (dryRun && filterRejects) summary.filterRejects = filterRejects;

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
      fromCatalog: ingest.fromCatalog,
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
  }
}
