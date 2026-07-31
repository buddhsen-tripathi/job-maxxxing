import { AppError } from "./errors";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 1;
  const baseDelayMs = options.baseDelayMs ?? 250;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = options.shouldRetry ? options.shouldRetry(error) : true;
      if (!retryable || attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AppError("retry_exhausted", "Operation failed after retries", lastError);
}
