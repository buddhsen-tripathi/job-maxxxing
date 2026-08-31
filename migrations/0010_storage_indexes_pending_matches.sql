-- Queue newly discovered jobs so match/notify can continue on a later tick
-- if ingest hits the cron wall clock.
CREATE TABLE pending_matches (
  job_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX idx_pending_matches_created ON pending_matches (created_at);

-- Hot lookup paths that were scanning 40k+ job rows.
CREATE INDEX idx_jobs_canonical_url ON jobs (canonical_url);
CREATE INDEX idx_jobs_source_discovered ON jobs (source, discovered_at);
CREATE INDEX idx_jobs_status_discovered ON jobs (status, discovered_at);
CREATE INDEX idx_runs_status_started ON runs (status, started_at);
CREATE INDEX idx_ats_boards_active_provider_polled
  ON ats_boards (active, provider, last_polled_at);

-- ATS JSON blobs, oversized descriptions, and per-user filter audit rows
-- dominate D1 size and are unused at query time.
UPDATE jobs SET raw_payload = NULL WHERE raw_payload IS NOT NULL;
UPDATE jobs SET description = substr(description, 1, 12000) WHERE length(description) > 12000;

DELETE FROM job_actions
 WHERE source = 'system'
   AND action IN ('filter_passed', 'filter_rejected');

-- Ingest now uses a single mutex row instead of a 3-hour slot key.
DELETE FROM run_locks;

UPDATE runs
   SET status = 'failed',
       completed_at = datetime('now'),
       error = 'stale_running'
 WHERE status = 'running';
