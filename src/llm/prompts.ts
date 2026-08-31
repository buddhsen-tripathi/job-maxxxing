import type { CandidateProfile } from "../candidate/profile";
import type { JobRow } from "../db/schema";

export const SCORING_PROMPT_VERSION = "scoring.v2";
export const ANSWER_PROMPT_VERSION = "answers.v1";

export interface ScoringPromptOptions {
  thresholds?: { strongMatch: number; review: number };
  preferUsBased?: boolean;
}

function buildScoringSystem(options: ScoringPromptOptions): string {
  const strong = options.thresholds?.strongMatch ?? 85;
  const review = options.thresholds?.review ?? 60;
  const usRule = options.preferUsBased
    ? "\n- The candidate strongly prefers US-based roles: locationScore 10 for US-based or US-remote roles, 5 or less for clearly non-US locations."
    : "";
  return `You are a precise job-match scoring engine for a personal job-search agent.

Rules:
- Score the job against the candidate profile using ONLY the evidence provided.
- Never invent candidate experience. Missing evidence lowers the evidenceScore.
- Required skills weigh more than preferred skills; preferred skills are not mandatory.
- Quote or paraphrase concrete job requirements in each evidence entry.
- candidateEvidenceId must be one of the provided evidence IDs, or null when no evidence exists.
- Component ranges: technicalScore 0-40, experienceScore 0-25, domainScore 0-15, locationScore 0-10, evidenceScore 0-10.
- totalScore must equal the exact sum of the five component scores.
- recommendation: "strong_match" (${strong}+), "review" (${review}-${strong - 1}), "skip" (<${review}).${usRule}
- Output ONLY valid JSON matching the requested shape. No markdown, no commentary.`;
}

export function buildScoringMessages(
  job: JobRow,
  profile: CandidateProfile,
  options: ScoringPromptOptions = {},
): { system: string; user: string } {
  const evidenceList = profile.experience.evidence
    .map((entry) => `- ${entry.id}: ${entry.claim} (source: ${entry.source})`)
    .join("\n");

  const user = `Score this job for the candidate.

JOB
Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? "unknown"}
Workplace type: ${job.workplace_type ?? "unknown"}
Employment type: ${job.employment_type ?? "unknown"}
Description:
${job.description}

CANDIDATE
Current title: ${profile.experience.currentTitle ?? "unknown"}
Total years of experience: ${profile.experience.totalYears}
Skills: ${profile.experience.skills.join(", ")}
Domains: ${profile.experience.domains.join(", ")}
Preferred locations: ${profile.preferences.locations.join(", ")}
Remote acceptable: ${profile.preferences.remote}

EVIDENCE (use these IDs in candidateEvidenceId):
${evidenceList || "(no evidence entries)"}

Respond with JSON: {"technicalScore":int,"experienceScore":int,"domainScore":int,"locationScore":int,"evidenceScore":int,"totalScore":int,"recommendation":"strong_match"|"review"|"skip","reasons":string[],"risks":string[],"evidence":[{"jobRequirement":string,"candidateEvidenceId":string|null,"assessment":"match"|"partial"|"missing"}]}`;

  return { system: buildScoringSystem(options), user };
}

const ANSWER_SYSTEM = `You draft job-application answers for a personal job-search agent.

Rules:
- Use only the verified candidate facts provided. Never invent experience, employers, dates, or product usage.
- If the verified facts do not cover the question, respond with confidence "unknown" and no answer.
- Reworded-but-supported answers use confidence "derived"; answers copied from verified profile answers use "verified".
- Never answer demographic or voluntary self-identification questions.
- Output ONLY valid JSON.`;

export function buildAnswerMessages(
  question: string,
  job: JobRow,
  profile: CandidateProfile,
): { system: string; user: string } {
  const verifiedAnswers = Object.entries(profile.answers)
    .map(([key, answer]) => `- ${key}: ${answer.value}`)
    .join("\n");
  const evidenceList = profile.experience.evidence
    .map((entry) => `- ${entry.id}: ${entry.claim}`)
    .join("\n");

  const user = `Draft an answer for this application question.

QUESTION: ${question}

JOB: ${job.title} at ${job.company}

VERIFIED PROFILE ANSWERS:
${verifiedAnswers || "(none)"}

CANDIDATE SKILLS: ${profile.experience.skills.join(", ")}
YEARS OF EXPERIENCE: ${profile.experience.totalYears}

EVIDENCE:
${evidenceList || "(none)"}

Respond with JSON: {"answer":string|null,"confidence":"verified"|"derived"|"unknown","evidenceIds":string[]}`;

  return { system: ANSWER_SYSTEM, user };
}
