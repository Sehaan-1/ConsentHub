-- Demo consent records applied once, on first boot, by Flyway (which never
-- re-applies a migration). Same deterministic data in local dev (H2) and in
-- the docker stack (MySQL), so a reviewer sees an already-seeded system.
INSERT INTO consent (id, subject_id, purpose, status, created_at)
VALUES
    ('0f8fad5b-9f5e-4b21-8c01-2f0a3c4d5e6f', 'customer-001', 'marketing-emails', 'GRANTED', TIMESTAMP '2026-09-01 09:00:00.000'),
    ('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'customer-001', 'third-party-analytics', 'REQUESTED', TIMESTAMP '2026-09-10 14:30:00.000'),
    ('2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', 'customer-002', 'service-communications', 'REVOKED', TIMESTAMP '2026-09-12 18:45:00.000');
