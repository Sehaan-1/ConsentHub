package com.consenthub.infra.repositories;

import com.consenthub.domain.entities.Consent;

import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

public final class InMemoryConsentRepository {
    private final ConcurrentMap<UUID, Consent> consents = new ConcurrentHashMap<>();

    public Consent save(Consent consent) {
        consents.put(consent.id(), consent);
        return consent;
    }

    public Optional<Consent> findById(UUID id) {
        return Optional.ofNullable(consents.get(id));
    }
}
