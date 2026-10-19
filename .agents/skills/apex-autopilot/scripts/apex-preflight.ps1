<#
.SYNOPSIS
Zero-token local task gate. Use -Diagnostics for the existing health checks.
Exit codes: 0 work ready; 10 no work; 20 lock active; 1 preflight error.
#>
param(
    [ValidateRange(1, 2147483647)]
    [int]$StaleLockMinutes = 30,
    [switch]$Diagnostics
)

$ErrorActionPreference = "Stop"

function Write-WakeupMetric {
    param([string]$Status, [int]$ExitCode, [string]$Detail)
    $Timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $LogLine = "$Timestamp | status=$Status | exit_code=$ExitCode | detail=$Detail"
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($LogLine + [Environment]::NewLine)
    $Deadline = (Get-Date).AddSeconds(5)
    while ($true) {
        try {
            # Only one writer at a time; readers may inspect metrics concurrently.
            $Stream = [System.IO.File]::Open($MetricsLog, 'Append', 'Write', 'Read')
            break
        }
        catch [System.IO.IOException] {
            if ((Get-Date) -ge $Deadline) { throw }
            Start-Sleep -Milliseconds 50
        }
    }
    try { $Stream.Write($Bytes, 0, $Bytes.Length) }
    finally { $Stream.Dispose() }
    Write-Host "[APEX Preflight] $LogLine"
}

function Test-HasOpenMarkdownTasks {
    param([string[]]$FilePaths)
    foreach ($FilePath in $FilePaths) {
        if (-not (Test-Path -LiteralPath $FilePath)) { continue }
        $FenceChar = $null
        $FenceLength = 0
        foreach ($Line in (Get-Content -LiteralPath $FilePath -Encoding UTF8)) {
            if ($null -ne $FenceChar) {
                # A shorter fence, a different fence character, or trailing text
                # does not close a fenced code block.
                $ClosingFence = '^ {0,3}' + [regex]::Escape($FenceChar) + '{' + $FenceLength + ',}\s*$'
                if ($Line -match $ClosingFence) { $FenceChar = $null }
                continue
            }
            if ($Line -match '^ {0,3}(`{3,}|~{3,})(.*)$') {
                $Fence = $Matches[1]
                $Info = $Matches[2]
                if ($Fence[0] -eq [char]96 -and $Info.Contains('`')) { continue }
                $FenceChar = [string]$Fence[0]
                $FenceLength = $Fence.Length
                continue
            }
            if ($Line -match '^\s*[-*+]\s+\[ \]\s+\S') { return $true }
        }
    }
    return $false
}

if (-not $Diagnostics) {
    try {
        $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path
        $ApexStateDir = Join-Path $RepoRoot '.apex'
        [System.IO.Directory]::CreateDirectory($ApexStateDir) | Out-Null
        $MetricsLog = Join-Path $ApexStateDir 'wakeup_metrics.log'
        $LockFile = Join-Path $RepoRoot '.ninja-git.lock'
        if (Test-Path -LiteralPath $LockFile) {
            $Lock = Get-Item -LiteralPath $LockFile -Force
            $LockAgeMinutes = ((Get-Date).ToUniversalTime() - $Lock.LastWriteTimeUtc).TotalMinutes
            $RunningGit = Get-Process -Name git -ErrorAction SilentlyContinue
            if ($RunningGit -or $LockAgeMinutes -lt $StaleLockMinutes) {
                Write-WakeupMetric 'GIT_LOCKED' 20 'Git process running or lock file is recent; lock preserved.'
                exit 20
            }
            if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
                # Preserve the lock inode on every platform. Deleting an old
                # path can race a refresh/replacement by its real owner.
                try {
                    $Handle = [System.IO.FileStream]::new(
                        $LockFile, [System.IO.FileMode]::Open,
                        [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None
                    )
                    try {
                        $CurrentAge = ((Get-Date).ToUniversalTime() - [System.IO.File]::GetLastWriteTimeUtc($LockFile)).TotalMinutes
                        if ($CurrentAge -lt $StaleLockMinutes) {
                            Write-WakeupMetric 'GIT_LOCKED' 20 'Lock refreshed during inspection; preserved.'
                            exit 20
                        }
                    }
                    finally { $Handle.Dispose() }
                }
                catch [System.IO.IOException] {
                    Write-WakeupMetric 'GIT_LOCKED' 20 'Lock is held or changed during inspection; preserved.'
                    exit 20
                }
            }
            else {
                # flock users keep a persistent inode even when idle. Never
                # unlink it: that would let two processes lock different inodes.
                $Flock = Get-Command flock -ErrorAction SilentlyContinue
                if (-not $Flock) {
                    Write-WakeupMetric 'GIT_LOCKED' 20 'Cannot inspect advisory lock without flock; preserved.'
                    exit 20
                }
                & $Flock.Source --nonblock -- $LockFile true
                if ($LASTEXITCODE -ne 0) {
                    Write-WakeupMetric 'GIT_LOCKED' 20 'Advisory lock held or probe failed; preserved.'
                    exit 20
                }
            }
            Write-Host '[APEX Preflight] Stale idle lock permits work; lock file preserved.'
        }
        $TaskFiles = @((Join-Path $RepoRoot 'PLAN.md'), (Join-Path $RepoRoot 'CHECKLIST.md'))
        if (-not (Test-HasOpenMarkdownTasks $TaskFiles)) {
            Write-WakeupMetric 'NO_WORK' 10 'No open tasks found outside code fences.'
            exit 10
        }
        Write-WakeupMetric 'WORK_READY' 0 'Open tasks verified.'
        exit 0
    }
    catch {
        [Console]::Error.WriteLine("[APEX Preflight] ERROR: $($_.Exception.Message)")
        exit 1
    }
}

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
Get-ApexAuth "/api/health/detail"
Get-ApexAuth "/api/agents"
Get-ApexAuth "/api/tokens"

Write-Host "`nPreflight complete. Compare /health build.sha with the intended source commit. Queue, capacity, spend, and worker detail are on authenticated GET /api/health/detail."
