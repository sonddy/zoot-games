# House maintenance admin helper.
#
# Usage (from the project root):
#   .\house-admin.ps1 status            # show whether the House is open or closed
#   .\house-admin.ps1 close             # put the House into maintenance
#   .\house-admin.ps1 close "Custom message shown to players"
#   .\house-admin.ps1 open              # reopen the House
#
# Reads ADMIN_TOKEN from .env. Targets production by default; override with -BaseUrl.
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'open', 'close')]
  [string]$Action = 'status',

  [Parameter(Position = 1)]
  [string]$Message,

  [string]$BaseUrl = 'https://zoot-games.onrender.com'
)

$ErrorActionPreference = 'Stop'

function Get-AdminToken {
  $envPath = Join-Path $PSScriptRoot '.env'
  if (-not (Test-Path $envPath)) { throw ".env not found at $envPath" }
  foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*ADMIN_TOKEN\s*=\s*(.+?)\s*$') { return $Matches[1] }
  }
  throw 'ADMIN_TOKEN not found in .env'
}

if ($Action -eq 'status') {
  $resp = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/house/status"
  if ($resp.maintenance) {
    Write-Host "House: CLOSED (maintenance)" -ForegroundColor Yellow
    if ($resp.message) { Write-Host "Message: $($resp.message)" }
  } else {
    Write-Host "House: OPEN" -ForegroundColor Green
  }
  return
}

$token = Get-AdminToken
$body = @{ token = $token; on = ($Action -eq 'close') }
if ($Message) { $body.message = $Message }

$resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/house/maintenance" `
  -ContentType 'application/json' -Body ($body | ConvertTo-Json)

if ($resp.maintenance) {
  Write-Host "House is now CLOSED (maintenance)." -ForegroundColor Yellow
  if ($resp.message) { Write-Host "Players will see: $($resp.message)" }
} else {
  Write-Host "House is now OPEN." -ForegroundColor Green
}
