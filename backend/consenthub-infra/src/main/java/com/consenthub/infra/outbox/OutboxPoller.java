package com.consenthub.infra.outbox;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public final class OutboxPoller {
    @Scheduled(fixedDelayString = "${consenthub.outbox.poll-delay-ms:5000}")
    public void publishPendingEvents() {
        // The durable outbox adapter is introduced with persistence. Keeping the
        // poller here gives the API a single place to schedule delivery retries.
    }
}
