param(
  [string]$Branch = "main",
  [int]$IntervalSeconds = 20
)

$ErrorActionPreference = "Stop"

function Get-TrackedBranch {
  param([string]$PreferredBranch)

  $remoteBranch = "origin/$PreferredBranch"
  git rev-parse --verify $remoteBranch *> $null

  if ($LASTEXITCODE -eq 0) {
    return $remoteBranch
  }

  return $null
}

while ($true) {
  Clear-Host
  Write-Host "SMITE 2 remote watcher" -ForegroundColor Cyan
  Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
  Write-Host ""

  git fetch --all --prune
  Write-Host "Working tree:" -ForegroundColor Yellow
  git status --short --branch
  Write-Host ""

  $trackedBranch = Get-TrackedBranch -PreferredBranch $Branch

  if (-not $trackedBranch) {
    Write-Host "No tracked remote branch found for origin/$Branch yet." -ForegroundColor Yellow
    Write-Host "Add a remote and push the branch before using this watcher for incoming commits." -ForegroundColor DarkGray
  }
  else {
    $incoming = git log --oneline HEAD..$trackedBranch

    if ([string]::IsNullOrWhiteSpace(($incoming | Out-String))) {
      Write-Host "No incoming commits on $trackedBranch." -ForegroundColor Green
    }
    else {
      Write-Host "Incoming commits on $trackedBranch:" -ForegroundColor Magenta
      $incoming
    }
  }

  Write-Host ""
  Write-Host "Sleeping for $IntervalSeconds seconds. Press Ctrl+C to stop." -ForegroundColor DarkGray
  Start-Sleep -Seconds $IntervalSeconds
}
