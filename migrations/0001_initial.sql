CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  shortlisted_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_job_id TEXT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  employment_type TEXT,
  workplace_type TEXT,
  description TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  salary_min REAL,
  salary_max REAL,
  salary_currency TEXT,
  posted_at TEXT,
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  raw_payload TEXT,
  status TEXT NOT NULL DEFAULT 'discovered'
);

CREATE TABLE job_scores (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  model TEXT NOT NULL,
  total_score INTEGER NOT NULL,
  technical_score INTEGER NOT NULL,
  experience_score INTEGER NOT NULL,
  domain_score INTEGER NOT NULL,
  location_score INTEGER NOT NULL,
  evidence_score INTEGER NOT NULL,
  recommendation TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE job_actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  action TEXT NOT NULL,
  source TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE blocked_companies (
  normalized_company TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
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
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE telegram_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  telegram_message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
