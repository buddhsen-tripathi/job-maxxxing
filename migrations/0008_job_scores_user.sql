-- Scope LLM scores per user (public multi-user digests)
ALTER TABLE job_scores ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_job_scores_job_user ON job_scores(job_id, user_id, created_at);
