-- Add the Workday provider to the ATS board catalog (rebuild for CHECK constraint)
CREATE TABLE ats_boards_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'workday')),
  slug TEXT NOT NULL,
  company_name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'standard' CHECK (tier IN ('priority', 'standard')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sector TEXT,
  last_polled_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, slug)
);

INSERT INTO ats_boards_new SELECT * FROM ats_boards;
DROP TABLE ats_boards;
ALTER TABLE ats_boards_new RENAME TO ats_boards;

CREATE INDEX idx_ats_boards_active_tier_polled
  ON ats_boards (active, tier, last_polled_at);

-- Workday boards: slug encodes host/tenant/site for the CXS API
INSERT INTO ats_boards (id, provider, slug, company_name, tier, active, sector, created_at, updated_at) VALUES
  ('wd-nvidia', 'workday', 'nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite', 'NVIDIA', 'standard', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('wd-salesforce', 'workday', 'salesforce.wd12.myworkdayjobs.com/salesforce/External_Career_Site', 'Salesforce', 'standard', 1, 'saas', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');
