package com.consenthub.infra.jobs;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public final class ScheduledJobs {
    @Scheduled(cron = "${consenthub.jobs.audit-cleanup-cron:0 0 3 * * *}")
    public void runDailyMaintenance() {
        // Maintenance jobs will be added without changing the API module.
    }
}
