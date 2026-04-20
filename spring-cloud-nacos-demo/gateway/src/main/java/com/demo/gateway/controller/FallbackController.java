package com.demo.gateway.controller;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class FallbackController {
  @GetMapping("/fallback/providerA")
  public Map<String, Object> providerAFallback() {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("code", 503);
    payload.put("msg", "provider-a degraded by gateway circuit breaker");
    payload.put("timestamp", Instant.now().toString());
    return payload;
  }
}
