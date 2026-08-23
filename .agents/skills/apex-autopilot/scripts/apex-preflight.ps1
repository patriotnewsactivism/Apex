$ErrorActionPreference = "Stop"
$BaseUrl = if ($env:APEX_BASE_URL) { $env:APEX_BASE_URL.TrimEnd('/') } else { "https://apex.donmatthews.live" }
$Token = $env:APEX_ADMIN_TOKEN

function Get-ApexPublic([string]$Path) {
    Write-Host "`n== GET $BaseUrl$Path =="
    Invoke-RestMethod -Method Get -Uri "$BaseUrl$Path" -TimeoutSec 30 | ConvertTo-Json -Depth 12
}

function Get-ApexAuth([string]$Path) {
    if (-not $Token) {
        Write-Host "`n== SKIP $Path (APEX_ADMIN_TOKEN not set) =="
        return
    }
    Write-Host "`n== GET $BaseUrl$Path =="
    $Headers = @{ Authorization = "Bearer $Token" }
    Invoke-RestMethod -Method Get -Uri "$BaseUrl$Path" -Headers $Headers -TimeoutSec 30 | ConvertTo-Json -Depth 12
}

Write-Host "APEX read-only preflight"
Write-Host "Base URL: $BaseUrl"

Get-ApexPublic "/health"
Get-ApexAuth "/api/agents"
Get-ApexAuth "/api/tokens"

Write-Host "`nPreflight complete. Compare /health build.sha with the intended source commit before diagnosing code vs deployment drift."
