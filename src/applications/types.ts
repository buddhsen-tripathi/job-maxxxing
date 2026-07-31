import type { ApplicationStatus } from "../db/schema";

export interface PreparedAnswer {
  question: string;
  answer?: string;
  confidence: "verified" | "derived" | "unknown";
  evidenceIds: string[];
  requiresApproval: boolean;
}

export interface PreparedApplication {
  jobId: string;
  applicationId: string;
  status: ApplicationStatus;
  resumeVariant: string;
  tailoredSummary?: string;
  coverLetter?: string;
  answers: PreparedAnswer[];
  unresolvedQuestions: string[];
  warnings: string[];
}
