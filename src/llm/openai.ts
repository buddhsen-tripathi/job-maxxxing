import { AppError, errorMessage } from "../shared/errors";
import { fetchWithTimeout } from "../shared/http";
import type { AnswerQuestionRequest, LlmClient, ScoreJobRequest } from "./client";
import { buildAnswerMessages, buildScoringMessages } from "./prompts";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

async function chatCompletion(
  options: { apiKey: string; model: string; baseUrl: string; fetchImpl: typeof globalThis.fetch },
  messages: { system: string; user: string },
): Promise<unknown> {
  const response = await fetchWithTimeout(
    options.fetchImpl,
    `${options.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
      }),
    },
    30_000,
  );
  if (!response.ok) {
    throw new AppError("llm_http_error", `LLM API returned HTTP ${response.status}`);
  }
  let body: ChatCompletionResponse;
  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch (error) {
    throw new AppError(
      "llm_malformed_response",
      `LLM response was not JSON: ${errorMessage(error)}`,
    );
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new AppError("llm_empty_response", "LLM response contained no message content");
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new AppError(
      "llm_non_json_content",
      `LLM message content was not valid JSON: ${errorMessage(error)}`,
    );
  }
}

export function createOpenAiLlmClient(options: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}): LlmClient {
  const config = {
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
  return {
    model: options.model,
    scoreJob: (request: ScoreJobRequest) =>
      chatCompletion(config, buildScoringMessages(request.job, request.profile)),
    answerQuestion: (request: AnswerQuestionRequest) =>
      chatCompletion(config, buildAnswerMessages(request.question, request.job, request.profile)),
  };
}
