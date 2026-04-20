package com.demo.providera.controller;

import com.alibaba.nacos.api.config.annotation.NacosValue;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.context.config.annotation.RefreshScope;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RefreshScope
@RestController
@RequestMapping("/api/a")
public class ProviderAController {
  @Value("${demo.message:default-message}")
  private String demoMessage;

  @NacosValue(value = "${demo.threshold:60}", autoRefreshed = true)
  private Integer threshold;

  @GetMapping("/hello")
  public Map<String, Object> hello() {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("service", "provider-a");
    payload.put("msg", "hello from provider-a");
    payload.put("ts", Instant.now().toString());
    return payload;
  }

  @GetMapping("/unstable")
  public Map<String, Object> unstable(@RequestParam(value = "delayMs", defaultValue = "200") int delayMs,
                                      @RequestParam(value = "failRate", defaultValue = "30") int failRate) throws InterruptedException {
    Thread.sleep(Math.max(0, Math.min(delayMs, 5000)));
    int boundFailRate = Math.max(0, Math.min(failRate, 100));
    int lucky = ThreadLocalRandom.current().nextInt(100);
    if (lucky < boundFailRate) {
      throw new RuntimeException("simulated provider-a failure");
    }
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("service", "provider-a");
    payload.put("status", "ok");
    payload.put("delayMs", delayMs);
    payload.put("failRate", boundFailRate);
    return payload;
  }

  @GetMapping("/config")
  public Map<String, Object> config() {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("service", "provider-a");
    payload.put("demo.message", demoMessage);
    payload.put("demo.threshold", threshold);
    payload.put("ts", Instant.now().toString());
    return payload;
  }
}
