import { listUserJobsByStatus } from "../db/repositories/user-jobs";
import type { TelegramClient } from "./client";
import { renderHelp, renderJobLinkList } from "./digest";

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
    case "saved":
    case "links":
      return { type: "shortlists" };
    case "skipped":
    case "skip":
      return { type: "skipped" };
    default:
      return { type: "unknown", raw: trimmed };
  }
}

const LIST_LIMIT = 40;

async function sendJobLinkList(
  db: D1Database,
  client: TelegramClient,
  chatId: string,
  userId: string,
  status: "shortlisted" | "skipped",
): Promise<void> {
  const jobs = await listUserJobsByStatus(db, userId, status, LIST_LIMIT);
  await client.sendMessage({
    chatId,
    text: renderJobLinkList(status, jobs),
  });
}

export async function handleBotCommand(
  db: D1Database,
  client: TelegramClient,
  chatId: string,
  text: string,
  options: { userId: string },
): Promise<{ handled: boolean }> {
  const command = parseBotCommand(text);
  if (!command) return { handled: false };

  switch (command.type) {
    case "help":
      await client.sendMessage({ chatId, text: renderHelp() });
      return { handled: true };
    case "shortlists":
      await sendJobLinkList(db, client, chatId, options.userId, "shortlisted");
      return { handled: true };
    case "skipped":
      await sendJobLinkList(db, client, chatId, options.userId, "skipped");
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
  { command: "start", description: "Start or restart onboarding" },
  { command: "saved", description: "List saved jobs with apply links" },
  { command: "skipped", description: "List skipped jobs with apply links" },
  { command: "status", description: "Show onboarding / account status" },
  { command: "restart", description: "Rebuild profile from a new resume" },
  { command: "help", description: "Show how to use the bot" },
] as const;
