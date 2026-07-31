import type { CandidateProfile } from "../candidate/profile";
import { getJobById, getLatestScoreForJob } from "../db/repositories/jobs";
import type { JobRow } from "../db/schema";
import type { LlmClient } from "../llm/client";
import { SCORING_PROMPT_VERSION } from "../llm/prompts";
import { type JobScore, JobScoreSchema } from "../llm/schemas";
import { errorMessage } from "../shared/errors";
import { mapWithConcurrency } from "../shared/http";

export interface ScoreThresholds {
  strongMatch: number;
  review: number;
}

export const DEFAULT_THRESHOLDS: ScoreThresholds = { strongMatch: 85, review: 70 };

export function recommendationForScore(
  totalScore: number,
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS,
): JobScore["recommendation"] {
  if (totalScore >= thresholds.strongMatch) return "strong_match";
  if (totalScore >= thresholds.review) return "review";
  return "skip";
}

export class ScoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreValidationError";
  }
}

export function validateScore(raw: unknown, profile: CandidateProfile): JobScore {
  const parsed = JobScoreSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScoreValidationError(`Score failed schema validation: ${parsed.error.message}`);
  }
  const score = parsed.data;
  const knownEvidenceIds = new Set(profile.experience.evidence.map((entry) => entry.id));
  for (const entry of score.evidence) {
    if (entry.candidateEvidenceId !== null && !knownEvidenceIds.has(entry.candidateEvidenceId)) {
      throw new ScoreValidationError(
        `Score references unknown evidence id "${entry.candidateEvidenceId}"`,
      );
    }
  }
  const expectedRecommendation = recommendationForScore(score.totalScore);
  if (score.recommendation !== expectedRecommendation) {
    throw new ScoreValidationError(
      `Recommendation "${score.recommendation}" inconsistent with totalScore ${score.totalScore}`,
    );
  }
  return score;
}

export async function scoreJob(
  client: LlmClient,
  job: JobRow,
  profile: CandidateProfile,
): Promise<JobScore> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await client.scoreJob({ job, profile, promptVersion: SCORING_PROMPT_VERSION });
    try {
      return validateScore(raw, profile);
    } catch (error) {
      lastError = error;
    }
  }
  throw new ScoreValidationError(
    `Score invalid after retry: ${lastError instanceof Error ? lastError.message : errorMessage(lastError)}`,
  );
}

export interface ScoredJob {
  job: JobRow;
  score: JobScore;
}

export interface ScoringOutcome {
  scored: ScoredJob[];
  failures: Array<{ jobId: string; error: string }>;
}

const LLM_CONCURRENCY = 2;

export async function scoreJobs(
  jobs: readonly JobRow[],
  options: {
    client: LlmClient;
    profile: CandidateProfile;
    concurrency?: number;
  },
): Promise<ScoringOutcome> {
  const results = await mapWithConcurrency(
    jobs,
    options.concurrency ?? LLM_CONCURRENCY,
    async (job) => {
      try {
        const score = await scoreJob(options.client, job, options.profile);
        return { scored: { job, score } as ScoredJob, failure: null };
      } catch (error) {
        return {
          scored: null,
          failure: { jobId: job.id, error: errorMessage(error) },
        };
      }
    },
  );
  return {
    scored: results.flatMap((r) => (r.scored ? [r.scored] : [])),
    failures: results.flatMap((r) => (r.failure ? [r.failure] : [])),
  };
}

export async function getScoredJob(db: D1Database, jobId: string): Promise<ScoredJob | null> {
  const job = await getJobById(db, jobId);
  if (!job) return null;
  const row = await getLatestScoreForJob(db, jobId);
  if (!row) return null;
  return {
    job,
    score: {
      technicalScore: row.technical_score,
      experienceScore: row.experience_score,
      domainScore: row.domain_score,
      locationScore: row.location_score,
      evidenceScore: row.evidence_score,
      totalScore: row.total_score,
      recommendation: row.recommendation,
      reasons: JSON.parse(row.reasons_json) as string[],
      risks: JSON.parse(row.risks_json) as string[],
      evidence: JSON.parse(row.evidence_json) as JobScore["evidence"],
    },
  };
}

export function chooseDigestJobs(
  scored: readonly ScoredJob[],
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS,
): ScoredJob[] {
  return scored
    .filter(({ score }) => score.totalScore >= thresholds.review)
    .sort((a, b) => b.score.totalScore - a.score.totalScore);
}
