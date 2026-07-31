import { z } from "zod";
import { SearchPreferencesSchema } from "./preferences";

export const EvidenceSchema = z.object({
  id: z.string(),
  claim: z.string(),
  source: z.string(),
});

export const AnswerSchema = z.object({
  value: z.string(),
  evidenceIds: z.array(z.string()).default([]),
  sensitive: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
});

export const CandidateProfileSchema = z.object({
  identity: z.object({
    fullName: z.string(),
    email: z.string().email(),
    phone: z.string().optional(),
    location: z.string(),
    links: z.object({
      website: z.string().url().optional(),
      github: z.string().url().optional(),
      linkedin: z.string().url().optional(),
    }),
  }),

  authorization: z.object({
    country: z.string(),
    authorizedToWork: z.boolean(),
    requiresSponsorshipNow: z.boolean(),
    requiresSponsorshipFuture: z.boolean(),
    explanation: z.string().optional(),
  }),

  experience: z.object({
    totalYears: z.number().nonnegative(),
    currentTitle: z.string().optional(),
    skills: z.array(z.string()),
    domains: z.array(z.string()),
    evidence: z.array(EvidenceSchema),
  }),

  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      field: z.string(),
      graduationDate: z.string(),
    }),
  ),

  preferences: SearchPreferencesSchema,

  answers: z.record(z.string(), AnswerSchema),
});

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;
export type CandidateEvidence = z.infer<typeof EvidenceSchema>;
export type CandidateAnswer = z.infer<typeof AnswerSchema>;

export function parseCandidateProfile(data: unknown): CandidateProfile {
  const result = CandidateProfileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid candidate profile: ${issues}`);
  }
  return result.data;
}
