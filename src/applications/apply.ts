import type { CandidateProfile } from "../candidate/profile";
import { nowIso } from "../db/client";
import {
  createApplication,
  getApplicationByJobId,
  updateApplication,
} from "../db/repositories/applications";
import { insertAuditEvent } from "../db/repositories/meta";
import { getUserResume } from "../db/repositories/user-resumes";
import { upsertUserSession } from "../db/repositories/user-sessions";
import { upsertUserProfile } from "../db/repositories/users";
import type { ApplicationStatus, JobRow } from "../db/schema";
import { getUserResumeObject } from "../resume/store";
import {
  type ApplyDraft,
  answerKeyForField,
  filledFieldMap,
  initialApplyFields,
  matchSelectValue,
  nextFieldToAsk,
} from "./fill";
import {
  fetchGreenhouseQuestions,
  parseGreenhouseApplyTarget,
  submitGreenhouseApplication,
} from "./greenhouse";
import { transitionApplication } from "./state-machine";

export type ApplyStartResult =
  | { kind: "unsupported"; reason: string }
  | { kind: "no_resume" }
  | { kind: "already_submitted"; reference: string | null }
  | { kind: "blocked_file"; label: string }
  | { kind: "ask"; draft: ApplyDraft; question: string }
  | { kind: "confirm"; draft: ApplyDraft }
  | { kind: "error"; message: string };

export function parseApplyDraft(raw: string | null): ApplyDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ApplyDraft;
    if (!parsed.jobId || !Array.isArray(parsed.fields)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function persistDraft(
  db: D1Database,
  userId: string,
  draft: ApplyDraft,
  state: "applying_ask" | "applying_confirm",
): Promise<void> {
  await upsertUserSession(db, {
    userId,
    state,
    draftJson: JSON.stringify(draft),
  });
}

async function advanceToReview(db: D1Database, applicationId: string, status: ApplicationStatus) {
  let current = status;
  if (current === "preparation_failed") {
    transitionApplication("preparation_failed", "preparing");
    await updateApplication(db, applicationId, { status: "preparing" });
    current = "preparing";
  }
  if (current === "preparing") {
    transitionApplication("preparing", "prepared");
    await updateApplication(db, applicationId, { status: "prepared" });
    current = "prepared";
  }
  if (current === "prepared") {
    transitionApplication("prepared", "awaiting_review");
    await updateApplication(db, applicationId, { status: "awaiting_review" });
  }
}

function finishStart(draft: ApplyDraft): ApplyStartResult {
  const pending = nextFieldToAsk(draft.fields);
  if (pending) return { kind: "ask", draft, question: pending.label };
  return { kind: "confirm", draft };
}

export async function startGreenhouseApply(options: {
  db: D1Database;
  resumes?: R2Bucket;
  job: JobRow;
  userId: string;
  profile: CandidateProfile;
  fetchImpl?: typeof fetch;
}): Promise<ApplyStartResult> {
  const target = parseGreenhouseApplyTarget({
    source: options.job.source,
    sourceJobId: options.job.source_job_id,
    applyUrl: options.job.apply_url,
    canonicalUrl: options.job.canonical_url,
  });
  if (!target) {
    return { kind: "unsupported", reason: "Can't submit this board yet. Use Open listing." };
  }

  const resumeRow = await getUserResume(options.db, options.userId);
  if (!resumeRow) return { kind: "no_resume" };
  if (options.resumes) {
    const object = await getUserResumeObject(options.resumes, resumeRow.r2_key);
    if (!object) return { kind: "no_resume" };
  }

  let application = await getApplicationByJobId(options.db, options.job.id, options.userId);
  if (application?.status === "submitted") {
    return { kind: "already_submitted", reference: application.submission_reference };
  }
  if (application?.status === "submitting") {
    return { kind: "error", message: "This application is already submitting." };
  }

  if (!application) {
    application = await createApplication(options.db, {
      jobId: options.job.id,
      userId: options.userId,
    });
  }
  if (!application) return { kind: "error", message: "Could not create application." };

  let formFields: Awaited<ReturnType<typeof fetchGreenhouseQuestions>>;
  try {
    formFields = await fetchGreenhouseQuestions(target, options.fetchImpl);
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not load Greenhouse questions.",
    };
  }

  const mapped = initialApplyFields(formFields, options.profile);
  if (mapped.blockingFile) return { kind: "blocked_file", label: mapped.blockingFile };

  const draft: ApplyDraft = {
    jobId: options.job.id,
    applicationId: application.id,
    boardToken: target.boardToken,
    sourceJobId: target.jobId,
    fileName: resumeRow.file_name,
    fields: mapped.fields,
  };

  try {
    if (
      application.status === "preparing" ||
      application.status === "preparation_failed" ||
      application.status === "prepared"
    ) {
      await advanceToReview(options.db, application.id, application.status);
    }
    await updateApplication(options.db, application.id, {
      resumeVariant: draft.fileName,
      preparedAnswersJson: JSON.stringify(draft.fields),
      unresolvedQuestionsJson: JSON.stringify(
        nextFieldToAsk(draft.fields) ? [nextFieldToAsk(draft.fields)?.label] : [],
      ),
    });
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not update application state.",
    };
  }

  const result = finishStart(draft);
  await persistDraft(
    options.db,
    options.userId,
    draft,
    result.kind === "ask" ? "applying_ask" : "applying_confirm",
  );
  return result;
}

