# Ayudante de audio rápido de Centro de Control (no necesita administrador).
# Se queda abierto y recibe órdenes por la entrada estándar (volumen y silencio de dispositivos y de apps)
# usando la API de audio de Windows directamente: el cambio es inmediato, sin abrir svcl.exe cada vez.
# Se cierra solo cuando se cierra la app (la entrada estándar se cierra).
$ErrorActionPreference = 'SilentlyContinue'
if (-not [Environment]::Is64BitProcess) { exit 1 }

$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorCom { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int Item(int index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid ctx);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  [PreserveSig] int GetMasterVolumeLevel(out float db);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
  [PreserveSig] int GetChannelVolumeLevel(uint ch, out float db);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr g, uint flags, out IntPtr ctl);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr g, uint flags, out IntPtr vol);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
  [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
  [PreserveSig] int GetGroupingParam(out Guid g);
  [PreserveSig] int SetGroupingParam(ref Guid g, ref Guid ctx);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
  [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
class PolicyConfigClient { }

[ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
  [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr fmt);
  [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool def, IntPtr fmt);
  [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr endpointFmt, IntPtr mixFmt);
  [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool def, IntPtr defPeriod, IntPtr minPeriod);
  [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr period);
  [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr mode);
  [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr mode);
  [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool fx, IntPtr key, IntPtr pv);
  [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool fx, IntPtr key, IntPtr pv);
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string name, int role);
  [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Bool)] bool visible);
}

public static class Aud {
  static readonly Guid IID_EndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
  static readonly Guid IID_SessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
  static Guid Ctx = Guid.Empty;
  static IMMDeviceEnumerator en;
  static Dictionary<string, IAudioEndpointVolume> cache = new Dictionary<string, IAudioEndpointVolume>();

  static IMMDeviceEnumerator Enum() {
    if (en == null) en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    return en;
  }

