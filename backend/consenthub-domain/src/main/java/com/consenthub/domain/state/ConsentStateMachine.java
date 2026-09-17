package com.consenthub.domain.state;

import com.consenthub.domain.entities.ConsentStatus;

import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

public final class ConsentStateMachine {
    private final Map<ConsentStatus, Set<ConsentStatus>> transitions = transitions();

    public void assertTransitionAllowed(ConsentStatus current, ConsentStatus next) {
        Set<ConsentStatus> allowed = transitions.get(current);
        if (allowed == null || !allowed.contains(next)) {
            throw new IllegalStateException("Consent cannot transition from " + current + " to " + next);
        }
    }

    private static Map<ConsentStatus, Set<ConsentStatus>> transitions() {
        Map<ConsentStatus, Set<ConsentStatus>> result = new EnumMap<>(ConsentStatus.class);
        result.put(ConsentStatus.REQUESTED, EnumSet.of(ConsentStatus.GRANTED, ConsentStatus.REVOKED));
        result.put(ConsentStatus.GRANTED, EnumSet.of(ConsentStatus.REVOKED));
        result.put(ConsentStatus.REVOKED, EnumSet.noneOf(ConsentStatus.class));
        return Map.copyOf(result);
    }
}
