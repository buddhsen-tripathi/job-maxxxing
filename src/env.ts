export interface Env {
  DB: D1Database;
  JOB_SEARCH_WORKFLOW?: Workflow;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_CHAT_ID?: string;

  LLM_API_KEY?: string;
  LLM_MODEL?: string;

  APP_BASE_URL: string;
  ENVIRONMENT: "development" | "production";

  ADMIN_TOKEN?: string;
  SOURCES_JSON?: string;
  CANDIDATE_PROFILE_JSON?: string;
}
