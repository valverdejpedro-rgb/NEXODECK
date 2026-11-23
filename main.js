const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage } = require('electron');
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
async function readGpu() {
  if (Date.now() < nvMissingUntil) return null;
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
      const line = String(out).split(/\r?\n/).find((l) => l.trim());
      if (!line) continue;
      nvPath = c;
      const p = line.split(',').map((x) => x.trim());
      return { name: p[0], usage: toNum(p[1]), temp: toNum(p[2]), vramUsed: toNum(p[3]), vramTotal: toNum(p[4]), fan: toNum(p[5]) };
    } catch {}
  }
  nvMissingUntil = Date.now() + 60000;
  return null;
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

function collectLhm(node, out) {
  if (!node) return;
  if (node.SensorId) {
    const id = String(node.SensorId);
    const parts = id.split('/');
    // El id termina en /tipo/índice (el nombre del hardware puede tener más segmentos)
    const type = (parts.length >= 2 ? parts[parts.length - 2] : String(node.Type || '')).toLowerCase();
    out.push({ id, type, name: String(node.Text || ''), value: parseLhmValue(node.Value) });
  }
  for (const c of node.Children || []) collectLhm(c, out);
}

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
const fpsState = { offset: 0, size: 0, header: null, carry: '', apps: new Map() };
const NOT_GAMES = /^(dwm|explorer|searchhost|searchapp|startmenuexperiencehost|shellexperiencehost|textinputhost|applicationframehost|systemsettings|taskmgr|lockapp|widgets|chrome|msedge|msedgewebview2|firefox|brave|opera|vivaldi|iexplore|discord|spotify|vlc|mpv|wmplayer|teams|ms-teams|whatsapp|telegram|slack|zoom|code|devenv|notepad|mspaint|photos|centro de control|nexodeck|electron|steamwebhelper|epicwebhelper|obs64|obs32|nvidia share|nvidia overlay|nvcontainer|radeonsoftware|gamebar|gamebarftserver|xboxpcapp|gamingservices|powershell|pwsh|windowsterminal|cmd|conhost)$/i;

function resetFps() { fpsState.offset = 0; fpsState.header = null; fpsState.carry = ''; fpsState.apps.clear(); }

function ingestFps() {
  const file = path.join(sensorDir(), 'fps.csv');
  let st;
  try { st = fs.statSync(file); } catch { resetFps(); return; }
  if (st.size < fpsState.offset) resetFps(); // el ayudante reinició el archivo
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (!fpsState.header) {
      const b = Buffer.alloc(8192);
      const n = fs.readSync(fd, b, 0, b.length, 0);
      const first = b.toString('utf8', 0, n).split(/\r?\n/)[0];
      if (!first || !first.includes(',')) return;
      const h = first.split(',').map((x) => x.trim().toLowerCase());
      fpsState.header = { app: h.indexOf('application'), ft: Math.max(h.indexOf('frametime'), h.indexOf('msbetweenpresents')) };
      fpsState.offset = Math.max(Buffer.byteLength(first) + 2, st.size - 300000); // solo lo más reciente
      fpsState.carry = '';
    }
    if (st.size <= fpsState.offset) return;
    const len = st.size - fpsState.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fpsState.offset);
    fpsState.offset = st.size;
    const lines = (fpsState.carry + buf.toString('utf8')).split(/\r?\n/);
    fpsState.carry = lines.pop();
    const { app: ia, ft: ift } = fpsState.header;
    if (ia < 0) return;
    const now = Date.now();
    for (const line of lines) {
      if (!line) continue;
      const c = line.split(',');
      const name = (c[ia] || '').trim();
      if (!name) continue;
      const ft = ift >= 0 ? parseFloat(c[ift]) : NaN;
      let a = fpsState.apps.get(name);
      if (!a) { a = { frames: [], last: 0 }; fpsState.apps.set(name, a); }
      a.last = now;
      if (Number.isFinite(ft) && ft > 0.2 && ft < 2000) a.frames.push({ t: now, ft });
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
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
    if (!best || fps > best.fps) {
      const sorted = a.frames.map((f) => f.ft).sort((x, y) => y - x);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.01));
      best = { app: name, name: base, fps, low1: 1000 / sorted[idx] };
    }
  }
  return best;
}

// Picos durante la sesión de juego (para las recomendaciones)
let gameSession = { app: '', peakGpu: 0, peakCpu: 0, lastSeen: 0 };
function trackSession(game, gpuTemp, cpuTemp) {
  const now = Date.now();
  if (!game) { if (now - gameSession.lastSeen > 15000) gameSession = { app: '', peakGpu: 0, peakCpu: 0, lastSeen: 0 }; return; }
  if (gameSession.app !== game.app) gameSession = { app: game.app, peakGpu: 0, peakCpu: 0, lastSeen: now };
  gameSession.lastSeen = now;
  if (gpuTemp != null) gameSession.peakGpu = Math.max(gameSession.peakGpu, gpuTemp);
  if (cpuTemp != null) gameSession.peakCpu = Math.max(gameSession.peakCpu, cpuTemp);
}

