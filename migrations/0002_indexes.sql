CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_company ON jobs(company);
CREATE INDEX idx_jobs_discovered_at ON jobs(discovered_at);
CREATE INDEX idx_jobs_posted_at ON jobs(posted_at);
CREATE INDEX idx_job_scores_job_id ON job_scores(job_id);
CREATE INDEX idx_job_scores_total_score ON job_scores(total_score);
CREATE INDEX idx_job_actions_job_id_action ON job_actions(job_id, action);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
