-- Store resume object metadata (bytes live in R2). Independent of profile_json
-- so a file can be saved as soon as onboarding receives a PDF/URL.
CREATE TABLE user_resumes (
  user_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Applications are per user, not global per job.
CREATE TABLE applications_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  resume_variant TEXT,
  cover_letter TEXT,
  prepared_answers_json TEXT,
  unresolved_questions_json TEXT,
  approved_at TEXT,
  submitted_at TEXT,
  submission_reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, job_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

INSERT INTO applications_new (
  id, user_id, job_id, status, resume_variant, cover_letter,
  prepared_answers_json, unresolved_questions_json, approved_at, submitted_at,
  submission_reference, created_at, updated_at
)
SELECT
  id, 'default', job_id, status, resume_variant, cover_letter,
  prepared_answers_json, unresolved_questions_json, approved_at, submitted_at,
  submission_reference, created_at, updated_at
FROM applications;

DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;

CREATE INDEX idx_applications_user_status ON applications(user_id, status);
CREATE INDEX idx_applications_job ON applications(job_id);
