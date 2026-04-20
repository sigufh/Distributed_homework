param(
  [string]$NacosAddr = "127.0.0.1:8848",
  [string]$GatewayBase = "http://127.0.0.1:19080"
)

$ErrorActionPreference = "Stop"

Write-Host "1) Test dynamic routing via gateway"
Invoke-RestMethod -Uri "$GatewayBase/api/a/hello" -Method Get | ConvertTo-Json -Depth 6

 Write-Host "2) Query provider-a config through gateway"
Invoke-RestMethod -Uri "$GatewayBase/api/a/config" -Method Get | ConvertTo-Json -Depth 6

Write-Host "3) Update nacos config (provider-a.yaml)"
$newContent = @"
demo:
  message: "provider-a message updated at $(Get-Date -Format s)"
  threshold: 88
"@
$publishBody = @{
  dataId = "provider-a.yaml"
  group = "DEFAULT_GROUP"
  type = "yaml"
  content = $newContent
}
Invoke-RestMethod -Method Post -Uri "http://$NacosAddr/nacos/v1/cs/configs" -Body $publishBody -ContentType "application/x-www-form-urlencoded; charset=utf-8" | Out-Null
Start-Sleep -Seconds 3

Write-Host "4) Query provider-a config again (expect updated message)"
Invoke-RestMethod -Uri "$GatewayBase/api/a/config" -Method Get | ConvertTo-Json -Depth 6

Write-Host "5) Trigger unstable endpoint to observe circuit breaker/fallback"
1..20 | ForEach-Object {
  try {
    Invoke-RestMethod -Uri "$GatewayBase/api/a/unstable?delayMs=1200&failRate=100" -Method Get -TimeoutSec 3 | Out-Null
    Write-Host "Call $_ => success"
  } catch {
    $raw = $_.ErrorDetails.Message
    if ($raw) {
      Write-Host "Call $_ => $raw"
    } else {
      Write-Host "Call $_ => failed"
    }
  }
}
