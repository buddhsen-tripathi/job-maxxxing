export type RunStatus = "running" | "completed" | "failed";

export type JobStatus =
  | "discovered"
  | "eligible"
  | "scored"
  | "shortlisted"
  | "skipped"
  | "blocked"
  | "rejected_by_filter"
  | "scoring_failed";

export type ApplicationStatus =
  | "preparing"
  | "prepared"
  | "awaiting_review"
  | "approved"
  | "submitting"
  | "submitted"
  | "preparation_failed"
  | "submission_blocked"
  | "submission_failed";

export type ScoreRecommendation = "strong_match" | "review" | "skip";

export interface RunRow {
  id: string;
  trigger_type: string;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  discovered_count: number;
  new_count: number;
  eligible_count: number;
  shortlisted_count: number;
  error: string | null;
}

export interface JobRow {
  id: string;
  fingerprint: string;
  source: string;
  source_job_id: string | null;
  company: string;
  title: string;
  location: string | null;
  employment_type: string | null;
  workplace_type: string | null;
  description: string;
  apply_url: string;
  canonical_url: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  posted_at: string | null;
  discovered_at: string;
  last_seen_at: string;
  raw_payload: string | null;
  status: JobStatus;
}

export interface JobScoreRow {
  id: string;
  job_id: string;
  user_id: string;
  model: string;
  total_score: number;
  technical_score: number;
  experience_score: number;
  domain_score: number;
  location_score: number;
  evidence_score: number;
  recommendation: ScoreRecommendation;
  reasons_json: string;
  risks_json: string;
  evidence_json: string;
  created_at: string;
}

export interface JobActionRow {
  id: string;
  job_id: string;
  action: string;
  source: string;
  metadata_json: string | null;
  created_at: string;
}

export interface BlockedCompanyRow {
  normalized_company: string;
  display_name: string;
  reason: string | null;
  created_at: string;
}

export interface ApplicationRow {
  id: string;
  user_id: string;
  job_id: string;
  status: ApplicationStatus;
  resume_variant: string | null;
  cover_letter: string | null;
  prepared_answers_json: string | null;
  unresolved_questions_json: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  submission_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramMessageRow {
  id: string;
  run_id: string | null;
  telegram_message_id: string;
  chat_id: string;
  kind: string;
  metadata_json: string | null;
  created_at: string;
}

export interface AuditEventRow {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

export type AtsProvider = "greenhouse" | "lever" | "ashby" | "workday";
export type AtsBoardTier = "priority" | "standard";

export interface AtsBoardRow {
  id: string;
  provider: AtsProvider;
  slug: string;
  company_name: string;
  tier: AtsBoardTier;
  active: number;
  sector: string | null;
  last_polled_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  display_name: string | null;
  telegram_chat_id: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface UserProfileRow {
  user_id: string;
  profile_json: string;
  updated_at: string;
}

export type UserSessionState =
  | "awaiting_resume"
  | "ask_titles"
  | "ask_locations"
  | "ask_workplace"
  | "ask_salary"
  | "ask_authorization"
  | "ready"
  | "applying_ask"
  | "applying_confirm"
  | "applying_resume";

export interface UserResumeRow {
  user_id: string;
  r2_key: string;
  content_type: string;
  file_name: string;
  updated_at: string;
}

export interface UserSessionRow {
  user_id: string;
  state: string;
  draft_json: string | null;
  updated_at: string;
}

export type UserJobStatus = "shortlisted" | "skipped";

export interface UserJobStateRow {
  user_id: string;
  job_id: string;
  status: string;
  updated_at: string;
}