export async function recordApplyAnswer(options: {
  db: D1Database;
  userId: string;
  profile: CandidateProfile;
  draft: ApplyDraft;
  text: string;
}): Promise<ApplyStartResult> {
  const pending = nextFieldToAsk(options.draft.fields);
  if (!pending) {
    await persistDraft(options.db, options.userId, options.draft, "applying_confirm");
    return { kind: "confirm", draft: options.draft };
  }

  const trimmed = options.text.trim();
  if (!trimmed) {
    return { kind: "ask", draft: options.draft, question: pending.label };
  }

  pending.value =
    pending.options && pending.options.length > 0
      ? (matchSelectValue({ values: pending.options }, trimmed) ?? trimmed)
      : trimmed;
  pending.skip = false;

  await upsertUserProfile(options.db, options.userId, {
    ...options.profile,
    answers: {
      ...options.profile.answers,
      [answerKeyForField(pending.name)]: {
        value: pending.value,
        evidenceIds: [],
        sensitive: pending.demographic,
        requiresApproval: false,
      },
    },
  });

  const next = nextFieldToAsk(options.draft.fields);
  await updateApplication(options.db, options.draft.applicationId, {
    preparedAnswersJson: JSON.stringify(options.draft.fields),
    unresolvedQuestionsJson: JSON.stringify(next ? [next.label] : []),
  });

  if (next) {
    await persistDraft(options.db, options.userId, options.draft, "applying_ask");
    return { kind: "ask", draft: options.draft, question: next.label };
  }
  await persistDraft(options.db, options.userId, options.draft, "applying_confirm");
  return { kind: "confirm", draft: options.draft };
}

export async function submitConfirmedApplication(options: {
  db: D1Database;
  resumes: R2Bucket;
  userId: string;
  job: JobRow;
  draft: ApplyDraft;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; reference: string } | { ok: false; message: string }> {
  const pending = nextFieldToAsk(options.draft.fields);
  if (pending) {
    return { ok: false, message: `Still need an answer for: ${pending.label}` };
  }

  const application = await getApplicationByJobId(options.db, options.job.id, options.userId);
  if (!application) return { ok: false, message: "Application not found." };
  if (application.status === "submitted") {
    return { ok: true, reference: application.submission_reference ?? "ok" };
  }

  const resumeMeta = await getUserResume(options.db, options.userId);
  if (!resumeMeta) return { ok: false, message: "No stored resume." };
  const object = await getUserResumeObject(options.resumes, resumeMeta.r2_key);
  if (!object) return { ok: false, message: "Resume file missing from storage." };

  try {
    if (application.status === "awaiting_review") {
      transitionApplication("awaiting_review", "approved");
      await updateApplication(options.db, application.id, {
        status: "approved",
        approvedAt: nowIso(),
      });
    }
    const latest = await getApplicationByJobId(options.db, options.job.id, options.userId);
    const status = latest?.status ?? application.status;
    if (status === "approved") {
      transitionApplication("approved", "submitting");
      await updateApplication(options.db, application.id, { status: "submitting" });
    } else if (status === "submission_failed") {
      transitionApplication("submission_failed", "submitting");
      await updateApplication(options.db, application.id, { status: "submitting" });
    } else if (status !== "submitting") {
      return { ok: false, message: `Cannot submit from "${status}".` };
    }

    const result = await submitGreenhouseApplication(
      { boardToken: options.draft.boardToken, jobId: options.draft.sourceJobId },
      {
        fields: filledFieldMap(options.draft.fields),
        resume: {
          bytes: object.bytes,
          fileName: resumeMeta.file_name,
          contentType: resumeMeta.content_type,
        },
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
    );

    transitionApplication("submitting", "submitted");
    await updateApplication(options.db, application.id, {
      status: "submitted",
      submittedAt: nowIso(),
      submissionReference: result.reference,
    });
    await insertAuditEvent(options.db, {
      entityType: "application",
      entityId: application.id,
      eventType: "submitted",
      payload: { jobId: options.job.id, userId: options.userId, reference: result.reference },
    });
    return { ok: true, reference: result.reference };
  } catch (error) {
    const latest = await getApplicationByJobId(options.db, options.job.id, options.userId);
    if (latest?.status === "submitting") {
      transitionApplication("submitting", "submission_failed");
    }
    await updateApplication(options.db, application.id, { status: "submission_failed" });
    await insertAuditEvent(options.db, {
      entityType: "application",
      entityId: application.id,
      eventType: "submission_failed",
      payload: {
        jobId: options.job.id,
        userId: options.userId,
        error: error instanceof Error ? error.message : "submit_failed",
      },
    });
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Greenhouse submit failed.",
    };
  }
}
