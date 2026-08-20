export interface Env {
  DB: D1Database;
  RESUMES: R2Bucket;
  JOB_SEARCH_WORKFLOW?: Workflow;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_CHAT_ID?: string;

  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;

  APP_BASE_URL: string;
  ENVIRONMENT: "development" | "production";

  ADMIN_TOKEN?: string;
  SOURCES_JSON?: string;
  CANDIDATE_PROFILE_JSON?: string;

  SCORE_STRONG_MATCH_THRESHOLD?: string;
  SCORE_REVIEW_THRESHOLD?: string;
  /** Max jobs LLM-scored per user per cron tick (default 20). */
  SCORE_CAP_PER_USER?: string;

  /** Boards polled per cron tick (default 48). */
  BOARD_INGEST_BATCH_SIZE?: string;
  /** Max priority boards reserved each tick (default 16). */
  BOARD_PRIORITY_CAP?: string;
}
