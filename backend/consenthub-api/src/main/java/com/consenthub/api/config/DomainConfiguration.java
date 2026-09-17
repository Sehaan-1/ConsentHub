package com.consenthub.api.config;

import com.consenthub.domain.services.HelloService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class DomainConfiguration {
    @Bean
    public HelloService helloService() {
        return new HelloService();
    }
}
