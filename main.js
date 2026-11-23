const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SHORTCUT = 'Control+Alt+V';
const LOGIN_ARGS = ['--hidden'];
const startHidden = process.argv.includes('--hidden');

let win = null;
const appDevices = new Map();
let csvSeq = 0;
let tray = null;
let quitting = false;
let settings = {};
let updateStatus = { state: 'idle' };

const SVCL = app.isPackaged
  ? path.join(process.resourcesPath, 'svcl.exe')
  : path.join(__dirname, 'bin', 'svcl.exe');

/* ---------- Audio (svcl.exe de NirSoft) ---------- */

function execSvcl(args) {
  return new Promise((resolve, reject) => {
    execFile(SVCL, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      // svcl devuelve códigos de salida distintos de 0 en algunas operaciones; no son errores.
      if (err && (typeof err.code === 'string' || err.killed)) return reject(err);
      resolve(stdout);
    });
  });
}

let queue = Promise.resolve();
function svcl(args) {
  const p = queue.then(() => execSvcl(args));
  queue = p.catch(() => {});
  return p;
}

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').slice(1);
  const utf8 = buf.toString('utf8');
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readItems() {
  const tmp = path.join(os.tmpdir(), `centro-control-${process.pid}-${++csvSeq}.csv`);
  await svcl(['/scomma', tmp]);
  const buf = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch {}
  const rows = parseCsv(decode(buf));
  if (!rows.length) throw new Error('svcl.exe no devolvió datos');
  return rows;
}

async function listDevices(preRows) {
  const rows = preRows || (await readItems());
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const iName = col('name'), iType = col('type'), iDir = col('direction'), iDef = col('default');
  const iState = col('device state'), iMute = col('muted'), iVol = col('volume percent');
  const iId = col('command-line friendly id'), iDev = col('device name');
  if (iName < 0 || iId < 0 || iDir < 0) throw new Error('Formato inesperado de svcl.exe');

  const out = { output: [], input: [] };
  for (const r of rows.slice(1)) {
    if (iType >= 0 && !/^device$/i.test((r[iType] || '').trim())) continue;
    if (iState >= 0 && !/^active$/i.test((r[iState] || '').trim())) continue;
    const dir = (r[iDir] || '').trim();
    const kind = /render/i.test(dir) ? 'output' : /capture/i.test(dir) ? 'input' : null;
    if (!kind) continue;
    const def = iDef >= 0 ? (r[iDef] || '').trim() : '';
    const name = (r[iName] || '').trim();
    const devName = iDev >= 0 ? (r[iDev] || '').trim() : '';
    out[kind].push({
      id: (r[iId] || '').trim(),
      base: name,
      adapter: devName,
      name: devName && devName !== name ? `${name} (${devName})` : name,
      isDefault: def !== '' && !/^no$/i.test(def),
      volume: parseFloat((r[iVol] || '0').replace(',', '.')) || 0,
      muted: iMute >= 0 && /^(yes|sí|si|true)$/i.test((r[iMute] || '').trim()),
    });
  }
  return out;
}

const validId = (id) => typeof id === 'string' && id.length > 0 && id.length < 500;

ipcMain.handle('audio:state', () => listDevices());
ipcMain.handle('audio:setVolume', (_, id, pct) => {
  if (!validId(id)) return;
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  return svcl(['/SetVolume', id, String(v)]);
});
ipcMain.handle('audio:toggleMute', (_, id) => validId(id) && svcl(['/Switch', id]));
ipcMain.handle('audio:setDefault', (_, id) => validId(id) && svcl(['/SetDefault', id, 'all']));

/* ---------- Audio por aplicación ---------- */

const iconCache = new Map();
async function iconFor(p) {
  if (!p) return '';
  if (iconCache.has(p)) return iconCache.get(p);
  let url = '';
  try { url = (await app.getFileIcon(p, { size: 'normal' })).toDataURL(); } catch {}
  iconCache.set(p, url);
  return url;
}

