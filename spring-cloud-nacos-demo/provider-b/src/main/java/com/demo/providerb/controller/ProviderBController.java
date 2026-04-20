package com.demo.providerb.controller;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/b")
public class ProviderBController {
  @GetMapping("/echo")
  public Map<String, Object> echo(@RequestParam(value = "text", defaultValue = "ping") String text) {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("service", "provider-b");
    payload.put("echo", text);
    payload.put("ts", Instant.now().toString());
    return payload;
  }
}
