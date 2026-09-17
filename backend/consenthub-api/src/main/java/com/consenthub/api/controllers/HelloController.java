package com.consenthub.api.controllers;

import com.consenthub.domain.entities.HelloMessage;
import com.consenthub.domain.services.HelloService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public final class HelloController {
    private final HelloService helloService;

    public HelloController(HelloService helloService) {
        this.helloService = helloService;
    }

    @GetMapping("/hello")
    public HelloMessage hello() {
        return helloService.hello();
    }
}
