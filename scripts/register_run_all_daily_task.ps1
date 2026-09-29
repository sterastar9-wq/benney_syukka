param(
    [string]$TaskName = "GOQ Automation run_all Daily",
    [string]$Time = "00:01",
    [string]$PythonCommand = "python"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $ScriptDir "run_all_task.ps1"

if (-not (Test-Path $Runner)) {
    throw "Runner script not found: $Runner"
}

$ActionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" -PythonCommand `"$PythonCommand`""
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $ActionArgs
$Trigger = New-ScheduledTaskTrigger -Daily -At $Time
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Runs goq_automation run_all.py every day at $Time." `
    -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "Schedule: daily at $Time"
Write-Host "Runner: $Runner"