// Una fila por aplicación (Chrome y similares abren varias sesiones de audio: se agrupan).
// Cada app puede tener sesión de salida (render) y/o de entrada (capture, p. ej. Discord usando el micrófono).
async function listApps() {
  const rows = await readItems();
  const all = await listDevices(rows);
  const outs = all.output, ins = all.input;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const iName = col('name'), iType = col('type'), iDir = col('direction'), iState = col('device state');
  const iDev = col('device name');
  const iMute = col('muted'), iVol = col('volume percent'), iId = col('command-line friendly id');
  const iPath = col('process path');
  if (iName < 0 || iType < 0) throw new Error('Formato inesperado de svcl.exe');

  const groups = new Map();
  for (const r of rows.slice(1)) {
    if (!/^application$/i.test((r[iType] || '').trim())) continue;
    const dirText = iDir >= 0 ? (r[iDir] || '') : 'render';
    const side = /capture/i.test(dirText) ? 'capture' : /render/i.test(dirText) ? 'render' : null;
    if (!side) continue;
    const state = iState >= 0 ? (r[iState] || '').trim() : 'Active';
    if (/expired/i.test(state)) continue;

    const procPath = iPath >= 0 ? (r[iPath] || '').trim() : '';
    const exe = procPath ? path.win32.basename(procPath) : '';
    const name = (r[iName] || '').trim() || exe;
    const target = exe || (iId >= 0 ? (r[iId] || '').trim() : '') || name;
    if (!target) continue;

    const key = target.toLowerCase();
    const vol = parseFloat(((iVol >= 0 ? r[iVol] : '0') || '0').replace(',', '.')) || 0;
    const muted = iMute >= 0 && /^(yes|sí|si|true)$/i.test((r[iMute] || '').trim());
    const active = /^active$/i.test(state);
    const deviceRaw = iDev >= 0 ? (r[iDev] || '').trim() : '';
    let g = groups.get(key);
    if (!g) { g = { key, target, name, procPath, render: null, capture: null }; groups.set(key, g); }
    const s = g[side];
    if (!s) g[side] = { volume: vol, muted, active, deviceRaw };
    else {
      s.volume = Math.max(s.volume, vol);
      s.muted = s.muted && muted;
      s.active = s.active || active;
      if (!s.deviceRaw) s.deviceRaw = deviceRaw;
    }
  }

  // Las apps que solo tienen sesión de entrada se muestran únicamente mientras usan el micrófono.
  const list = [...groups.values()]
    .filter((g) => g.render || (g.capture && g.capture.active))
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  for (const a of list) a.icon = await iconFor(a.procPath);

  const defOut = (outs.find((d) => d.isDefault) || {}).id;
  const defIn = (ins.find((d) => d.isDefault) || {}).id;
  const apps = list.map((a) => {
    const canRoute = /\.exe$/i.test(a.target);
    const main = a.render || a.capture;
    return {
      key: a.key, target: a.target, name: a.name, icon: a.icon, canRoute,
      hasOut: !!a.render, hasIn: !!a.capture,
      volume: main.volume, muted: main.muted,
      active: a.render ? a.render.active : false,
      micActive: a.capture ? a.capture.active : false,
      out: a.render ? routeInfo(a.key + '|out', a.render, outs, defOut) : null,
      in: a.capture ? routeInfo(a.key + '|in', a.capture, ins, defIn) : null,
    };
  });
  return {
    apps,
    devices: outs.map(({ id, name }) => ({ id, name })),
    inputs: ins.map(({ id, name }) => ({ id, name })),
  };
}

function routeInfo(storeKey, sess, devs, defId) {
  const detected = detectDevice(sess.deviceRaw, devs);
  const stored = appDevices.get(storeKey);
  const storedId = stored && stored !== 'default' ? stored : '';
  let deviceId = detected || storedId || '';
  let pending = false;
  if (stored === 'default') { deviceId = ''; pending = !!detected && detected !== defId; }
  else if (storedId && detected && detected !== storedId) pending = true;
  return { deviceId, deviceRaw: sess.deviceRaw, pending };
}

// Intenta saber en qué dispositivo suena/graba la app (según lo que informa svcl).
function detectDevice(raw, devs) {
  if (!raw) return null;
  const r = raw.trim().toLowerCase();
  const by = (f) => devs.filter((d) => (d[f] || '').toLowerCase() === r);
  for (const f of ['base', 'name', 'adapter']) {
    const m = by(f);
    if (m.length === 1) return m[0].id;
  }
  return null;
}

const validTarget = (t) => typeof t === 'string' && t.length > 0 && t.length < 500 && !/^[/-]/.test(t);

ipcMain.handle('apps:list', () => listApps());
ipcMain.handle('apps:setVolume', (_, t, pct) => {
  if (!validTarget(t)) return;
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  return svcl(['/SetVolume', t, String(v)]);
});
ipcMain.handle('apps:setDevice', async (_, t, deviceId, kind) => {
  if (!validTarget(t)) return;
  if (deviceId && !validTarget(deviceId)) return;
  const isIn = kind === 'input';
  const fallback = isIn ? 'DefaultCaptureDevice' : 'DefaultRenderDevice';
  await svcl(['/SetAppDefault', deviceId || fallback, 'all', t]);
  appDevices.set(t.toLowerCase() + (isIn ? '|in' : '|out'), deviceId || 'default');
});
ipcMain.handle('apps:setMute', (_, t, muted) => validTarget(t) && svcl([muted ? '/Mute' : '/Unmute', t]));

/* ---------- Perfiles de energía (powercfg) ---------- */