const FPS_STEPS = [30, 40, 45, 50, 60, 75, 90, 100, 120, 144, 165, 240];
const CAP_VALUES = [30, 60, 75, 90, 120, 144, 165, 240];

// Estimación según la carga actual: si el equipo no está al límite, hay margen para más FPS.
function estimateFps(game, gpu, cpu) {
  const f = game.fps;
  const g = gpu && gpu.usage != null ? gpu.usage : 0;
  const c = cpu.maxCore;
  const load = Math.max(g, c);
  const limiter = gpu && gpu.usage != null && g >= c ? 'GPU' : 'CPU';
  const nearCap = CAP_VALUES.some((v) => Math.abs(f - v) / v < 0.03);
  const headroom = load < 85;
  let potential = f;
  if (headroom) potential = Math.min(f * 3, (f * 100) / Math.max(load, 30) * 0.95);
  potential = Math.max(potential, f);

  const ratio = Math.max(0.65, Math.min(1, game.low1 / f));
  const stable = potential * ratio;
  let recommended = null;
  for (const s of FPS_STEPS) if (s <= stable * 0.92) recommended = s;
  if (recommended == null) recommended = stable >= 20 ? Math.floor(stable / 5) * 5 : null;

  const tips = [];
  const peakG = gameSession.peakGpu, peakC = gameSession.peakCpu;
  if (peakG >= 85) tips.push(`La GPU llegó a ${Math.round(peakG)} °C en esta sesión: limita los FPS a ${recommended || 60} o mejora la ventilación (base de enfriamiento, limpiar polvo).`);
  if (peakC >= 90) tips.push(`El CPU llegó a ${Math.round(peakC)} °C: baja la carga (límite de FPS o perfil de energía más bajo).`);
  if (gpu && gpu.vramTotal && gpu.vramUsed / gpu.vramTotal >= 0.92) tips.push(`VRAM casi llena (${(gpu.vramUsed / 1024).toFixed(1)} de ${(gpu.vramTotal / 1024).toFixed(1)} GB): baja la calidad de texturas para evitar tirones.`);
  if (!headroom && limiter === 'GPU' && stable < 60) tips.push('La GPU va al límite: baja resolución o sombras/efectos' + (gpu && /rtx/i.test(gpu.name || '') ? ', o activa DLSS si el juego lo ofrece.' : ', o activa FSR si el juego lo ofrece.'));
  if (!headroom && limiter === 'CPU') tips.push('Un núcleo del CPU va al límite: bajar gráficos ayuda poco; reduce distancia de dibujado, población o simulación.');
  if (game.low1 / f < 0.6) tips.push('Hay tirones (los FPS mínimos son mucho menores que el promedio): fija un límite de FPS estable.');

  return {
    potential: Math.round(potential),
    recommended,
    limiter: headroom ? null : limiter,
    capped: headroom && nearCap,
    load: Math.round(load),
    tips,
  };
}

const helperActive = () => {
  try { return Date.now() - fs.statSync(path.join(sensorDir(), 'heartbeat.txt')).mtimeMs < 7000; } catch { return false; }
};

ipcMain.handle('sys:state', async () => {
  const cpu = sampleCpu();
  const [gpu, lhmSensors] = await Promise.all([readGpu(), readLhm()]);
  const lhm = lhmSensors ? summarizeLhm(lhmSensors) : null;
  const helper = helperActive();
  const total = os.totalmem(), free = os.freemem();

  let game = null;
  if (helper) { ingestFps(); game = currentGame(); } else if (fpsState.apps.size) resetFps();
  const cpuTemp = lhm ? lhm.cpuTemp : null;
  trackSession(game, gpu ? gpu.temp : null, cpuTemp);
  if (game) game = { ...game, ...estimateFps(game, gpu, cpu), peakGpu: gameSession.peakGpu, peakCpu: gameSession.peakCpu };

  let general = null;
  if (lhm && lhm.general) general = lhm.general;
  else if (gpu && gpu.temp != null) general = { value: gpu.temp, name: 'GPU' };
  if (general && gpu && gpu.temp != null && gpu.temp > general.value) general = { value: gpu.temp, name: 'GPU' };

  return {
    cpu: { usage: cpu.usage, maxCore: cpu.maxCore, temp: cpuTemp, cores: os.cpus().length, model: (os.cpus()[0] || {}).model || '' },
    gpu,
    ram: { used: total - free, total },
    fans: lhm ? lhm.fans : [],
    general,
    sensors: { lhm: !!lhm, helper, hasFiles: fs.existsSync(HELPER_PS1) },
    game,
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
    width: b.width || 520,
    height: b.height || 620,
    x: b.x,
    y: b.y,
    minWidth: 380,
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
