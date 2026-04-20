param(
  [string]$NacosAddr = "127.0.0.1:8848",
  [string]$ConfigDir = "..\\nacos-config"
)

$ErrorActionPreference = "Stop"

$base = Resolve-Path $PSScriptRoot
$configPath = Resolve-Path (Join-Path $base $ConfigDir)
$uri = "http://$NacosAddr/nacos/v1/cs/configs"

Get-ChildItem -Path $configPath -File | ForEach-Object {
  $dataId = $_.Name
  $content = Get-Content -Path $_.FullName -Raw -Encoding UTF8
  $body = @{
    dataId = $dataId
    group = "DEFAULT_GROUP"
    type = "yaml"
    content = $content
  }
  $resp = Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType "application/x-www-form-urlencoded; charset=utf-8"
  Write-Host "Published $dataId => $resp"
}