// chcp 65001 para que los nombres con tilde (p. ej. "Máximo rendimiento") lleguen bien.
function powercfgList() {
  return new Promise((resolve, reject) => {
    execFile('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul && powercfg /list'],
      { windowsHide: true, timeout: 8000, encoding: 'buffer' },
      (err, stdout) => (err ? reject(err) : resolve(stdout.toString('utf8'))));
  });
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listPower() {
  const text = await powercfgList();
  const plans = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+\((.+)\)\s*(\*)?\s*$/i);
    if (m) plans.push({ id: m[1].toLowerCase(), name: m[2].trim(), active: !!m[3] });
  }
  if (!plans.length) throw new Error('powercfg no devolvió perfiles');
  return plans;
}

ipcMain.handle('power:list', () => listPower());
ipcMain.handle('power:set', (_, guid) => new Promise((resolve, reject) => {
  if (typeof guid !== 'string' || !GUID_RE.test(guid)) return reject(new Error('Perfil no válido'));
  execFile('powercfg', ['/setactive', guid], { windowsHide: true, timeout: 8000 }, (err) => (err ? reject(err) : resolve()));
}));

/* ---------- Estado del sistema ---------- */

const RES_DIR = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'bin');
const HELPER_PS1 = app.isPackaged ? path.join(process.resourcesPath, 'sensores.ps1') : path.join(__dirname, 'scripts', 'sensores.ps1');
const sensorDir = () => path.join(app.getPath('userData'), 'sensores');
const LHM_URL = 'http://127.0.0.1:8085/data.json';

// CPU: uso total y del núcleo más cargado (los juegos suelen limitarse por un solo hilo)
let cpuPrev = os.cpus().map((c) => ({ ...c.times }));
let cpuLast = { usage: 0, maxCore: 0 }, cpuLastAt = 0;
function sampleCpu() {
  const now = Date.now();
  if (now - cpuLastAt < 400) return cpuLast;
  const cur = os.cpus();
  let totBusy = 0, totAll = 0, maxCore = 0;
  cur.forEach((c, i) => {
    const p = cpuPrev[i] || c.times, t = c.times;
    const idle = t.idle - p.idle;
    const all = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + idle;
    if (all <= 0) return;
    const busy = all - idle;
    totBusy += busy; totAll += all;
    maxCore = Math.max(maxCore, (busy / all) * 100);
  });
  cpuPrev = cur.map((c) => ({ ...c.times }));
  cpuLastAt = now;
  cpuLast = { usage: totAll ? (totBusy / totAll) * 100 : 0, maxCore };
  return cpuLast;
}

// GPU NVIDIA (nvidia-smi viene con el controlador, no necesita permisos de administrador)
let nvPath = null, nvMissingUntil = 0;
const toNum = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
async function readNvidia() {
  if (Date.now() < nvMissingUntil) return [];
  const fields = 'name,utilization.gpu,temperature.gpu,memory.used,memory.total,fan.speed';
  const cands = nvPath ? [nvPath] : [
    'nvidia-smi',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];
  for (const c of cands) {
    try {
      const out = await new Promise((res, rej) => execFile(c,
        [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'],
        { windowsHide: true, timeout: 3000 }, (e, so) => (e ? rej(e) : res(so))));
      const lines = String(out).split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) continue;
      nvPath = c;
      return lines.map((line) => {
        const p = line.split(',').map((x) => x.trim());
        return { vendor: 'nvidia', name: p[0], usage: toNum(p[1]), temp: toNum(p[2]), vramUsed: toNum(p[3]), vramTotal: toNum(p[4]), fan: toNum(p[5]), source: 'nvidia-smi' };
      });
    } catch {}
  }
  nvMissingUntil = Date.now() + 60000;
  return [];
}

// Nombres de todas las tarjetas gráficas según Windows (no necesita permisos). Sirve para que
// aparezcan aunque todavía no estén activados los sensores avanzados.
const vendorOf = (n) => (/nvidia|geforce|quadro/i.test(n) ? 'nvidia' : /amd|radeon|\bati\b/i.test(n) ? 'amd' : /intel/i.test(n) ? 'intel' : 'otra');
let gpuNames = null, gpuNamesAt = 0, gpuNamesBusy = false;
function refreshGpuNames() {
  if (gpuNamesBusy || (gpuNames && Date.now() - gpuNamesAt < 300000)) return;
  gpuNamesBusy = true;
  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'],
    { windowsHide: true, timeout: 10000 }, (err, so) => {
      gpuNamesBusy = false;
      gpuNamesAt = Date.now();
      if (err) { gpuNames = gpuNames || []; return; }
      gpuNames = String(so).split(/\r?\n/).map((x) => x.trim())
        .filter((n) => n && !/basic render|remote|virtual|indirect|mirror|parsec|displaylink|meta/i.test(n));
    });
}

