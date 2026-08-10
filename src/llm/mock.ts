import type { CandidateProfile } from "../candidate/profile";
import type { JobRow } from "../db/schema";
import type { LlmClient, ScoreJobRequest } from "./client";
import type { JobScore } from "./schemas";

function overlapScore(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (term.trim() && lower.includes(term.trim().toLowerCase())) hits += 1;
  }
  return terms.length === 0 ? 0 : hits / terms.length;
}

export function deterministicScore(job: JobRow, profile: CandidateProfile): JobScore {
  const text = `${job.title}\n${job.description}`;

  const technicalScore = Math.round(overlapScore(text, profile.experience.skills) * 40);
  const requiredYears = profile.experience.totalYears >= 5 ? 25 : profile.experience.totalYears * 5;
  const experienceScore = Math.min(25, requiredYears);
  const domainScore = Math.round(overlapScore(text, profile.experience.domains) * 15);

  const locationText = `${job.location ?? ""} ${job.workplace_type ?? ""}`.toLowerCase();
  const wantsRemote = profile.preferences.remote && locationText.includes("remote");
  const matchesLocation = profile.preferences.locations.some((loc) =>
    locationText.includes(loc.toLowerCase()),
  );
  const locationScore = wantsRemote || matchesLocation ? 10 : 0;

  const evidenceRatio = overlapScore(
    text,
    profile.experience.evidence.map((entry) => entry.claim.split(" ")[0] ?? ""),
  );
  const evidenceScore =
    profile.experience.evidence.length === 0 ? 0 : Math.round(evidenceRatio * 10);

  const totalScore = technicalScore + experienceScore + domainScore + locationScore + evidenceScore;
  const recommendation =
    totalScore >= 85
      ? ("strong_match" as const)
      : totalScore >= 60
        ? ("review" as const)
        : ("skip" as const);

  return {
    technicalScore,
    experienceScore,
    domainScore,
    locationScore,
    evidenceScore,
    totalScore,
    recommendation,
    reasons: ["Deterministic mock score based on keyword overlap."],
    risks: [],
    evidence: [],
  };
}

export function createMockLlmClient(
  options: { model?: string; failTimes?: number; scriptedOutputs?: unknown[] } = {},
): LlmClient & { calls: number } {
  let calls = 0;
  let failures = options.failTimes ?? 0;
  const scripted = [...(options.scriptedOutputs ?? [])];

  const client: LlmClient & { calls: number } = {
    model: options.model ?? "mock-llm",
    get calls() {
      return calls;
    },
    async scoreJob(request: ScoreJobRequest): Promise<unknown> {
      calls += 1;
      if (failures > 0) {
        failures -= 1;
        return { garbage: true };
      }
      const next = scripted.shift();
      if (next !== undefined) return next;
      const score = deterministicScore(request.job, request.profile);
      const strong = request.thresholds?.strongMatch ?? 85;
      const review = request.thresholds?.review ?? 60;
      score.recommendation =
        score.totalScore >= strong
          ? "strong_match"
          : score.totalScore >= review
            ? "review"
            : "skip";
      return score;
    },
  };
  return client;
}