  // Busca el dispositivo por su id completo; si no coincide, por el GUID final ({...}).
  static IMMDevice FindDevice(string id) {
    IMMDevice d;
    if (Enum().GetDevice(id, out d) == 0 && d != null) return d;
    Match m = Regex.Match(id ?? "", @"\{[0-9a-fA-F-]{36}\}\s*$");
    if (!m.Success) return null;
    for (int flow = 0; flow < 2; flow++) {
      IMMDeviceCollection col;
      if (Enum().EnumAudioEndpoints(flow, 1, out col) != 0 || col == null) continue;
      int n; col.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IMMDevice dev; if (col.Item(i, out dev) != 0 || dev == null) continue;
        string did; dev.GetId(out did);
        if (did != null && did.EndsWith(m.Value, StringComparison.OrdinalIgnoreCase)) return dev;
      }
    }
    return null;
  }

  static IAudioEndpointVolume Endpoint(string id) {
    IAudioEndpointVolume v;
    if (cache.TryGetValue(id, out v)) return v;
    IMMDevice d = FindDevice(id);
    if (d == null) return null;
    object o; Guid iid = IID_EndpointVolume;
    if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) return null;
    v = (IAudioEndpointVolume)o;
    cache[id] = v;
    return v;
  }

  static int WithEndpoint(string id, Func<IAudioEndpointVolume, int> act) {
    for (int attempt = 0; attempt < 2; attempt++) {
      try {
        IAudioEndpointVolume v = Endpoint(id);
        if (v == null) return -1;
        int hr = act(v);
        if (hr == 0) return 0;
      } catch { }
      cache.Remove(id); // el dispositivo cambió: se vuelve a buscar
    }
    return -1;
  }

  public static string EV(string id, int pct) {
    float f = Math.Max(0, Math.Min(100, pct)) / 100f;
    return WithEndpoint(id, v => v.SetMasterVolumeLevelScalar(f, ref Ctx)) == 0 ? "OK" : "ERR";
  }
  public static string EM(string id, bool mute) {
    return WithEndpoint(id, v => v.SetMute(mute, ref Ctx)) == 0 ? "OK" : "ERR";
  }

  static Dictionary<uint, string> pn = new Dictionary<uint, string>();
  static DateTime pnAt = DateTime.UtcNow;
  static string ProcName(uint pid) {
    if ((DateTime.UtcNow - pnAt).TotalSeconds > 10) { pn.Clear(); pnAt = DateTime.UtcNow; }
    string name;
    if (pn.TryGetValue(pid, out name)) return name;
    try { name = Process.GetProcessById((int)pid).ProcessName; } catch { return null; }
    pn[pid] = name;
    return name;
  }

  // Recorre las sesiones de audio (apps) de todos los dispositivos activos. flow: 0 = salida, 1 = entrada (micrófono).
  static void ForSessions(int flow, Func<string, ISimpleAudioVolume, bool> cb) {
    IMMDeviceCollection col;
    if (Enum().EnumAudioEndpoints(flow, 1, out col) != 0 || col == null) return;
    int n; col.GetCount(out n);
    for (int i = 0; i < n; i++) {
      try {
        IMMDevice dev; if (col.Item(i, out dev) != 0 || dev == null) continue;
        object o; Guid iid = IID_SessionManager2;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) continue;
        IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator se;
        if (mgr.GetSessionEnumerator(out se) != 0 || se == null) continue;
        int cnt; se.GetCount(out cnt);
        for (int k = 0; k < cnt; k++) {
          IAudioSessionControl2 c;
          if (se.GetSession(k, out c) != 0 || c == null) continue;
          uint pid; if (c.GetProcessId(out pid) != 0 || pid == 0) continue;
          string name = ProcName(pid);
          if (name == null) continue;
          cb(name, (ISimpleAudioVolume)c);
        }
      } catch { }
    }
  }

  static int EachSession(int flow, string exe, Func<ISimpleAudioVolume, int> act) {
    string want = (exe ?? "").Trim();
    if (want.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) want = want.Substring(0, want.Length - 4);
    int hit = 0;
    ForSessions(flow, (name, sv) => {
      if (string.Equals(name, want, StringComparison.OrdinalIgnoreCase) && act(sv) == 0) hit++;
      return true;
    });
    return hit;
  }

  // Volumen y silencio actuales de cada dispositivo (ids separados por |): "pct,mute;pct,mute;..."
  public static string EGM(string ids) {
    List<string> parts = new List<string>();
    foreach (string id in (ids ?? "").Split('|')) {
      string r = "x";
      if (id.Length > 0) {
        WithEndpoint(id, v => {
          float f; bool m;
          int hr = v.GetMasterVolumeLevelScalar(out f);
          if (hr != 0) return hr;
          v.GetMute(out m);
          r = ((int)Math.Round(f * 100)).ToString() + "," + (m ? "1" : "0");
          return 0;
        });
      }
      parts.Add(r);
    }
    return "OK\t" + string.Join(";", parts.ToArray());
  }

  // Volumen y silencio actuales de cada app: "nombre=pct,mute;..." (volumen más alto; silenciada solo si todas lo están)
  public static string AL(int flow) {
    Dictionary<string, float> vol = new Dictionary<string, float>();
    Dictionary<string, bool> mut = new Dictionary<string, bool>();
    ForSessions(flow, (name, sv) => {
      float v; bool m;
      if (sv.GetMasterVolume(out v) != 0) return true;
      sv.GetMute(out m);
      string k = name.ToLowerInvariant();
      if (!vol.ContainsKey(k)) { vol[k] = v; mut[k] = m; }
      else { if (v > vol[k]) vol[k] = v; mut[k] = mut[k] && m; }
      return true;
    });
    List<string> parts = new List<string>();
    foreach (KeyValuePair<string, float> kv in vol)
      parts.Add(kv.Key + "=" + ((int)Math.Round(kv.Value * 100)).ToString() + "," + (mut[kv.Key] ? "1" : "0"));
    return "OK\t" + string.Join(";", parts.ToArray());
  }

  public static string AV(string exe, int pct, int flow) {
    float f = Math.Max(0, Math.Min(100, pct)) / 100f;
    return EachSession(flow, exe, s => s.SetMasterVolume(f, ref Ctx)) > 0 ? "OK" : "ERR";
  }
  public static string AM(string exe, bool mute, int flow) {
    return EachSession(flow, exe, s => s.SetMute(mute, ref Ctx)) > 0 ? "OK" : "ERR";
  }

  // Pone el dispositivo como predeterminado en los tres roles (consola, multimedia y comunicaciones).
  public static string SD(string id) {
    try {
      IMMDevice d = FindDevice(id);
      if (d == null) return "ERR";
      string real; if (d.GetId(out real) != 0 || string.IsNullOrEmpty(real)) return "ERR";
      IPolicyConfig pc = (IPolicyConfig)(new PolicyConfigClient());
      int bad = 0;
      for (int role = 0; role < 3; role++) { if (pc.SetDefaultEndpoint(real, role) != 0) bad++; }
      return bad == 0 ? "OK" : "ERR";
    } catch { return "ERR"; }
  }

  // Dónde está cada sesión de audio de las apps ahora mismo (salida y entrada):
  // "programa|o/i|estado|idDispositivo;..."  (estado: 0 inactiva, 1 activa; las caducadas no se incluyen)
  public static string ASD() {
    List<string> parts = new List<string>();
    for (int flow = 0; flow < 2; flow++) {
      try {
        IMMDeviceCollection col;
        if (Enum().EnumAudioEndpoints(flow, 1, out col) != 0 || col == null) continue;
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
          try {
            IMMDevice dev; if (col.Item(i, out dev) != 0 || dev == null) continue;
            string did; if (dev.GetId(out did) != 0 || string.IsNullOrEmpty(did)) continue;
            object o; Guid iid = IID_SessionManager2;
            if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) continue;
            IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
            IAudioSessionEnumerator se;
            if (mgr.GetSessionEnumerator(out se) != 0 || se == null) continue;
            int cnt; se.GetCount(out cnt);
            for (int k = 0; k < cnt; k++) {
              IAudioSessionControl2 c;
              if (se.GetSession(k, out c) != 0 || c == null) continue;
              uint pid; if (c.GetProcessId(out pid) != 0 || pid == 0) continue;
              string name = ProcName(pid);
              if (name == null) continue;
              int st; if (c.GetState(out st) != 0) continue;
              if (st == 2) continue;
              parts.Add(name.Replace("|", "_").Replace(";", "_") + "|" + (flow == 0 ? "o" : "i") + "|" + st.ToString() + "|" + did);
            }
          } catch { }
        }
      } catch { }
    }
    return "OK\t" + string.Join(";", parts.ToArray());
  }

  // Dispositivos predeterminados ahora (salida;entrada), por su id interno.
  public static string DEFS() {
    List<string> parts = new List<string>();
    for (int flow = 0; flow < 2; flow++) {
      string id = "x";
      try {
        IMMDevice d;
        if (Enum().GetDefaultAudioEndpoint(flow, 0, out d) == 0 && d != null) { string g; if (d.GetId(out g) == 0 && g != null) id = g; }
      } catch { }
      parts.Add(id);
    }
    return "OK\t" + string.Join(";", parts.ToArray());
  }
}
'@