// GPU leídas por LibreHardwareMonitor (AMD, Intel y también NVIDIA si no hay nvidia-smi)
function gpusFromLhm(sensors) {
  const groups = new Map();
  for (const s of sensors) {
    const m = s.id.match(/^\/(gpu-[a-z-]+)\/(\d+)\//i);
    if (!m) continue;
    const key = `${m[1].toLowerCase()}/${m[2]}`;
    if (!groups.has(key)) groups.set(key, { kind: m[1].toLowerCase(), list: [], name: s.hw });
    groups.get(key).list.push(s);
  }
  const out = [];
  for (const g of groups.values()) {
    const vendor = g.kind.includes('nvidia') ? 'nvidia' : g.kind.includes('amd') ? 'amd' : g.kind.includes('intel') ? 'intel' : 'otra';
    const val = (type, re) => { const f = g.list.find((x) => x.type === type && x.value != null && re.test(x.name)); return f ? f.value : null; };
    const loads = g.list.filter((x) => x.type === 'load' && x.value != null && !/memory|bus|power|video/i.test(x.name));
    const temps = g.list.filter((x) => x.type === 'temperature' && x.value != null && x.value > 0 && x.value < 130 && !IGNORE_TEMP.test(x.name));
    const usage = val('load', /^gpu core$/i) ?? val('load', /core/i) ?? val('load', /d3d 3d/i)
      ?? (loads.length ? Math.max(...loads.map((x) => x.value)) : null);
    const temp = val('temperature', /^gpu core$/i) ?? val('temperature', /hot ?spot/i)
      ?? (temps.length ? Math.max(...temps.map((x) => x.value)) : null);
    const vramUsed = val('smalldata', /gpu memory used/i) ?? val('smalldata', /d3d dedicated memory used/i);
    const vramTotal = val('smalldata', /gpu memory total/i) ?? val('smalldata', /d3d dedicated memory total/i);
    out.push({ vendor, name: g.name || '', usage, temp, vramUsed, vramTotal, fan: null, source: 'lhm' });
  }
  return out;
}

// Une todo: NVIDIA (nvidia-smi) + el resto (LibreHardwareMonitor) + las que Windows ve pero aún sin sensores.
function buildGpus(nvidia, lhmSensors) {
  const gpus = [...nvidia];
  if (lhmSensors) {
    for (const g of gpusFromLhm(lhmSensors)) {
      if (g.vendor === 'nvidia' && nvidia.length) continue; // ya se leyó con nvidia-smi
      gpus.push(g);
    }
  }
  if (gpuNames) {
    const have = {};
    for (const g of gpus) have[g.vendor] = (have[g.vendor] || 0) + 1;
    const seen = {};
    for (const name of gpuNames) {
      const v = vendorOf(name);
      seen[v] = (seen[v] || 0) + 1;
      if (seen[v] > (have[v] || 0)) gpus.push({ vendor: v, name, usage: null, temp: null, vramUsed: null, vramTotal: null, fan: null, source: 'windows' });
    }
  }
  // Si LibreHardwareMonitor no trajo nombre, se toma el de Windows para ese fabricante
  for (const g of gpus) {
    if (!g.name && gpuNames) g.name = gpuNames.find((n) => vendorOf(n) === g.vendor) || '';
  }
  const rank = { nvidia: 0, amd: 1, intel: 2, otra: 3 };
  return gpus.sort((a, b) => (rank[a.vendor] ?? 9) - (rank[b.vendor] ?? 9));
}

// LibreHardwareMonitor (si el ayudante está activo): temperatura de CPU, ventiladores, etc.
function parseLhmValue(v) {
  const m = String(v == null ? '' : v).match(/-?\d[\d.,]*/);
  if (!m) return null;
  let s = m[0];
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function collectLhm(node, out, depth = 0, hw = '') {
  if (!node) return;
  // Estructura de data.json: raíz > equipo > hardware > grupo (Temperaturas, Carga…) > sensor
  if (depth === 2) hw = String(node.Text || '');
  if (node.SensorId) {
    const id = String(node.SensorId);
    const parts = id.split('/');
    // El id termina en /tipo/índice (el nombre del hardware puede tener más segmentos)
    const type = (parts.length >= 2 ? parts[parts.length - 2] : String(node.Type || '')).toLowerCase();
    out.push({ id, type, name: String(node.Text || ''), value: parseLhmValue(node.Value), hw });
  }
  for (const c of node.Children || []) collectLhm(c, out, depth + 1, hw);
}

let lhmCache = { at: 0, sensors: null };
async function readLhm() {
  try {
    const res = await fetch(LHM_URL, { signal: AbortSignal.timeout(900) });
    if (!res.ok) return null;
    const sensors = [];
    collectLhm(await res.json(), sensors);
    return sensors;
  } catch { return null; }
}

const IGNORE_TEMP = /distance|tjmax|limit|warning|critical|hysteresis|threshold/i;
function summarizeLhm(sensors) {
  const temps = sensors.filter((s) => s.type === 'temperature' && s.value != null && s.value > 0 && s.value < 130 && !IGNORE_TEMP.test(s.name));
  const maxOf = (arr) => arr.reduce((a, b) => (!a || b.value > a.value ? b : a), null);
  const cpuT = temps.filter((s) => /^\/(amdcpu|intelcpu)\//.test(s.id));
  const pick = cpuT.find((s) => /tctl|tdie|package|core \(max\)/i.test(s.name)) || maxOf(cpuT);
  const gen = maxOf(temps);
  const fans = sensors.filter((s) => s.type === 'fan' && s.value != null).map((s) => ({ name: s.name, rpm: Math.round(s.value) }));
  return {
    cpuTemp: pick ? pick.value : null,
    general: gen ? { value: gen.value, name: gen.name } : null,
    fans,
  };
}

// FPS: PresentMon (ayudante) escribe un CSV; se lee de forma incremental.
const fpsState = { offset: 0, size: 0, header: null, carry: '', apps: new Map(), rows: 0, lastRowAt: 0, err: '', utf16: false, firstBytes: '', firstLine: '' };
const NOT_GAMES = /^(dwm|explorer|searchhost|searchapp|startmenuexperiencehost|shellexperiencehost|textinputhost|applicationframehost|systemsettings|taskmgr|lockapp|widgets|chrome|msedge|msedgewebview2|firefox|brave|opera|vivaldi|iexplore|discord|spotify|vlc|mpv|wmplayer|teams|ms-teams|whatsapp|telegram|slack|zoom|code|devenv|notepad|mspaint|photos|centro de control|nexodeck|electron|steamwebhelper|epicwebhelper|obs64|obs32|nvidia share|nvidia overlay|nvcontainer|radeonsoftware|gamebar|gamebarftserver|xboxpcapp|gamingservices|powershell|pwsh|windowsterminal|cmd|conhost)$/i;

function resetFps() { fpsState.offset = 0; fpsState.header = null; fpsState.carry = ''; fpsState.apps.clear(); fpsState.rows = 0; fpsState.lastRowAt = 0; fpsState.utf16 = false; }

function ingestFps() {
  const file = path.join(sensorDir(), 'fps.csv');
  let st;
  try { st = fs.statSync(file); } catch { resetFps(); return; }
  if (st.size < fpsState.offset) resetFps(); // el ayudante reinició el archivo
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fpsState.err = '';
    if (!fpsState.header) {
      const b = Buffer.alloc(8192);
      const n = fs.readSync(fd, b, 0, b.length, 0);
      fpsState.firstBytes = b.slice(0, Math.min(n, 48)).toString('hex');
      // decode() tolera UTF-8 con BOM y UTF-16; además se quitan caracteres nulos
      const text = decode(b.slice(0, n)).replace(/\0/g, '').replace(/^\uFEFF/, '');
      const first = text.split(/\r?\n/)[0];
      fpsState.firstLine = first.slice(0, 160);
      if (!first || !first.includes(',')) { fpsState.err = `cabecera no válida (leídos ${n} bytes)`; return; }
      const h = first.split(',').map((x) => x.trim().toLowerCase());
      // Según la versión, PresentMon llama al tiempo entre fotogramas "FrameTime" o "MsBetweenPresents".
      const iFt = h.indexOf('msbetweenpresents') >= 0 ? h.indexOf('msbetweenpresents') : h.indexOf('frametime');
      fpsState.header = { app: h.indexOf('application'), ft: iFt, cols: h.length };
      // Se busca el fin real de la primera línea en bytes (funciona con \n o \r\n)
      // PowerShell guarda la salida de PresentMon en UTF-16 (empieza con FF FE): cada carácter ocupa 2 bytes.
      fpsState.utf16 = n >= 2 && b[0] === 0xff && b[1] === 0xfe;
      let headEnd = Buffer.byteLength(first) + 2;
      if (fpsState.utf16) {
        headEnd = n;
        for (let i = 0; i + 1 < n; i += 2) if (b[i] === 0x0a && b[i + 1] === 0x00) { headEnd = i + 2; break; }
      } else {
        const nl = b.indexOf(0x0a);
        if (nl >= 0) headEnd = nl + 1;
      }
      fpsState.offset = Math.max(headEnd, st.size - 300000); // solo lo más reciente
      if (fpsState.utf16 && fpsState.offset % 2) fpsState.offset--; // alineado a 2 bytes
      fpsState.dropFirst = fpsState.offset > headEnd; // empezamos a mitad de una fila: se descarta el fragmento
      fpsState.carry = '';
    }
    if (st.size <= fpsState.offset) return;
    let len = st.size - fpsState.offset;
    if (fpsState.utf16) len -= len % 2; // un carácter a medias se lee en la próxima vuelta
    if (len <= 0) return;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fpsState.offset);
    fpsState.offset += len;
    const lines = (fpsState.carry + buf.toString(fpsState.utf16 ? 'utf16le' : 'utf8')).split(/\r?\n/);
    fpsState.carry = lines.pop();
    if (fpsState.dropFirst) { lines.shift(); fpsState.dropFirst = false; }
    const { app: ia, ft: ift } = fpsState.header;
    if (ia < 0) return;
    const now = Date.now();
    for (const line of lines) {
      if (!line) continue;
      const c = line.split(',');
      const name = (c[ia] || '').trim();
      if (!name) continue;
      fpsState.rows++; fpsState.lastRowAt = now;
      const ft = ift >= 0 ? parseFloat(c[ift]) : NaN;
      let a = fpsState.apps.get(name);
      if (!a) { a = { frames: [], last: 0 }; fpsState.apps.set(name, a); }
      a.last = now;
      if (Number.isFinite(ft) && ft > 0.2 && ft < 2000) a.frames.push({ t: now, ft });
    }
  } catch (e) { fpsState.err = `${e.code || ''} ${e.message}`.trim(); } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  const now = Date.now();
  for (const [k, a] of fpsState.apps) {
    a.frames = a.frames.filter((f) => now - f.t < 10000);
    if (now - a.last > 30000) fpsState.apps.delete(k);
  }
}

function currentGame() {
  const now = Date.now();
  let best = null;
  for (const [name, a] of fpsState.apps) {
    const base = name.replace(/\.exe$/i, '');
    if (NOT_GAMES.test(base)) continue;
    const recent = a.frames.filter((f) => now - f.t < 3000);
    if (recent.length < 5) continue;
    const mean = recent.reduce((s, f) => s + f.ft, 0) / recent.length;
    const fps = 1000 / mean;
    if (fps < 5) continue;
    if (!best || fps > best.fps) best = { app: name, name: base, fps };
  }
  return best;
}

const helperActive = () => {
  try { return Date.now() - fs.statSync(path.join(sensorDir(), 'heartbeat.txt')).mtimeMs < 7000; } catch { return false; }
};

function wmiFans() {
  if (!helperActive()) return [];
  const j = readJsonFile(path.join(sensorDir(), 'fans.json'));
  return j && Array.isArray(j.fans) ? j.fans.filter((f) => f && Number.isFinite(f.rpm)).map((f) => ({ name: String(f.name), rpm: Math.round(f.rpm) })) : [];
}

ipcMain.handle('sys:state', async () => {
  // Si hace rato que no se mide (la pestaña estaba cerrada), la primera lectura promediaría todo ese tiempo
  // y saldría un valor sin sentido: se toma una referencia nueva y se mide una ventana corta.
  if (Date.now() - cpuLastAt > 3000) {
    cpuPrev = os.cpus().map((c) => ({ ...c.times }));
    cpuLastAt = Date.now() - 400;
    await new Promise((r) => setTimeout(r, 600));
  }
  const cpu = sampleCpu();
  refreshGpuNames();
  const [nvidia, lhmSensors] = await Promise.all([readNvidia(), readLhm()]);
  lhmCache = { at: Date.now(), sensors: lhmSensors };
  const lhm = lhmSensors ? summarizeLhm(lhmSensors) : null;
  const gpus = buildGpus(nvidia, lhmSensors);
  const helper = helperActive();
  const total = os.totalmem(), free = os.freemem();

  let game = null;
  if (helper) { ingestFps(); game = currentGame(); } else if (fpsState.apps.size) resetFps();
  const cpuTemp = lhm ? lhm.cpuTemp : null;

  // Punto más caliente: el sensor de temperatura más alto de todo el equipo (no es un promedio)
  let hottest = lhm && lhm.general ? lhm.general : null;
  gpus.forEach((g, i) => {
    if (g.temp != null && (!hottest || g.temp > hottest.value)) hottest = { value: g.temp, name: gpus.length > 1 ? `GPU ${i + 1}` : 'GPU' };
  });

  return {
    cpu: { usage: cpu.usage, maxCore: cpu.maxCore, temp: cpuTemp, cores: os.cpus().length, model: (os.cpus()[0] || {}).model || '' },
    gpus,
    ram: { used: total - free, total },
    fans: (lhm && lhm.fans.length) ? lhm.fans : wmiFans(),
    general: hottest,
    sensors: { lhm: !!lhm, helper, hasFiles: fs.existsSync(HELPER_PS1) },
    game: game ? { name: game.name, fps: game.fps } : null,
  };
});

// Lanza el ayudante con permisos de administrador (Windows pide confirmación).
ipcMain.handle('sys:enable', () => new Promise((resolve) => {
  if (!fs.existsSync(HELPER_PS1)) return resolve({ ok: false, error: 'Falta el archivo sensores.ps1 en la app.' });
  if (helperActive()) return resolve({ ok: true });
  const q = (v) => String(v).replace(/'/g, "''");
  const argList = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${HELPER_PS1}" -ParentPid ${process.pid} -ResDir "${RES_DIR}" -DataDir "${sensorDir()}"`;
  const cmd = `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '${q(argList)}'`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 90000 },
    (err) => resolve(err ? { ok: false, error: 'No se concedió el permiso de administrador.' } : { ok: true }));
}));

