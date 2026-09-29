$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repo
$env:GOQ_HOST_WORKSPACE = $repo.Path

$docker = (Get-Command docker -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $docker) {
  $candidate = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
  if (Test-Path $candidate) {
    $docker = $candidate
  }
}

if (-not $docker) {
  throw 'Docker CLI was not found. Install Docker Desktop or add docker.exe to PATH.'
}

function Test-DockerReady {
  & $docker info *> $null
  return $LASTEXITCODE -eq 0
}

if (-not (Test-DockerReady)) {
  $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktop) {
    Write-Host 'Starting Docker Desktop...'
    Start-Process -FilePath $desktop | Out-Null
  }

  Write-Host 'Waiting for Docker engine...'
  $deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (Test-DockerReady) {
      break
    }
  }
}

if (-not (Test-DockerReady)) {
  throw 'Docker engine did not become ready. Open Docker Desktop and check its status.'
}

Write-Host 'Building GoQ automation image...'
& $docker compose build
if ($LASTEXITCODE -ne 0) {
  throw "docker compose build failed with exit code $LASTEXITCODE."
}

Write-Host 'Starting GoQ automation container...'
& $docker compose up -d goq
if ($LASTEXITCODE -ne 0) {
  throw "docker compose up failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host 'GoQ Docker environment is running.'
Write-Host 'Useful commands:'
Write-Host '  docker compose exec goq npm run goq:print -- --status sagawa --port 9223 --execute'
Write-Host '  docker compose exec goq npm run goq:review'
Write-Host '  docker compose exec goq node tools/cdp-eval.mjs 9223 "location.href"'
Write-Host '  docker compose exec goq sh'
