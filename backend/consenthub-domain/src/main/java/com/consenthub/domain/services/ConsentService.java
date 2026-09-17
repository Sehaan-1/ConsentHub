package com.consenthub.domain.services;

import com.consenthub.domain.entities.Consent;
import com.consenthub.domain.entities.ConsentStatus;
import com.consenthub.domain.state.ConsentStateMachine;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

public final class ConsentService {
    private final ConsentStateMachine stateMachine;
    private final Clock clock;

    public ConsentService(ConsentStateMachine stateMachine, Clock clock) {
        this.stateMachine = stateMachine;
        this.clock = clock;
    }

    public Consent request(String subjectId, String purpose) {
        return new Consent(UUID.randomUUID(), subjectId, purpose, ConsentStatus.REQUESTED, Instant.now(clock));
    }

    public Consent transition(Consent consent, ConsentStatus nextStatus) {
        stateMachine.assertTransitionAllowed(consent.status(), nextStatus);
        return new Consent(consent.id(), consent.subjectId(), consent.purpose(), nextStatus, consent.createdAt());
    }
}
