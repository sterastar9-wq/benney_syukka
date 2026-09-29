param(
    [string]$PythonCommand = "python"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Resolve-PythonCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RequestedCommand
    )

    $candidates = New-Object System.Collections.Generic.List[string]

    if ([System.IO.Path]::IsPathRooted($RequestedCommand)) {
        $candidates.Add($RequestedCommand)
    } else {
        try {
            $command = Get-Command $RequestedCommand -ErrorAction Stop
            if ($command.Path) {
                $candidates.Add($command.Path)
            }
        } catch {
        }
    }

    $discoveredPythonPaths = @(
        Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Python") -Filter "python.exe" -Recurse -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -ExpandProperty FullName
    )

    $commonPaths = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python310\python.exe"),
        "C:\Program Files\Python313\python.exe",
        "C:\Program Files\Python312\python.exe",
        "C:\Program Files\Python311\python.exe",
        "C:\Program Files\Python310\python.exe"
    )

    foreach ($path in ($discoveredPythonPaths + $commonPaths)) {
        if (-not [string]::IsNullOrWhiteSpace($path)) {
            $candidates.Add($path)
        }
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not (Test-Path $candidate)) {
            continue
        }

        if ($candidate -like "*\AppData\Local\Microsoft\WindowsApps\*") {
            continue
        }

        return $candidate
    }

    $details = @(
        "Requested Python command: $RequestedCommand",
        "Resolved command was not a usable python.exe.",
        "Windows Store aliases such as C:\Users\<user>\AppData\Local\Microsoft\WindowsApps\python.exe are not supported here.",
        "Provide a real interpreter path, for example:",
        "  powershell -File scripts\run_all_task.ps1 -PythonCommand C:\Path\To\Python\python.exe"
    ) -join [Environment]::NewLine

    throw $details
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $ProjectRoot "logs\scheduled"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$RunId = $Timestamp
$LogFile = Join-Path $LogDir "run_all_$Timestamp.log"
$TargetDate = $env:GOQ_TARGET_DATE
$ResolvedPython = ""
$EscapedPython = ""

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $ProjectRoot

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting run_all.py" | Tee-Object -FilePath $LogFile

try {
    $ResolvedPython = Resolve-PythonCommand -RequestedCommand $PythonCommand
    $EscapedPython = '"' + $ResolvedPython.Replace('"', '""') + '"'
    $EscapedLogFile = '"' + $LogFile.Replace('"', '""') + '"'
    $SafeTargetDate = if ($null -eq $TargetDate) { "" } else { [string]$TargetDate }
    $EscapedTargetDate = '"' + $SafeTargetDate.Replace('"', '""') + '"'
    cmd.exe /d /c "set GOQ_RUN_ID=$RunId&& set GOQ_RUN_TRIGGER=scheduled_task&& set GOQ_RUN_LOG_FILE=$LogFile&& set GOQ_AUTOMATION_ID=goq-run-all-daily-agent&& set GOQ_TARGET_DATE=$SafeTargetDate&& $EscapedPython run_all.py >> $EscapedLogFile 2>&1" | Out-Null
    $ExitCode = $LASTEXITCODE
}
catch {
    $_ | Tee-Object -FilePath $LogFile -Append
    $ExitCode = 1
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Finished with exit code $ExitCode" | Tee-Object -FilePath $LogFile -Append
exit $ExitCode