// Diagnóstico: resume en texto qué ve cada parte (ayudante, PresentMon, LibreHardwareMonitor) para poder encontrar fallos.
function readTail(file, max = 500) {
  try {
    const buf = fs.readFileSync(file);
    if (!buf.length) return '(vacío)';
    const t = decode(buf).replace(/\r/g, '').trim();
    return t.length > max ? '…' + t.slice(-max) : t;
  } catch { return '(no existe)'; }
}
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

async function buildDiag() {
  const dir = sensorDir();
  const L = [];
  const ago = (ms) => (ms ? `${((Date.now() - ms) / 1000).toFixed(1)} s` : 'nunca');
  L.push(`Centro de Control ${app.getVersion()} · ${app.isPackaged ? 'instalada' : 'modo desarrollo'}`);
  L.push(`Archivos de la app: sensores.ps1 ${fs.existsSync(HELPER_PS1) ? 'sí' : 'NO'} · PresentMon.exe ${fs.existsSync(path.join(RES_DIR, 'PresentMon.exe')) ? 'sí' : 'NO'} · lhm/LibreHardwareMonitor.exe ${fs.existsSync(path.join(RES_DIR, 'lhm', 'LibreHardwareMonitor.exe')) ? 'sí' : 'NO'}`);

  L.push('', '── Ayudante (administrador) ──');
  let beat = 0;
  try { beat = fs.statSync(path.join(dir, 'heartbeat.txt')).mtimeMs; } catch {}
  L.push(`Latido: ${beat ? 'hace ' + ago(beat) : 'no hay (el ayudante no está corriendo)'}`);
  const st = readJsonFile(path.join(dir, 'status.json'));
  if (st) {
    L.push(`PresentMon: ${st.pmRunning ? 'CORRIENDO' : 'DETENIDO'}${st.pmExitCode != null ? ` (último código de salida ${st.pmExitCode})` : ''} · reinicios: ${st.pmRestarts}`);
    L.push(`LibreHardwareMonitor: ${st.lhmRunning ? 'CORRIENDO' : 'DETENIDO'}`);
  } else L.push('status.json: no existe todavía');
  L.push(`helper.log: ${readTail(path.join(dir, 'helper.log'), 400).replace(/\n/g, ' | ')}`);

  L.push('', '── FPS (PresentMon) ──');
  const csv = path.join(dir, 'fps.csv');
  try {
    const cs = fs.statSync(csv);
    L.push(`fps.csv: ${(cs.size / 1024).toFixed(0)} KB, modificado hace ${ago(cs.mtimeMs)}`);
  } catch { L.push('fps.csv: NO existe (PresentMon no ha escrito nada)'); }
  const hd = fpsState.header;
  L.push(hd ? `Columnas: ${hd.cols} · Application=#${hd.app} · tiempo de fotograma=#${hd.ft}${hd.app < 0 || hd.ft < 0 ? '  ← NO se encontró la columna' : ''}` : 'Cabecera del CSV: todavía no leída');
  if (fpsState.err) L.push(`ERROR al leer fps.csv: ${fpsState.err}`);
  if (fpsState.firstBytes) L.push(`Primeros bytes (hex): ${fpsState.firstBytes}`);
  if (fpsState.firstLine) L.push(`Primera línea: ${fpsState.firstLine}`);
  L.push(`Filas leídas: ${fpsState.rows} · última fila hace ${ago(fpsState.lastRowAt)}`);
  const now = Date.now();
  const seen = [...fpsState.apps.entries()].map(([name, a]) => {
    const recent = a.frames.filter((f) => now - f.t < 3000);
    const mean = recent.length ? recent.reduce((x, f) => x + f.ft, 0) / recent.length : 0;
    return { name, n: a.frames.length, fps: mean ? 1000 / mean : 0, ignored: NOT_GAMES.test(name.replace(/\.exe$/i, '')) };
  }).sort((a, b) => b.n - a.n);
  if (!seen.length) L.push('Programas que presentan fotogramas: ninguno');
  else {
    L.push('Programas que presentan fotogramas (últimos 10 s):');
    for (const a of seen.slice(0, 8)) L.push(`  · ${a.name} — ${a.n} fotogramas — ${a.fps ? a.fps.toFixed(1) + ' FPS' : 'sin datos de 3 s'}${a.ignored ? ' — IGNORADO por la lista de no-juegos' : ''}`);
  }
  const g = currentGame();
  L.push(`Juego elegido: ${g ? `${g.name} (${g.fps.toFixed(1)} FPS)` : 'ninguno'}`);
  L.push(`presentmon.err.log: ${readTail(path.join(dir, 'presentmon.err.log'), 300).replace(/\n/g, ' | ')}`);
  L.push(`presentmon.out.log: ${readTail(path.join(dir, 'presentmon.out.log'), 200).replace(/\n/g, ' | ')}`);

  const fj = readJsonFile(path.join(dir, 'fans.json'));
  L.push('', '── Ventiladores por WMI (Lenovo) ──');
  L.push(fj ? `${fj.note}${fj.raw ? ' · respuesta: ' + fj.raw : ''} · detectados: ${(fj.fans || []).map((f) => `${f.name}=${f.rpm}`).join(', ') || 'ninguno'}` : 'fans.json: no existe todavía');

  L.push('', '── Sensores (LibreHardwareMonitor) ──');
  let sensors = lhmCache.sensors;
  if (!sensors || Date.now() - lhmCache.at > 5000) sensors = await readLhm();
  if (!sensors) L.push(`No responde en ${LHM_URL} (no está abierto, o el servidor web no arrancó)`);
  else {
    const byType = {};
    const hw = new Set();
    for (const x of sensors) {
      byType[x.type] = (byType[x.type] || 0) + 1;
      hw.add(x.id.split('/').slice(0, -2).join('/'));
    }
    L.push(`Responde: ${sensors.length} sensores → ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    L.push(`Hardware que ve: ${[...hw].join('  ') || '(nada)'}`);
    const fans = sensors.filter((x) => x.type === 'fan');
    L.push(fans.length ? `Ventiladores: ${fans.map((x) => `${x.name}=${x.value}`).join(', ')}` : 'Ventiladores: LibreHardwareMonitor no encontró ninguno');
    const temps = sensors.filter((x) => x.type === 'temperature' && x.value != null).slice(0, 12);
    L.push(`Temperaturas: ${temps.map((x) => `${x.name}=${x.value}`).join(', ') || '(ninguna)'}`);
  }
  return L.join('\n');
}

/* ---------- Ajustes guardados ---------- */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch {}
}
const loginEnabled = () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;

/* ---------- Ventana ---------- */

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Atajo global: si la ventana ya está en primer plano la minimiza; si no, la trae al frente.
function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized() && win.isFocused()) {
    if (settings.keepInTray) win.hide(); else win.minimize();
  } else showWindow();
}

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 960,
    height: b.height || 640,
    x: b.x,
    y: b.y,
    minWidth: 360,
    minHeight: 360,
    show: false,
    title: 'Centro de Control',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  win.once('ready-to-show', () => {
    if (startHidden) { win.showInactive(); win.minimize(); } // arranque con Windows: queda en la barra de tareas
    else win.show();
  });

  win.on('focus', () => win.webContents.send('ui:shown'));
  win.on('restore', () => win.webContents.send('ui:shown'));

  win.on('close', (e) => {
    try { settings.bounds = win.getNormalBounds(); saveSettings(); } catch {}
    // Con "Mantener en segundo plano" la X solo oculta la ventana; si no, cierra el programa.
    if (!quitting && settings.keepInTray) { e.preventDefault(); win.hide(); }
  });
}

/* ---------- Bandeja ---------- */

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Abrir Centro de Control', click: showWindow },
    { label: `Minimizar / traer al frente  (${SHORTCUT.replace('Control', 'Ctrl')})`, click: toggleWindow },
    { type: 'separator' },
    {
      label: 'Mantener en segundo plano al cerrar',
      type: 'checkbox',
      checked: !!settings.keepInTray,
      click: (item) => { settings.keepInTray = item.checked; saveSettings(); },
    },
    {
      label: 'Iniciar con Windows',
      type: 'checkbox',
      checked: loginEnabled(),
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ARGS }),
    },
    { label: 'Buscar actualizaciones', click: checkForUpdates },
    { label: 'Copiar diagnóstico de sensores', click: async () => { try { clipboard.writeText(await buildDiag()); } catch {} } },
    { type: 'separator' },
    { label: `Versión ${app.getVersion()}`, enabled: false },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Centro de Control');
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

/* ---------- Actualizaciones (GitHub Releases) ---------- */

function sendUpdate(status) {
  updateStatus = status;
  if (win && !win.isDestroyed()) win.webContents.send('update:status', status);
}

function checkForUpdates() {
  if (!app.isPackaged) return Promise.resolve();
  return autoUpdater.checkForUpdates().catch(() => {});
}

function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'downloading', version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('error', () => sendUpdate({ state: 'idle' }));
  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
}

ipcMain.handle('app:info', () => ({ version: app.getVersion(), update: updateStatus }));
ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('update:install', () => {
  quitting = true;
  autoUpdater.quitAndInstall();
});

/* ---------- Arranque ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    settings = loadSettings();
    createWindow();
    createTray();
    setupUpdater();
    globalShortcut.register(SHORTCUT, toggleWindow);

    if (app.isPackaged) {
      // Instalaciones anteriores: pasar el inicio automático al modo "arrancar minimizado".
      if (!loginEnabled() && app.getLoginItemSettings().openAtLogin) {
        app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS });
      }
      // La primera vez que se instala, se configura para iniciar con Windows.
      const flag = path.join(app.getPath('userData'), 'primer-inicio');
      if (!fs.existsSync(flag)) {
        app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS });
        try { fs.writeFileSync(flag, '1'); } catch {}
      }
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
