# GoQ / ヤマトビジネスメンバーズ 自動化用の Chrome を、リモートデバッグ付きで起動する。
# 普段使いの Chrome プロファイルとは分けるため、リポジトリ直下の .chrome-goq を使う（Git には入らない）。
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-chrome-cdp.ps1            # ポート 9223
#   powershell -ExecutionPolicy Bypass -File scripts\start-chrome-cdp.ps1 -Port 9222
#   powershell -ExecutionPolicy Bypass -File scripts\start-chrome-cdp.ps1 -Url "https://order.goqsystem.com/goq21/dashboard/"
param(
    [int]$Port = 9223,
    [string]$Url = "about:blank",
    [string]$ProfileDir = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $ProfileDir) { $ProfileDir = Join-Path $repo ".chrome-goq" }

$candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
)
$chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) { throw "chrome.exe が見つかりません" }

try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    Write-Host "ポート $Port で既に Chrome が動いています: $($version.Browser)"
    exit 0
} catch {
    # 未起動なので起動する
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
$args = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=TranslateUI",
    "--lang=ja",
    $Url
)
Start-Process -FilePath $chrome -ArgumentList $args | Out-Null

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        Write-Host "Chrome を起動しました (port $Port): $($version.Browser)"
        Write-Host "プロファイル: $ProfileDir"
        exit 0
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
throw "Chrome がポート $Port で応答しません"
