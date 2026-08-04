import type { AnswerQuestionRequest, LlmClient, ScoreJobRequest } from "./client";
import { createOpenAiCompatibleClient } from "./openai";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function createOpenRouterLlmClient(options: {
  apiKey: string;
  model: string;
  /** Used as OpenRouter HTTP-Referer for rankings / attribution. */
  siteUrl?: string;
  siteName?: string;
  fetchImpl?: typeof globalThis.fetch;
}): LlmClient {
  const headers: Record<string, string> = {
    "X-Title": options.siteName ?? "job-maxxing",
  };
  if (options.siteUrl) {
    headers["HTTP-Referer"] = options.siteUrl;
  }

  return createOpenAiCompatibleClient({
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: OPENROUTER_BASE_URL,
    headers,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

export type { AnswerQuestionRequest, ScoreJobRequest };
