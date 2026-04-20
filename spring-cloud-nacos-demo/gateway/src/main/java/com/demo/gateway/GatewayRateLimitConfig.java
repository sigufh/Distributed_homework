package com.demo.gateway;

import java.net.InetSocketAddress;
import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import reactor.core.publisher.Mono;

@Configuration
public class GatewayRateLimitConfig {
  @Bean
  public KeyResolver ipKeyResolver() {
    return exchange -> {
      InetSocketAddress remoteAddress = exchange.getRequest().getRemoteAddress();
      String ip = remoteAddress == null ? "unknown" : remoteAddress.getAddress().getHostAddress();
      return Mono.just(ip);
    };
  }
}
