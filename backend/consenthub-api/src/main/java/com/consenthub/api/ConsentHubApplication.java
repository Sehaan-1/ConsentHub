package com.consenthub.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(scanBasePackages = "com.consenthub")
@EnableScheduling
public class ConsentHubApplication {
    public static void main(String[] args) {
        SpringApplication.run(ConsentHubApplication.class, args);
    }
}
