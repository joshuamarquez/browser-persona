-- Dev seed: one user for local testing
INSERT INTO users (id, email)
VALUES ('00000000-0000-0000-0000-000000000001', 'dev@localhost')
ON CONFLICT (id) DO NOTHING;

INSERT INTO recording_policies (user_id, enabled, allowed_domains)
VALUES ('00000000-0000-0000-0000-000000000001', true, '{}')
ON CONFLICT (user_id) DO NOTHING;
