import { prepareApplication } from "../applications/prepare";
import type { CandidateProfile } from "../candidate/profile";
import { getApplicationByJobId } from "../db/repositories/applications";
import { getJobById, insertJobAction, setJobStatus } from "../db/repositories/jobs";
import { blockCompany, insertAuditEvent } from "../db/repositories/meta";
import { getUserJobState, upsertUserJobState } from "../db/repositories/user-jobs";
import { normalizeCompany } from "../jobs/fingerprint";
import { getScoredJob } from "../jobs/scoring";
import type { LlmClient } from "../llm/client";
import { errorMessage } from "../shared/errors";
import type { TelegramClient } from "./client";
import {
  renderAnswersReview,
  renderBlockConfirmation,
  renderPreparationSummary,
  renderReviewCard,
} from "./digest";

const CALLBACK_PATTERN =
  /^job:(review|shortlist|skip|block|blockconfirm|back|prepare|answers):([0-9a-f-]{36})$/;

export type CallbackActionType =
  | "review"
  | "shortlist"
  | "skip"
  | "block"
  | "blockconfirm"
  | "back"
  | "prepare"
  | "answers";

export interface CallbackAction {
  type: CallbackActionType;
  jobId: string;
}

export function parseCallbackData(data: string): CallbackAction | null {
  const match = CALLBACK_PATTERN.exec(data);
  const [, type, jobId] = match ?? [];
  if (!type || !jobId) return null;
  return { type: type as CallbackActionType, jobId };
}

export interface CallbackQuery {
  id: string;
  data?: string | undefined;
  message?: { chat: { id: number | string }; message_id: number } | undefined;
}

export interface CallbackDeps {
  userId: string;
  profile?: CandidateProfile;
  llm?: LlmClient;
}

