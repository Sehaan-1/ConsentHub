package com.consenthub.domain.entities;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

public record Consent(UUID id, String subjectId, String purpose, ConsentStatus status, Instant createdAt) {
    public Consent {
        Objects.requireNonNull(id, "id must not be null");
        Objects.requireNonNull(subjectId, "subjectId must not be null");
        Objects.requireNonNull(purpose, "purpose must not be null");
        Objects.requireNonNull(status, "status must not be null");
        Objects.requireNonNull(createdAt, "createdAt must not be null");
    }
}
