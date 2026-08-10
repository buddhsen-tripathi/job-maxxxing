import { getLatestScoreForJob, listJobs } from "../db/repositories/jobs";
import type { TelegramClient } from "./client";
import { renderHelp, renderJobListItem, renderJobListSummary } from "./digest";

export type BotCommand =
  | { type: "help" }
  | { type: "shortlists" }
  | { type: "skipped" }
  | { type: "unknown"; raw: string };

const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s|$)/;

export function parseBotCommand(text: string): BotCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = COMMAND_RE.exec(trimmed);
  if (!match?.[1]) return { type: "unknown", raw: trimmed };
  const name = match[1].toLowerCase();
  switch (name) {
    case "start":
    case "help":
      return { type: "help" };
    case "shortlist":
    case "shortlists":
      return { type: "shortlists" };
    case "skipped":
    case "skip":
      return { type: "skipped" };
    default:
      return { type: "unknown", raw: trimmed };
  }
}

const LIST_LIMIT = 15;

async function sendJobStatusList(
  db: D1Database,
  client: TelegramClient,
  chatId: string,
  status: "shortlisted" | "skipped",
): Promise<void> {
  const jobs = await listJobs(db, { status, limit: LIST_LIMIT });
  await client.sendMessage({
    chatId,
    text: renderJobListSummary(status, jobs.length),
  });
  for (const [index, job] of jobs.entries()) {
    const score = await getLatestScoreForJob(db, job.id);
    const card = renderJobListItem(index + 1, job, score?.total_score ?? null);
    await client.sendMessage({ chatId, text: card.text, buttons: card.buttons });
  }
}

export async function handleBotCommand(
  db: D1Database,
  client: TelegramClient,
  chatId: string,
  text: string,
): Promise<{ handled: boolean }> {
  const command = parseBotCommand(text);
  if (!command) return { handled: false };

  switch (command.type) {
    case "help":
      await client.sendMessage({ chatId, text: renderHelp() });
      return { handled: true };
    case "shortlists":
      await sendJobStatusList(db, client, chatId, "shortlisted");
      return { handled: true };
    case "skipped":
      await sendJobStatusList(db, client, chatId, "skipped");
      return { handled: true };
    case "unknown":
      await client.sendMessage({
        chatId,
        text: "Unknown command. Try /help",
      });
      return { handled: true };
  }
}

export const BOT_COMMANDS = [
  { command: "shortlists", description: "Show shortlisted jobs" },
  { command: "skipped", description: "Show skipped jobs" },
  { command: "help", description: "How to use the bot" },
] as const;
