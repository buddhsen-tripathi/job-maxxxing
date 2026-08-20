import {
  type ApplyStartResult,
  parseApplyDraft,
  recordApplyAnswer,
  startGreenhouseApply,
  submitConfirmedApplication,
} from "../applications/apply";
import type { ApplyDraft } from "../applications/fill";
import { parseGreenhouseApplyTarget } from "../applications/greenhouse";
import type { CandidateProfile } from "../candidate/profile";
import { getJobById } from "../db/repositories/jobs";
import { clearUserSession, getUserSession } from "../db/repositories/user-sessions";
import type { JobRow } from "../db/schema";
import type { TelegramClient } from "./client";

export function isApplySessionState(state?: string | null): boolean {
  return state === "applying_ask" || state === "applying_confirm";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderApplyConfirm(job: JobRow, draft: ApplyDraft) {
  const lines = [
    `<b>Ready to apply</b> — ${escapeHtml(job.title)} @ ${escapeHtml(job.company)}`,
    "",
    `Resume: ${escapeHtml(draft.fileName)}`,
    "",
    "We will send:",
  ];
  for (const field of draft.fields) {
    if (field.isResume) {
      lines.push(`• Resume file`);
      continue;
    }
    if (field.skip || !field.value) continue;
    const value = field.value.length > 120 ? `${field.value.slice(0, 117)}…` : field.value;
    lines.push(`• ${escapeHtml(field.label)}: ${escapeHtml(value)}`);
  }
  lines.push("", "Nothing is sent until you tap Confirm apply.");
  return {
    text: lines.join("\n").slice(0, 4000),
    buttons: [
      [
        { text: "Confirm apply", callbackData: `job:confirm:${job.id}` },
        { text: "Cancel", callbackData: `job:cancel:${job.id}` },
      ],
      [{ text: "Open listing", url: job.apply_url }],
    ],
  };
}

function renderAsk(question: string) {
  return `Greenhouse needs this to apply:\n\n<b>${escapeHtml(question)}</b>\n\nReply with your answer. I’ll reuse it on similar questions later.`;
}

async function sendStartResult(
  client: TelegramClient,
  chatId: string,
  job: JobRow,
  result: ApplyStartResult,
): Promise<void> {
  switch (result.kind) {
    case "unsupported":
    case "blocked_file":
      await client.sendMessage({
        chatId,
        text:
          result.kind === "blocked_file"
            ? `This Greenhouse form requires a file we don’t have (${escapeHtml(result.label)}). Open the listing to apply manually.`
            : result.reason,
        buttons: [[{ text: "Open listing", url: job.apply_url }]],
      });
      return;
    case "no_resume":
      await client.sendMessage({
        chatId,
        text: "No resume file on file. Send /restart and upload a PDF (or a resume URL) so we can attach it.",
      });
      return;
    case "already_submitted":
      await client.sendMessage({
        chatId,
        text: `Already applied to this role${result.reference ? ` (ref ${escapeHtml(result.reference)})` : ""}.`,
        buttons: [[{ text: "Open listing", url: job.apply_url }]],
      });
      return;
    case "error":
      await client.sendMessage({
        chatId,
        text: `Couldn’t start apply: ${escapeHtml(result.message)}`,
        buttons: [[{ text: "Open listing", url: job.apply_url }]],
      });
      return;
    case "ask":
      await client.sendMessage({ chatId, text: renderAsk(result.question) });
      return;
    case "confirm": {
      const card = renderApplyConfirm(job, result.draft);
      await client.sendMessage({ chatId, text: card.text, buttons: card.buttons });
    }
  }
}

export async function beginApply(options: {
  db: D1Database;
  client: TelegramClient;
  chatId: string;
  job: JobRow;
  userId: string;
  profile: CandidateProfile;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (
    options.job.source !== "greenhouse" ||
    !parseGreenhouseApplyTarget({
      source: options.job.source,
      sourceJobId: options.job.source_job_id,
      applyUrl: options.job.apply_url,
      canonicalUrl: options.job.canonical_url,
    })
  ) {
    await options.client.sendMessage({
      chatId: options.chatId,
      text: "Can't submit this board yet. Use Open listing to apply on the company site.",
      buttons: [[{ text: "Open listing", url: options.job.apply_url }]],
    });
    return;
  }

  const result = await startGreenhouseApply({
    db: options.db,
    job: options.job,
    userId: options.userId,
    profile: options.profile,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  await sendStartResult(options.client, options.chatId, options.job, result);
}

export async function handleApplyMessage(options: {
  db: D1Database;
  client: TelegramClient;
  chatId: string;
  userId: string;
  profile: CandidateProfile;
  text: string;
}): Promise<{ handled: boolean }> {
  const session = await getUserSession(options.db, options.userId);
  if (!session || !isApplySessionState(session.state)) return { handled: false };
  const draft = parseApplyDraft(session.draft_json);
  if (!draft) {
    await clearUserSession(options.db, options.userId);
    return { handled: false };
  }
  const job = await getJobById(options.db, draft.jobId);
  if (!job) {
    await clearUserSession(options.db, options.userId);
    await options.client.sendMessage({
      chatId: options.chatId,
      text: "That job is gone. Pick another from a digest.",
    });
    return { handled: true };
  }

  const result = await recordApplyAnswer({
    db: options.db,
    userId: options.userId,
    profile: options.profile,
    draft,
    text: options.text,
  });
  await sendStartResult(options.client, options.chatId, job, result);
  return { handled: true };
}

export async function confirmApply(options: {
  db: D1Database;
  resumes: R2Bucket;
  client: TelegramClient;
  chatId: string;
  userId: string;
  job: JobRow;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const session = await getUserSession(options.db, options.userId);
  const draft = parseApplyDraft(session?.draft_json ?? null);
  if (session?.state !== "applying_confirm" || !draft || draft.jobId !== options.job.id) {
    await options.client.sendMessage({
      chatId: options.chatId,
      text: "No prepared application to confirm. Tap Apply on the job card first.",
    });
    return;
  }

  const result = await submitConfirmedApplication({
    db: options.db,
    resumes: options.resumes,
    userId: options.userId,
    job: options.job,
    draft,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  await clearUserSession(options.db, options.userId);
  if (result.ok) {
    await options.client.sendMessage({
      chatId: options.chatId,
      text: `Applied to <b>${escapeHtml(options.job.title)}</b> @ ${escapeHtml(options.job.company)}.`,
    });
    return;
  }
  await options.client.sendMessage({
    chatId: options.chatId,
    text: `Submit failed: ${escapeHtml(result.message)}\nYou can apply on the listing instead.`,
    buttons: [[{ text: "Open listing", url: options.job.apply_url }]],
  });
}

export async function cancelApply(
  db: D1Database,
  client: TelegramClient,
  chatId: string,
  userId: string,
): Promise<void> {
  await clearUserSession(db, userId);
  await client.sendMessage({ chatId, text: "Apply cancelled. Nothing was submitted." });
}
