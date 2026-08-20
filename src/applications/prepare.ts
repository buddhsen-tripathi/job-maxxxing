import type { CandidateProfile } from "../candidate/profile";
import {
  createApplication,
  getApplicationByJobId,
  updateApplication,
} from "../db/repositories/applications";
import { getJobById } from "../db/repositories/jobs";
import { insertAuditEvent } from "../db/repositories/meta";
import type { JobRow } from "../db/schema";
import type { LlmClient } from "../llm/client";
import { AppError } from "../shared/errors";
import { buildAnswer, DEFAULT_QUESTIONS } from "./answers";
import { transitionApplication } from "./state-machine";
import type { PreparedApplication } from "./types";

export function selectResumeVariant(job: JobRow, profile: CandidateProfile): string {
  const text = `${job.title}\n${job.description}`.toLowerCase();
  const has = (...needles: string[]) => needles.some((needle) => text.includes(needle));
  if (has("backend", "back-end", "api", "distributed", "platform", "infrastructure")) {
    return "backend-systems";
  }
  if (has("frontend", "front-end", "react", "design system", "ui engineer")) {
    return "frontend-product";
  }
  if (has("full stack", "full-stack", "fullstack")) {
    return "fullstack";
  }
  return profile.experience.domains.length > 0 ? "domain-focused" : "general";
}

export async function prepareApplication(
  db: D1Database,
  input: {
    jobId: string;
    userId?: string;
    profile: CandidateProfile;
    llm?: LlmClient;
    questions?: string[];
    now?: Date;
  },
): Promise<PreparedApplication> {
  const job = await getJobById(db, input.jobId);
  if (!job) {
    throw new AppError("job_not_found", `Job ${input.jobId} does not exist.`);
  }

  const userId = input.userId ?? "default";
  let application = await getApplicationByJobId(db, job.id, userId);
  if (!application) {
    application = await createApplication(db, { jobId: job.id, userId, now: input.now });
  }
  if (!application) {
    throw new AppError("preparation_failed", `Could not create application for job ${job.id}.`);
  }
  if (application.status !== "preparing" && application.status !== "preparation_failed") {
    throw new AppError(
      "invalid_transition",
      `Application for job ${job.id} is already "${application.status}".`,
    );
  }

  const questions = input.questions ?? DEFAULT_QUESTIONS;
  const answers = [];
  for (const question of questions) {
    answers.push(await buildAnswer(question, job, input.profile, input.llm));
  }
  const unresolvedQuestions = answers
    .filter((answer) => answer.confidence === "unknown")
    .map((answer) => answer.question);
  const resumeVariant = selectResumeVariant(job, input.profile);
  const warnings: string[] = [];
  if (answers.some((answer) => answer.requiresApproval && answer.answer)) {
    warnings.push("Some answers require explicit approval before any submission.");
  }

  transitionApplication(application.status, "prepared");
  await updateApplication(
    db,
    application.id,
    {
      status: "prepared",
      resumeVariant,
      preparedAnswersJson: JSON.stringify(answers),
      unresolvedQuestionsJson: JSON.stringify(unresolvedQuestions),
    },
    input.now,
  );
  await insertAuditEvent(db, {
    entityType: "application",
    entityId: application.id,
    eventType: "prepared",
    payload: {
      jobId: job.id,
      resumeVariant,
      verified: answers.filter((a) => a.confidence === "verified").length,
      derived: answers.filter((a) => a.confidence === "derived").length,
      unknown: unresolvedQuestions.length,
    },
    now: input.now,
  });

  return {
    jobId: job.id,
    applicationId: application.id,
    status: "prepared",
    resumeVariant,
    answers,
    unresolvedQuestions,
    warnings,
  };
}