export async function handleCallbackQuery(
  db: D1Database,
  client: TelegramClient,
  query: CallbackQuery,
  deps: CallbackDeps,
): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (chatId === undefined || messageId === undefined || !query.data) {
    await client.answerCallbackQuery(query.id);
    return;
  }

  const action = parseCallbackData(query.data);
  if (!action) {
    await client.answerCallbackQuery(query.id, "Unsupported action.");
    return;
  }

  const job = await getJobById(db, action.jobId);
  if (!job) {
    await client.answerCallbackQuery(query.id, "Job not found.");
    return;
  }

  switch (action.type) {
    case "review": {
      const scored = await getScoredJob(db, job.id, deps.userId);
      if (!scored) {
        await client.answerCallbackQuery(query.id, "No score available for this job yet.");
        return;
      }
      const card = renderReviewCard(scored);
      await client.sendMessage({ chatId: String(chatId), text: card.text, buttons: card.buttons });
      await client.answerCallbackQuery(query.id);
      return;
    }

    case "shortlist": {
      const existing = await getUserJobState(db, deps.userId, job.id);
      if (existing?.status === "shortlisted") {
        await client.answerCallbackQuery(query.id, "Already saved.");
        return;
      }
      await upsertUserJobState(db, {
        userId: deps.userId,
        jobId: job.id,
        status: "shortlisted",
      });
      await insertJobAction(db, {
        jobId: job.id,
        action: "shortlist",
        source: "telegram",
        metadataJson: JSON.stringify({ userId: deps.userId }),
      });
      await insertAuditEvent(db, {
        entityType: "job",
        entityId: job.id,
        eventType: "shortlisted",
        payload: { source: "telegram", userId: deps.userId },
      });
      await client.answerCallbackQuery(query.id, "Saved.");
      return;
    }

    case "skip": {
      const existing = await getUserJobState(db, deps.userId, job.id);
      if (existing?.status === "skipped") {
        await client.answerCallbackQuery(query.id, "Already skipped.");
        return;
      }
      await upsertUserJobState(db, {
        userId: deps.userId,
        jobId: job.id,
        status: "skipped",
      });
      await insertJobAction(db, {
        jobId: job.id,
        action: "skip",
        source: "telegram",
        metadataJson: JSON.stringify({ userId: deps.userId }),
      });
      await insertAuditEvent(db, {
        entityType: "job",
        entityId: job.id,
        eventType: "skipped",
        payload: { source: "telegram", userId: deps.userId },
      });
      await client.answerCallbackQuery(query.id, "Skipped.");
      return;
    }

    case "block": {
      if (deps.userId !== "default") {
        await client.answerCallbackQuery(query.id, "Company block is operator-only for now.");
        return;
      }
      const confirmation = renderBlockConfirmation(job.id, job.company);
      await client.editMessageText({
        chatId: String(chatId),
        messageId,
        text: confirmation.text,
        buttons: confirmation.buttons,
      });
      await client.answerCallbackQuery(query.id);
      return;
    }

    case "blockconfirm": {
      if (deps.userId !== "default") {
        await client.answerCallbackQuery(query.id, "Company block is operator-only for now.");
        return;
      }
      const normalized = normalizeCompany(job.company);
      await blockCompany(db, { normalizedCompany: normalized, displayName: job.company });
      await setJobStatus(db, job.id, "blocked");
      await insertJobAction(db, {
        jobId: job.id,
        action: "block_company",
        source: "telegram",
        metadataJson: JSON.stringify({ userId: deps.userId }),
      });
      await insertAuditEvent(db, {
        entityType: "job",
        entityId: job.id,
        eventType: "company_blocked",
        payload: { company: job.company, source: "telegram", userId: deps.userId },
      });
      await client.editMessageText({
        chatId: String(chatId),
        messageId,
        text: `Blocked ${job.company}. Future runs will filter out this company.`,
      });
      await client.answerCallbackQuery(query.id, "Company blocked.");
      return;
    }

    case "back": {
      const scored = await getScoredJob(db, job.id, deps.userId);
      if (scored) {
        const card = renderReviewCard(scored);
        await client.editMessageText({
          chatId: String(chatId),
          messageId,
          text: card.text,
          buttons: card.buttons,
        });
      }
      await client.answerCallbackQuery(query.id);
      return;
    }

    case "prepare": {
      if (deps.userId !== "default") {
        await client.answerCallbackQuery(
          query.id,
          "Prepare is operator-only until per-user apps ship.",
        );
        return;
      }
      if (!deps.profile) {
        await client.answerCallbackQuery(
          query.id,
          "Preparation unavailable: no candidate profile.",
        );
        return;
      }
      try {
        const prepared = await prepareApplication(db, {
          jobId: job.id,
          profile: deps.profile,
          ...(deps.llm ? { llm: deps.llm } : {}),
        });
        const summary = renderPreparationSummary({
          jobTitle: job.title,
          company: job.company,
          jobId: job.id,
          applyUrl: job.apply_url,
          resumeVariant: prepared.resumeVariant,
          verifiedCount: prepared.answers.filter((a) => a.confidence === "verified").length,
          reviewCount: prepared.answers.filter((a) => a.answer && a.requiresApproval).length,
          unknownCount: prepared.unresolvedQuestions.length,
        });
        await client.sendMessage({
          chatId: String(chatId),
          text: summary.text,
          buttons: summary.buttons,
        });
        await client.answerCallbackQuery(query.id, "Application prepared.");
      } catch (error) {
        await client.answerCallbackQuery(query.id, `Preparation failed: ${errorMessage(error)}`);
      }
      return;
    }

    case "answers": {
      if (deps.userId !== "default") {
        await client.answerCallbackQuery(query.id, "Answers review is operator-only for now.");
        return;
      }
      const application = await getApplicationByJobId(db, job.id);
      if (!application?.prepared_answers_json) {
        await client.answerCallbackQuery(query.id, "No prepared application for this job.");
        return;
      }
      const answers = JSON.parse(application.prepared_answers_json) as Parameters<
        typeof renderAnswersReview
      >[0]["answers"];
      const review = renderAnswersReview({ jobId: job.id, answers });
      await client.sendMessage({
        chatId: String(chatId),
        text: review.text,
        buttons: review.buttons,
      });
      await client.answerCallbackQuery(query.id);
      return;
    }
  }
}
