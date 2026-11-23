# Ayudante de sensores avanzados (se ejecuta como administrador).
# Arranca LibreHardwareMonitor (temperaturas y ventiladores) y PresentMon (FPS),
# y se cierra solo cuando se cierra Centro de Control.
# Deja registros en la carpeta de datos (helper.log, status.json, presentmon.*.log)
# que la app muestra en su panel de Diagnóstico.
param(
  [int]$ParentPid = 0,
  [string]$ResDir = '',
  [string]$DataDir = ''
)
$ErrorActionPreference = 'SilentlyContinue'
if (-not $DataDir) { exit 1 }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$pidFile    = Join-Path $DataDir 'helper.pid'
$beatFile   = Join-Path $DataDir 'heartbeat.txt'
$csv        = Join-Path $DataDir 'fps.csv'
$logFile    = Join-Path $DataDir 'helper.log'
$statusFile = Join-Path $DataDir 'status.json'
$pmOutLog   = Join-Path $DataDir 'presentmon.out.log'
$pmErrLog   = Join-Path $DataDir 'presentmon.err.log'

function Log($msg) {
  try { ('{0} {1}' -f (Get-Date).ToString('s'), $msg) | Add-Content -Path $logFile -Encoding UTF8 } catch {}
}
# Que el registro no crezca sin límite
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 200000)) { Remove-Item $logFile -Force }

# Evitar dos ayudantes a la vez
if (Test-Path $pidFile) {
  $old = [int](Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($old -gt 0 -and $old -ne $PID) {
    $p = Get-Process -Id $old -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -like 'powershell*') { exit 0 }
  }
}
$PID | Set-Content $pidFile
Log "Ayudante iniciado (PID $PID, app PID $ParentPid)"

$lhmDir = Join-Path $ResDir 'lhm'
$lhmExe = Join-Path $lhmDir 'LibreHardwareMonitor.exe'
$pmExe  = Join-Path $ResDir 'PresentMon.exe'
Log "PresentMon.exe existe: $(Test-Path $pmExe) | LibreHardwareMonitor.exe existe: $(Test-Path $lhmExe)"

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
  Log "LibreHardwareMonitor iniciado (PID $($lhmProc.Id))"
} elseif (Get-Process -Name 'LibreHardwareMonitor' -ErrorAction SilentlyContinue) {
  Log 'LibreHardwareMonitor ya estaba abierto; se reutiliza'
}

