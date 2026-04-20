# Spring Cloud Nacos Demo

## Scope
- Nacos service registry
- Nacos config management with runtime refresh
- Spring Cloud Gateway dynamic routing (`lb://service-name`)
- Traffic governance on gateway:
  - rate limiting (Redis token bucket)
  - circuit breaker fallback (Resilience4j)
- JMeter pressure test for rate limiting effect

## Modules
- `gateway`: port `19080`
- `provider-a`: port `19091`

## Start dependencies
```powershell
docker compose -f .\docker-compose.nacos.yml up -d
```

## Publish initial Nacos configs
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-nacos-config.ps1
```

## Build
```powershell
mvn -q -DskipTests package
```

## Run services (3 terminals)
```powershell
$env:NACOS_ADDR="127.0.0.1:8848"; $env:REDIS_HOST="127.0.0.1"; java -jar .\gateway\target\gateway-1.0.0.jar
```
```powershell
$env:NACOS_ADDR="127.0.0.1:8848"; java -jar .\provider-a\target\provider-a-1.0.0.jar
```

## Functional verification
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1
```

## JMeter pressure test
```powershell
jmeter -n -t .\jmeter\gateway-rate-limit.jmx -l .\jmeter\rate-limit-result.jtl
```

Expected:
- high concurrency requests to `/api/a/hello` should include `429` due to gateway rate limit.
- when hitting `/api/a/unstable` with high failure and long latency, gateway should return fallback payload.
