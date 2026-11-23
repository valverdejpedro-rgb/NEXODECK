# Ayudante de sensores avanzados (se ejecuta como administrador).
# Arranca LibreHardwareMonitor (temperaturas y ventiladores) y PresentMon (FPS),
# y se cierra solo cuando se cierra Centro de Control.
param(
  [int]$ParentPid = 0,
  [string]$ResDir = '',
  [string]$DataDir = ''
)
$ErrorActionPreference = 'SilentlyContinue'
if (-not $DataDir) { exit 1 }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$pidFile  = Join-Path $DataDir 'helper.pid'
$beatFile = Join-Path $DataDir 'heartbeat.txt'
$csv      = Join-Path $DataDir 'fps.csv'

# Evitar dos ayudantes a la vez
if (Test-Path $pidFile) {
  $old = [int](Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($old -gt 0 -and $old -ne $PID) {
    $p = Get-Process -Id $old -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -like 'powershell*') { exit 0 }
  }
}
$PID | Set-Content $pidFile

$lhmDir = Join-Path $ResDir 'lhm'
$lhmExe = Join-Path $lhmDir 'LibreHardwareMonitor.exe'
$pmExe  = Join-Path $ResDir 'PresentMon.exe'

# ---- LibreHardwareMonitor (servidor web local en 127.0.0.1:8085) ----
$lhmProc = $null
if ((Test-Path $lhmExe) -and -not (Get-Process -Name 'LibreHardwareMonitor' -ErrorAction SilentlyContinue)) {
  $cfg = Join-Path $lhmDir 'LibreHardwareMonitor.config'
  @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="startMinMenuItem" value="true" />
    <add key="minTrayMenuItem" value="true" />
    <add key="minCloseMenuItem" value="true" />
    <add key="runWebServerMenuItem" value="true" />
    <add key="listenerPort" value="8085" />
  </appSettings>
</configuration>
'@ | Set-Content -Path $cfg -Encoding UTF8
  $lhmProc = Start-Process -FilePath $lhmExe -WorkingDirectory $lhmDir -WindowStyle Minimized -PassThru
}

# ---- PresentMon (FPS) ----
function Stop-OurPresentMon {
  Get-Process -Name 'PresentMon*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $pmExe } | Stop-Process -Force -ErrorAction SilentlyContinue
}
function Start-OurPresentMon {
  Stop-OurPresentMon
  Start-Sleep -Milliseconds 300
  Remove-Item $csv -Force -ErrorAction SilentlyContinue
  $args = @('--output_file', "`"$csv`"", '--session_name', 'NexoDeckFPS', '--stop_existing_session',
            '--no_console_stats', '--no_track_input', '--no_track_gpu')
  return Start-Process -FilePath $pmExe -ArgumentList $args -WindowStyle Hidden -PassThru
}

$pmProc = $null
$pmStart = Get-Date
if (Test-Path $pmExe) { $pmProc = Start-OurPresentMon; $pmStart = Get-Date }

try {
  while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    (Get-Date).ToString('o') | Set-Content $beatFile
    # PresentMon escribe una fila por cada fotograma: se reinicia cada 20 min para que el archivo no crezca sin límite
    if ((Test-Path $pmExe) -and ((-not $pmProc) -or $pmProc.HasExited -or (((Get-Date) - $pmStart).TotalMinutes -ge 20))) {
      $pmProc = Start-OurPresentMon
      $pmStart = Get-Date
    }
    Start-Sleep -Seconds 2
  }
}
finally {
  Stop-OurPresentMon
  if ($lhmProc -and -not $lhmProc.HasExited) { Stop-Process -Id $lhmProc.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $beatFile, $pidFile, $csv -Force -ErrorAction SilentlyContinue
}
