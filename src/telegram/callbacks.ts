import {
  getJobById,
  insertJobAction,
  listActionsForJob,
  setJobStatus,
} from "../db/repositories/jobs";
import { blockCompany, insertAuditEvent } from "../db/repositories/meta";
import { normalizeCompany } from "../jobs/fingerprint";
import { getScoredJob } from "../jobs/scoring";
import type { TelegramClient } from "./client";
import { renderBlockConfirmation, renderReviewCard } from "./digest";

const CALLBACK_PATTERN =
  /^job:(review|shortlist|skip|block|blockconfirm|back|prepare):([0-9a-f-]{36})$/;

export type CallbackActionType =
  | "review"
  | "shortlist"
  | "skip"
  | "block"
  | "blockconfirm"
  | "back"
  | "prepare";

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

async function hasAction(db: D1Database, jobId: string, action: string): Promise<boolean> {
  const actions = await listActionsForJob(db, jobId, action);
  return actions.some((entry) => entry.source === "telegram");
}

export async function handleCallbackQuery(
  db: D1Database,
  client: TelegramClient,
  query: CallbackQuery,
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
      const scored = await getScoredJob(db, job.id);
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
      if (job.status === "shortlisted" || (await hasAction(db, job.id, "shortlist"))) {
        await client.answerCallbackQuery(query.id, "Already shortlisted.");
        return;
      }
      await setJobStatus(db, job.id, "shortlisted");
      await insertJobAction(db, { jobId: job.id, action: "shortlist", source: "telegram" });
      await insertAuditEvent(db, {
        entityType: "job",
        entityId: job.id,
        eventType: "shortlisted",
        payload: { source: "telegram" },
      });
      await client.answerCallbackQuery(query.id, "Shortlisted.");
      return;
    }

    case "skip": {
      if (job.status === "skipped" || (await hasAction(db, job.id, "skip"))) {
        await client.answerCallbackQuery(query.id, "Already skipped.");
        return;
      }
      await setJobStatus(db, job.id, "skipped");
      await insertJobAction(db, { jobId: job.id, action: "skip", source: "telegram" });
      await insertAuditEvent(db, {
        entityType: "job",
        entityId: job.id,
        eventType: "skipped",
        payload: { source: "telegram" },
      });
      await client.answerCallbackQuery(query.id, "Skipped.");
      return;
    }

    case "block": {
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
      const normalized = normalizeCompany(job.company);
      await blockCompany(db, { normalizedCompany: normalized, displayName: job.company });
      await setJobStatus(db, job.id, "blocked");
      await insertJobAction(db, { jobId: job.id, action: "block_company", source: "telegram" });
      await insertAuditEvent(db, {
        entityType: "job",
        entityId: job.id,
        eventType: "company_blocked",
        payload: { company: job.company, source: "telegram" },
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
      const scored = await getScoredJob(db, job.id);
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
      await client.answerCallbackQuery(
        query.id,
        "Application preparation is not available yet (Milestone 7).",
      );
      return;
    }
  }
}