try {
  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
} catch {
  [Console]::Out.WriteLine("FAIL`tcompilacion")
  [Console]::Out.Flush()
  exit 1
}

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

function Dec([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }

$reader = [Console]::In
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split("`t")
  if ($p.Length -lt 4) { continue }
  $r = 'ERR'
  try {
    $arg = Dec $p[2]
    $n = [int]$p[3]
    switch ($p[1]) {
      'EV' { $r = [Aud]::EV($arg, $n) }
      'EM' { $r = [Aud]::EM($arg, ($n -ne 0)) }
      'AV' { $r = [Aud]::AV($arg, $n, 0) }
      'AM' { $r = [Aud]::AM($arg, ($n -ne 0), 0) }
      'AVI' { $r = [Aud]::AV($arg, $n, 1) }
      'AMI' { $r = [Aud]::AM($arg, ($n -ne 0), 1) }
      'EGM' { $r = [Aud]::EGM($arg) }
      'AL' { $r = [Aud]::AL(0) }
      'ALI' { $r = [Aud]::AL(1) }
      'SD' { $r = [Aud]::SD($arg) }
      'DEFS' { $r = [Aud]::DEFS() }
      'ASD' { $r = [Aud]::ASD() }
    }
  } catch { $r = 'ERR' }
  [Console]::Out.WriteLine($p[0] + "`t" + $r)
  [Console]::Out.Flush()
}
