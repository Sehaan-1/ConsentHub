package com.consenthub.domain.services;

import com.consenthub.domain.entities.HelloMessage;

public final class HelloService {
    public HelloMessage hello() {
        return new HelloMessage("Hello from ConsentHub", "consenthub-api");
    }
}
