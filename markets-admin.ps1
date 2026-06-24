# Prediction Markets admin helper.
#
# Reads ADMIN_TOKEN from .env. Targets production by default; override with -BaseUrl.
#
# Usage (from the project root):
#   .\markets-admin.ps1 list
#   .\markets-admin.ps1 create -Question "Will BTC close above $100k on Dec 31?" -Category "Crypto" -Description "Resolves YES if ..."
#   .\markets-admin.ps1 create -Question "..." -ClosesAt "2026-12-31T23:59"   # stop betting at a time
#   .\markets-admin.ps1 close   -Id pm_ab12cd34
#   .\markets-admin.ps1 open    -Id pm_ab12cd34
#   .\markets-admin.ps1 resolve -Id pm_ab12cd34 -Outcome YES     # YES | NO | CANCEL
param(
  [Parameter(Position = 0)]
  [ValidateSet('list', 'create', 'close', 'open', 'resolve')]
  [string]$Action = 'list',

  [string]$Id,
  [string]$Question,
  [string]$Description,
  [string]$Category = 'General',
  [string]$ClosesAt,
  [ValidateSet('manual', 'llm')]
  [string]$Resolver = 'manual',
  [string]$ResolveAt,
  [ValidateSet('YES', 'NO', 'CANCEL')]
  [string]$Outcome,

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

function Show-Markets {
  $data = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/markets"
  if (-not $data.markets -or $data.markets.Count -eq 0) { Write-Host 'No markets yet.'; return }
  foreach ($m in $data.markets) {
    $color = if ($m.status -eq 'resolved') { 'DarkGray' } elseif ($m.status -eq 'open') { 'Green' } else { 'Yellow' }
    Write-Host ("[{0}] {1}" -f $m.status.ToUpper(), $m.question) -ForegroundColor $color
    Write-Host ("    id: {0}  |  category: {1}  |  open offers: {2}  |  matched: {3}" -f `
        $m.id, $m.category, $m.stats.openCount, $m.stats.matchedCount)
    if ($m.outcome) { Write-Host ("    outcome: {0}" -f $m.outcome) -ForegroundColor Cyan }
  }
}

if ($Action -eq 'list') { Show-Markets; return }

$token = Get-AdminToken

switch ($Action) {
  'create' {
    if (-not $Question) { throw 'Provide -Question "..."' }
    $body = @{ token = $token; question = $Question; description = $Description; category = $Category }
    if ($ClosesAt) {
      $ms = [DateTimeOffset]::Parse($ClosesAt).ToUnixTimeMilliseconds()
      $body.closesAt = $ms
    }
    if ($Resolver -eq 'llm') {
      if (-not $ResolveAt) { throw 'For -Resolver llm, provide -ResolveAt "YYYY-MM-DDTHH:MM" (when the agent should settle it from the web)' }
      $rms = [DateTimeOffset]::Parse($ResolveAt).ToUnixTimeMilliseconds()
      $body.auto = @{ provider = 'llm'; resolveAt = $rms; criteria = $Description }
      if (-not $ClosesAt) { $body.closesAt = $rms }
      Write-Host "(LLM-resolved market — the agent will settle it from web sources after $ResolveAt)" -ForegroundColor DarkCyan
    }
    $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/markets" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 6)
    Write-Host "Created market:" -ForegroundColor Green
    Write-Host ("  id: {0}" -f $resp.market.id)
    Write-Host ("  {0}" -f $resp.market.question)
  }
  'close' {
    if (-not $Id) { throw 'Provide -Id pm_xxxxxxxx' }
    $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/markets/$Id/close" -ContentType 'application/json' -Body (@{ token = $token } | ConvertTo-Json)
    Write-Host ("Market {0} is now {1}." -f $resp.market.id, $resp.market.status) -ForegroundColor Yellow
  }
  'open' {
    if (-not $Id) { throw 'Provide -Id pm_xxxxxxxx' }
    $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/markets/$Id/open" -ContentType 'application/json' -Body (@{ token = $token } | ConvertTo-Json)
    Write-Host ("Market {0} is now {1}." -f $resp.market.id, $resp.market.status) -ForegroundColor Green
  }
  'resolve' {
    if (-not $Id) { throw 'Provide -Id pm_xxxxxxxx' }
    if (-not $Outcome) { throw 'Provide -Outcome YES|NO|CANCEL' }
    $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/markets/$Id/resolve" -ContentType 'application/json' -Body (@{ token = $token; outcome = $Outcome } | ConvertTo-Json)
    Write-Host ("Market {0} resolved {1}." -f $resp.market.id, $resp.market.outcome) -ForegroundColor Cyan
    Write-Host ("  paid winners: {0}  |  refunded: {1}  |  house fees: {2}" -f `
        $resp.settlement.paid, $resp.settlement.refunded, $resp.settlement.houseFees)
  }
}
