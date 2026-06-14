-- Pipeline automation: track when a session has been segmented
ALTER TABLE recording_sessions
  ADD COLUMN IF NOT EXISTS segmented_at TIMESTAMPTZ;
