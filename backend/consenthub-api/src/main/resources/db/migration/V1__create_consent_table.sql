-- Consent records: the system of record for consent artefacts.
-- The append-only audit ledger (ADR-0003) builds on this table in a later
-- milestone; this is the minimal Week 0 shape.
--
-- Kept ANSI-compatible on purpose: the exact same file must apply cleanly on
-- MySQL 8 (docker profile) and on H2 in MySQL mode (local dev profile), so
-- no dialect-specific table options.
CREATE TABLE consent (
    id         CHAR(36)     NOT NULL,
    subject_id VARCHAR(255) NOT NULL,
    purpose    VARCHAR(255) NOT NULL,
    status     VARCHAR(32)  NOT NULL,
    created_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT pk_consent PRIMARY KEY (id)
);

CREATE INDEX idx_consent_subject_id ON consent (subject_id);
CREATE INDEX idx_consent_status ON consent (status);
