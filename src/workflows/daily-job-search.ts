import {
  parseCandidateProfileEnv,
  parseSecrets,
  parseSourcesConfig,
  parseTelegramSecrets,
  parseVars,
} from "../config";
import { getApplicationByJobId } from "../db/repositories/applications";
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
import type { JobRow } from "../db/schema";
import type { Env } from "../env";
import { discoverFromSources, type SourceFailure } from "../jobs/discover";
import { applyHardFilters } from "../jobs/filters";
import { chooseDigestJobs, type ScoredJob, type ScoreThresholds, scoreJobs } from "../jobs/scoring";
import type { LlmClient } from "../llm/client";
import { createMockLlmClient } from "../llm/mock";
import { createOpenAiLlmClient } from "../llm/openai";
import { errorMessage } from "../shared/errors";
import { createLogger, type Logger } from "../shared/logger";
import { utcDateKey } from "../shared/time";
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
}

async function acquireRunLock(db: D1Database, dateKey: string, runId: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO run_locks (date, run_id, created_at) VALUES (?, ?, ?)")
    .bind(dateKey, runId, new Date().toISOString())
    .run();
  return result.meta.changes === 1;
}

function resolveLlmClient(env: Env, override: LlmClient | undefined, logger: Logger): LlmClient {
  if (override) return override;
  try {
    const secrets = parseSecrets(env);
    return createOpenAiLlmClient({ apiKey: secrets.LLM_API_KEY, model: secrets.LLM_MODEL });
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
): DigestNotifier {
  if (override) return override;
  try {
    const secrets = parseTelegramSecrets(env);
    return createTelegramNotifier({
      client: createTelegramClient({ token: secrets.TELEGRAM_BOT_TOKEN }),
      chatId: secrets.TELEGRAM_ALLOWED_CHAT_ID,
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
  };

  if (!dryRun) {
    const locked = await acquireRunLock(env.DB, utcDateKey(now), crypto.randomUUID());
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
    const profile = parseCandidateProfileEnv(env);
    const allSources = parseSourcesConfig(env);
    const sources = options.sourceNames
      ? allSources.filter((entry) => options.sourceNames?.includes(entry.source))
      : allSources;

    const discovery = await discoverFromSources(
      sources,
      {
        now,
        preferences: profile.preferences,
        fetch: options.fetchImpl ?? globalThis.fetch,
        logger: runLogger,
      },
      { ...(options.limit !== undefined ? { limit: options.limit } : {}) },
    );
    summary.discoveredCount = discovery.discoveredCount;
    summary.sourceFailures = discovery.failures;

    const llm = resolveLlmClient(env, options.llmClient, runLogger);
    const blockedCompanies = await listBlockedCompanyKeys(env.DB);

    const eligible: JobRow[] = [];

    if (dryRun) {
      for (const job of discovery.jobs) {
        const existing = await getJobByFingerprint(env.DB, job.fingerprint);
        if (existing) continue;
        summary.newCount += 1;
        const asRow = { ...job, id: `dry-${job.fingerprint}` } as unknown as JobRow;
        const filter = applyHardFilters(asRow, {
          preferences: profile.preferences,
          profile,
          blockedCompanies,
          hasApplied: false,
          previouslySkipped: false,
        });
        if (filter.eligible) eligible.push(asRow);
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
          now,
        });
        if (!isNew) continue;
        summary.newCount += 1;

        const application = await getApplicationByJobId(env.DB, row.id);
        const skips = await listActionsForJob(env.DB, row.id, "skip");
        const filter = applyHardFilters(row, {
          preferences: profile.preferences,
          profile,
          blockedCompanies,
          hasApplied: application !== null,
          previouslySkipped: skips.length > 0,
        });

        await insertJobAction(env.DB, {
          jobId: row.id,
          action: filter.eligible ? "filter_passed" : "filter_rejected",
          source: "system",
          metadataJson: JSON.stringify(
            filter.eligible
              ? { warnings: filter.warnings }
              : { reasonCode: filter.reasonCode, explanation: filter.explanation },
          ),
          now,
        });

        if (filter.eligible) {
          await setJobStatus(env.DB, row.id, "eligible");
          eligible.push(row);
        } else {
          await setJobStatus(env.DB, row.id, "rejected_by_filter");
        }
      }
    }

    summary.eligibleCount = eligible.length;

    const scoring = await scoreJobs(eligible, { client: llm, profile });
    summary.scoringFailures = scoring.failures.length;

    if (!dryRun) {
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
          now,
        });
        await setJobStatus(env.DB, job.id, "scored");
      }
    }

    const digestJobs = chooseDigestJobs(scoring.scored, options.thresholds);
    summary.shortlistedCount = digestJobs.length;

    if (!dryRun) {
      const digestBase = {
        runId: run.id,
        date: now,
        sourcesChecked: sources.length,
        discoveredCount: summary.discoveredCount,
        newCount: summary.newCount,
        eligibleCount: summary.eligibleCount,
      };
      if (digestJobs.length > 0) {
        await notifier.sendDailyDigest({ ...digestBase, jobs: digestJobs });
      } else {
        await notifier.sendNoMatchesNotice(digestBase);
      }
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
