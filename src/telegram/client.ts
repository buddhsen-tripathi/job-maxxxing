import { AppError } from "../shared/errors";
import { fetchWithTimeout } from "../shared/http";

export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface TelegramClient {
  sendMessage(input: {
    chatId: string;
    text: string;
    buttons?: InlineButton[][];
  }): Promise<{ messageId: number }>;
  editMessageText(input: {
    chatId: string;
    messageId: number;
    text: string;
    buttons?: InlineButton[][];
  }): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

function toReplyMarkup(buttons: InlineButton[][] | undefined) {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => {
        if (button.url) return { text: button.text, url: button.url };
        return { text: button.text, callback_data: button.callbackData };
      }),
    ),
  };
}

export function createTelegramClient(options: {
  token: string;
  fetchImpl?: typeof globalThis.fetch;
}): TelegramClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = `https://api.telegram.org/bot${options.token}`;

  async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new AppError(
        "telegram_api_error",
        `Telegram ${method} returned HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!body.ok) {
      throw new AppError(
        "telegram_api_error",
        `Telegram ${method} failed: ${body.description ?? "unknown error"}`,
      );
    }
    return body.result;
  }

  return {
    async sendMessage({ chatId, text, buttons }) {
      const result = (await call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: toReplyMarkup(buttons),
      })) as { message_id: number };
      return { messageId: result.message_id };
    },
    async editMessageText({ chatId, messageId, text, buttons }) {
      await call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: toReplyMarkup(buttons),
      });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    },
  };
}
