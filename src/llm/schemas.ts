import { z } from "zod";

export const JobScoreSchema = z
  .object({
    technicalScore: z.number().int().min(0).max(40),
    experienceScore: z.number().int().min(0).max(25),
    domainScore: z.number().int().min(0).max(15),
    locationScore: z.number().int().min(0).max(10),
    evidenceScore: z.number().int().min(0).max(10),
    totalScore: z.number().int().min(0).max(100),
    recommendation: z.enum(["strong_match", "review", "skip"]),
    reasons: z.array(z.string()).max(5),
    risks: z.array(z.string()).max(5),
    evidence: z.array(
      z.object({
        jobRequirement: z.string(),
        candidateEvidenceId: z.string().nullable(),
        assessment: z.enum(["match", "partial", "missing"]),
      }),
    ),
  })
  .superRefine((score, ctx) => {
    const sum =
      score.technicalScore +
      score.experienceScore +
      score.domainScore +
      score.locationScore +
      score.evidenceScore;
    if (sum !== score.totalScore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `totalScore ${score.totalScore} does not equal component sum ${sum}`,
      });
    }
  });

export type JobScore = z.infer<typeof JobScoreSchema>;

export const PreparedAnswersSchema = z.array(
  z.object({
    question: z.string(),
    answer: z.string().optional(),
    confidence: z.enum(["verified", "derived", "unknown"]),
    evidenceIds: z.array(z.string()),
    requiresApproval: z.boolean(),
  }),
);
