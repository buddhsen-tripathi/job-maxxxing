-- Public multi-user: onboarding sessions + per-user job save/skip state

CREATE TABLE user_sessions (
  user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  draft_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE user_job_states (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX idx_user_job_states_user_status ON user_job_states(user_id, status);
CREATE UNIQUE INDEX idx_users_telegram_chat_id ON users(telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;
