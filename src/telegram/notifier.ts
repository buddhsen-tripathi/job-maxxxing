import { newId, nowIso } from "../db/client";
import type { DigestInput, DigestNotifier } from "../workflows/daily-job-search";
import type { TelegramClient } from "./client";
import { renderDigestSummary, renderJobCard, renderNoMatches } from "./digest";

export function createTelegramNotifier(options: {
  client: TelegramClient;
  chatId: string;
  db: D1Database;
}): DigestNotifier {
  const { client, chatId, db } = options;

  async function recordMessage(input: {
    runId: string | null;
    telegramMessageId: number;
    kind: string;
    metadata?: unknown;
  }): Promise<void> {
    await db
      .prepare(
        `INSERT INTO telegram_messages (id, run_id, telegram_message_id, chat_id, kind, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        input.runId,
        String(input.telegramMessageId),
        chatId,
        input.kind,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        nowIso(),
      )
      .run();
  }

  return {
    async sendDailyDigest(input: DigestInput) {
      const summary = await client.sendMessage({
        chatId,
        text: renderDigestSummary({
          date: input.date,
          sourcesChecked: input.sourcesChecked,
          discoveredCount: input.discoveredCount,
          newCount: input.newCount,
          eligibleCount: input.eligibleCount,
          matchCount: input.jobs.length,
        }),
      });
      await recordMessage({
        runId: input.runId,
        telegramMessageId: summary.messageId,
        kind: "digest_summary",
        metadata: { matchCount: input.jobs.length },
      });

      for (const [index, scored] of input.jobs.entries()) {
        const card = renderJobCard(index + 1, scored);
        const message = await client.sendMessage({
          chatId,
          text: card.text,
          buttons: card.buttons,
        });
        await recordMessage({
          runId: input.runId,
          telegramMessageId: message.messageId,
          kind: "job_card",
          metadata: { jobId: scored.job.id, score: scored.score.totalScore },
        });
      }
    },

    async sendNoMatchesNotice(input) {
      const message = await client.sendMessage({
        chatId,
        text: renderNoMatches(input),
      });
      await recordMessage({
        runId: input.runId,
        telegramMessageId: message.messageId,
        kind: "no_matches",
      });
    },

    async sendFailureNotification(_input) {
      await client.sendMessage({
        chatId,
        text: "Daily job search failed. No jobs were processed for this run; check the worker logs.",
      });
    },
  };
}
