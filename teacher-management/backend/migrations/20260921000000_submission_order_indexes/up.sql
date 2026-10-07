CREATE INDEX idx_submissions_submit_time_id ON submissions (submit_time, id);
CREATE INDEX idx_submissions_user_submit_time_id ON submissions (user_id, submit_time, id);