# ---- PresentMon (FPS) ----
function Stop-OurPresentMon {
  Get-Process -Name 'PresentMon*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $pmExe } | Stop-Process -Force -ErrorAction SilentlyContinue
}
function Start-OurPresentMon {
  Stop-OurPresentMon
  Start-Sleep -Milliseconds 300
  Remove-Item $csv, $pmOutLog, $pmErrLog -Force -ErrorAction SilentlyContinue
  # PresentMon bloquea el archivo que abre con --output_file (la app no podía leerlo: EBUSY).
  # Con --output_stdout el CSV sale por la salida estándar y PowerShell la guarda en fps.csv sin bloquear la lectura.
  $pmArgs = @('--output_stdout', '--session_name', 'NexoDeckFPS', '--stop_existing_session',
              '--no_console_stats', '--no_track_input', '--no_track_gpu')
  $p = Start-Process -FilePath $pmExe -ArgumentList $pmArgs -WindowStyle Hidden -PassThru `
         -RedirectStandardOutput $csv -RedirectStandardError $pmErrLog
  if ($p) { $null = $p.Handle; Log "PresentMon iniciado (PID $($p.Id))" } else { Log 'PresentMon NO pudo iniciarse' }
  return $p
}

$script:pmRestarts = 0
$script:pmLastExit = $null
$pmProc = $null
$pmStart = Get-Date
if (Test-Path $pmExe) { $pmProc = Start-OurPresentMon; $pmStart = Get-Date }

# ---- Ventiladores por WMI de Lenovo (algunos portátiles lo exponen; LibreHardwareMonitor no lee su controlador) ----
$fanFile = Join-Path $DataDir 'fans.json'
$script:fanClass = $null
$script:fanNote = 'sin probar'
try {
  $script:fanClass = Get-CimInstance -Namespace 'root\WMI' -ClassName 'LENOVO_FAN_METHOD' -ErrorAction Stop | Select-Object -First 1
  $script:fanNote = if ($script:fanClass) { 'clase LENOVO_FAN_METHOD encontrada' } else { 'clase LENOVO_FAN_METHOD sin instancias' }
} catch { $script:fanNote = 'clase LENOVO_FAN_METHOD no existe en este equipo' }
Log "Ventiladores WMI: $($script:fanNote)"
function Write-Fans {
  if (-not $script:fanClass) {
    try { (@{ note = $script:fanNote; fans = @() } | ConvertTo-Json -Compress) | Set-Content -Path $fanFile -Encoding UTF8 } catch {}
    return
  }
  $list = @()
  $raw = @()
  foreach ($id in 1, 2) {
    try {
      $r = Invoke-CimMethod -InputObject $script:fanClass -MethodName 'Fan_GetCurrentFanSpeed' -Arguments @{ FanID = [uint32]$id } -ErrorAction Stop
      $props = $r.PSObject.Properties | Where-Object { $_.Name -notmatch '^(ReturnValue|PSComputerName)$' -and $_.Value -is [ValueType] }
      $raw += ("id{0}: " -f $id) + (($r.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ',')
      $v = ($props | Select-Object -First 1).Value
      if ($null -ne $v -and [double]$v -ge 0 -and [double]$v -lt 20000) { $list += @{ name = $(if ($id -eq 1) { 'Ventilador CPU' } else { 'Ventilador GPU' }); rpm = [int]$v } }
    } catch { $raw += "id${id}: error $($_.Exception.Message)" }
  }
  try { (@{ note = $script:fanNote; raw = ($raw -join ' | '); fans = $list } | ConvertTo-Json -Compress -Depth 4) | Set-Content -Path $fanFile -Encoding UTF8 } catch {}
}

function Write-Status {
  $running = [bool]($pmProc -and -not $pmProc.HasExited)
  $st = [ordered]@{
    time       = (Get-Date).ToString('o')
    pmExists   = [bool](Test-Path $pmExe)
    pmRunning  = $running
    pmExitCode = $script:pmLastExit
    pmRestarts = $script:pmRestarts
    lhmExists  = [bool](Test-Path $lhmExe)
    lhmRunning = [bool](Get-Process -Name 'LibreHardwareMonitor' -ErrorAction SilentlyContinue)
  }
  try { ($st | ConvertTo-Json -Compress) | Set-Content -Path $statusFile -Encoding UTF8 } catch {}
}

try {
  while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    (Get-Date).ToString('o') | Set-Content $beatFile

    if (Test-Path $pmExe) {
      $exited = $pmProc -and $pmProc.HasExited
      if ($exited -and $null -eq $script:pmLastExit) {
        $script:pmLastExit = $pmProc.ExitCode
        Log "PresentMon terminó con código $($pmProc.ExitCode)"
      }
      $sinceStart = ((Get-Date) - $pmStart).TotalSeconds
      # Si se cierra solo, se reintenta como máximo cada 15 s (así no se borra el CSV en bucle).
      # PresentMon escribe una fila por fotograma: se reinicia cada 20 min para que el archivo no crezca sin límite.
      if ((-not $pmProc) -or ($exited -and $sinceStart -ge 15) -or ($sinceStart -ge 1200)) {
        $script:pmRestarts++
        $script:pmLastExit = $null
        $pmProc = Start-OurPresentMon
        $pmStart = Get-Date
      }
    }
    Write-Status
    Write-Fans
    Start-Sleep -Seconds 2
  }
}
finally {
  Log 'Ayudante detenido'
  Stop-OurPresentMon
  if ($lhmProc -and -not $lhmProc.HasExited) { Stop-Process -Id $lhmProc.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $beatFile, $pidFile, $csv, $statusFile, $fanFile -Force -ErrorAction SilentlyContinue
}
