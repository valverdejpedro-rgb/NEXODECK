# Ayudante de audífonos Corsair (no necesita administrador).
# Se conecta a iCUE con el SDK oficial, lee el preset de ecualizador y la batería del audífono
# y los deja en estado.json para que Centro de Control los muestre. Se cierra solo cuando se cierra la app.
param(
  [int]$ParentPid = 0,
  [string]$DllPath = '',
  [string]$DataDir = ''
)
$ErrorActionPreference = 'SilentlyContinue'
if (-not $DataDir -or -not (Test-Path $DllPath)) { exit 1 }
if (-not [Environment]::Is64BitProcess) { exit 1 }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$stateFile = Join-Path $DataDir 'estado.json'

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CUE {
  const string D = "DLLNAME";
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr LoadLibraryW(string p);
  public delegate void StateCb(IntPtr ctx, IntPtr data);
  public static volatile int State = 0;
  public static StateCb Cb = delegate(IntPtr c, IntPtr d) { if (d != IntPtr.Zero) State = Marshal.ReadInt32(d); };
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int CorsairConnect(StateCb cb, IntPtr ctx);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int CorsairDisconnect();
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int CorsairGetDevices(ref int filter, int sizeMax, IntPtr devices, out int size);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int CorsairReadDeviceProperty(byte[] id, int prop, uint index, IntPtr p);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int CorsairFreeProperty(IntPtr p);
  public static int Connect() { return CorsairConnect(Cb, IntPtr.Zero); }
  public static void Disconnect() { CorsairDisconnect(); }
  static string Str(byte[] a, int off, int len) {
    int n = 0; while (n < len && a[off + n] != 0) n++;
    return Encoding.UTF8.GetString(a, off, n);
  }
  public static string[] Devices(int mask) {
    const int SZ = 396, MAX = 64;
    IntPtr b = Marshal.AllocHGlobal(SZ * MAX);
    try {
      for (int i = 0; i < SZ * MAX; i += 4) Marshal.WriteInt32(b, i, 0);
      int size; int f = mask;
      int e = CorsairGetDevices(ref f, MAX, b, out size);
      if (e != 0) return new string[0];
      string[] r = new string[size];
      for (int i = 0; i < size; i++) {
        byte[] raw = new byte[SZ]; Marshal.Copy(IntPtr.Add(b, i * SZ), raw, 0, SZ);
        r[i] = BitConverter.ToInt32(raw, 0) + "|" + Str(raw, 4, 128) + "|" + Str(raw, 260, 128);
      }
      return r;
    } finally { Marshal.FreeHGlobal(b); }
  }
  static byte[] Id(string s) { byte[] a = new byte[128]; byte[] t = Encoding.UTF8.GetBytes(s); Array.Copy(t, a, Math.Min(t.Length, 127)); return a; }
  // Lee una propiedad entera. Devuelve "error|valor"
  public static string ReadInt(string id, int prop) {
    IntPtr p = Marshal.AllocHGlobal(24);
    try {
      Marshal.WriteInt64(p, 0, 0); Marshal.WriteInt64(p, 8, 0); Marshal.WriteInt64(p, 16, 0);
      int e = CorsairReadDeviceProperty(Id(id), prop, 0, p);
      string v = "";
      if (e == 0) { v = Marshal.ReadInt32(p, 8).ToString(); CorsairFreeProperty(p); }
      return e + "|" + v;
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@ -replace 'DLLNAME', ([IO.Path]::GetFileName($DllPath))

try {
  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
  [void][CUE]::LoadLibraryW($DllPath)
  [void][CUE]::Connect()
} catch { exit 1 }

try {
  while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    $o = [ordered]@{ time = (Get-Date).ToString('o'); connected = ([CUE]::State -eq 6); headset = $false; model = ''; preset = $null; battery = $null }
    if ($o.connected) {
      foreach ($row in [CUE]::Devices(0x18)) {
        $f = $row.Split('|')
        if ($f[0] -ne '8') { continue }   # 8 = audífonos
        $o.headset = $true
        $o.model = $f[2]
        $r = ([CUE]::ReadInt($f[1], 5)).Split('|')    # preset de ecualizador
        if ($r[0] -eq '0') { $o.preset = [int]$r[1] }
        $r = ([CUE]::ReadInt($f[1], 9)).Split('|')    # batería
        if ($r[0] -eq '0') { $o.battery = [int]$r[1] }
        break
      }
    }
    try { ($o | ConvertTo-Json -Compress) | Set-Content -Path $stateFile -Encoding UTF8 } catch {}
    Start-Sleep -Milliseconds 700
  }
}
finally {
  [CUE]::Disconnect()
  Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
}
