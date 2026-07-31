import { z } from "zod";
import type { CandidateProfile } from "../candidate/profile";
import type { JobRow } from "../db/schema";
import type { LlmClient } from "../llm/client";
import { ANSWER_PROMPT_VERSION } from "../llm/prompts";
import type { PreparedAnswer } from "./types";

export const DEMOGRAPHIC_PATTERN =
  /(race|ethnicity|gender|disability|veteran|self-?identification|equal opportunity|pronouns|sexual orientation)/i;
const WORK_AUTH_PATTERN = /authorized to work|work authorization|legally authorized/i;
const SPONSORSHIP_PATTERN = /sponsor/i;
const YEARS_PATTERN = /years of (experience|relevant)/i;
const SALARY_PATTERN = /salary|compensation|pay range|desired pay/i;
const WHY_COMPANY_PATTERN = /why (do you want to work|this company|us|are you interested)/i;

export const DEFAULT_QUESTIONS = [
  "Are you authorized to work in the country where this role is located?",
  "Will you now or in the future require sponsorship for employment visa status?",
  "How many years of relevant professional experience do you have?",
  "What are your salary expectations?",
  "Why do you want to work at this company?",
];

function fromProfileAnswer(
  question: string,
  profile: CandidateProfile,
  key: string,
): PreparedAnswer | null {
  const answer = profile.answers[key];
  if (!answer) return null;
  return {
    question,
    answer: answer.value,
    confidence: "verified",
    evidenceIds: answer.evidenceIds,
    requiresApproval: answer.requiresApproval || answer.sensitive,
  };
}

const DraftAnswerSchema = z.object({
  answer: z.string().nullable(),
  confidence: z.enum(["verified", "derived", "unknown"]),
  evidenceIds: z.array(z.string()).default([]),
});

export async function buildAnswer(
  question: string,
  job: JobRow,
  profile: CandidateProfile,
  llm?: LlmClient,
): Promise<PreparedAnswer> {
  if (DEMOGRAPHIC_PATTERN.test(question)) {
    return {
      question,
      confidence: "unknown",
      evidenceIds: [],
      requiresApproval: true,
    };
  }

  if (WORK_AUTH_PATTERN.test(question)) {
    const verified = fromProfileAnswer(question, profile, "work_authorization");
    if (verified) return verified;
  }

  if (SPONSORSHIP_PATTERN.test(question)) {
    const verified = fromProfileAnswer(question, profile, "sponsorship");
    if (verified) return verified;
    return {
      question,
      confidence: "unknown",
      evidenceIds: [],
      requiresApproval: true,
    };
  }

  if (YEARS_PATTERN.test(question)) {
    return {
      question,
      answer: `${profile.experience.totalYears} years of professional software engineering experience.`,
      confidence: "derived",
      evidenceIds: profile.experience.evidence.map((entry) => entry.id),
      requiresApproval: false,
    };
  }

  if (SALARY_PATTERN.test(question)) {
    const configured = fromProfileAnswer(question, profile, "salary");
    if (configured) return { ...configured, requiresApproval: true };
    return {
      question,
      confidence: "unknown",
      evidenceIds: [],
      requiresApproval: true,
    };
  }

  if (WHY_COMPANY_PATTERN.test(question) && llm?.answerQuestion) {
    try {
      const raw = await llm.answerQuestion({
        question,
        job,
        profile,
        promptVersion: ANSWER_PROMPT_VERSION,
      });
      const parsed = DraftAnswerSchema.safeParse(raw);
      if (parsed.success && parsed.data.answer && parsed.data.confidence !== "unknown") {
        const knownIds = new Set(profile.experience.evidence.map((entry) => entry.id));
        return {
          question,
          answer: parsed.data.answer,
          confidence: "derived",
          evidenceIds: parsed.data.evidenceIds.filter((id) => knownIds.has(id)),
          requiresApproval: true,
        };
      }
    } catch {
      // fall through to unresolved
    }
    return {
      question,
      confidence: "unknown",
      evidenceIds: [],
      requiresApproval: true,
    };
  }

  return {
    question,
    confidence: "unknown",
    evidenceIds: [],
    requiresApproval: true,
  };
}
