const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const { execFile, spawn } = require('child_process');
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
const micWatch = { id: '', vol: null, lastSetAt: 0, log: [], timer: null, busy: false };

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

// Cambios de volumen/silencio: no esperan en la cola de lecturas (que puede tardar) y, si llegan varios
// seguidos para lo mismo, solo se aplica el último (así el control sigue al dedo sin acumular retraso).
const latest = new Map();
function svclLatest(key, args) {
  const cur = latest.get(key);
  if (cur) { cur.args = args; return cur.promise; }
  const slot = { args, promise: null };
  slot.promise = (async () => {
    try {
      while (true) {
        const a = slot.args;
        await execSvcl(a);
        if (slot.args === a) break;
      }
    } finally { latest.delete(key); }
  })();
  latest.set(key, slot);
  return slot.promise;
}

/* ---------- Ayudante de audio rápido (API de audio de Windows, sin abrir svcl.exe cada vez) ---------- */

const FA_PS1 = app.isPackaged ? path.join(process.resourcesPath, 'audio.ps1') : path.join(__dirname, 'scripts', 'audio.ps1');
const fa = { proc: null, ready: false, seq: 0, wait: new Map(), buf: '', startedAt: 0, dead: false };

function faStop() {
  for (const w of fa.wait.values()) { clearTimeout(w.timer); w.resolve(false); }
  fa.wait.clear();
  fa.proc = null; fa.ready = false; fa.buf = '';
}

function startFastAudio() {
  if (fa.proc || fa.dead || process.platform !== 'win32' || !fs.existsSync(FA_PS1)) return;
  if (Date.now() - fa.startedAt < 10000) return;
  fa.startedAt = Date.now();
  try {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', FA_PS1],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    fa.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      fa.buf += d;
      let i;
      while ((i = fa.buf.indexOf('\n')) >= 0) {
        const line = fa.buf.slice(0, i).replace(/\r$/, '');
        fa.buf = fa.buf.slice(i + 1);
        if (line === 'READY') { fa.ready = true; continue; }
        if (line.startsWith('FAIL')) { fa.dead = true; continue; }
        const [id, res] = line.split('\t');
        const w = fa.wait.get(id);
        if (w) { clearTimeout(w.timer); fa.wait.delete(id); w.resolve(res === 'OK'); }
      }
    });
    proc.stdin.on('error', () => {});
    proc.on('exit', () => { if (fa.proc === proc) faStop(); });
    proc.on('error', () => { if (fa.proc === proc) faStop(); });
  } catch { faStop(); }
}

// Devuelve true si el ayudante aplicó el cambio; false para que se use svcl.exe como respaldo.
function fastAudio(cmd, target, num) {
  startFastAudio();
  if (!fa.proc || !fa.ready || !target) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = String(++fa.seq);
    const timer = setTimeout(() => { fa.wait.delete(id); resolve(false); }, 1500);
    fa.wait.set(id, { resolve, timer });
    try { fa.proc.stdin.write(`${id}\t${cmd}\t${Buffer.from(String(target), 'utf8').toString('base64')}\t${num}\n`); }
    catch { clearTimeout(timer); fa.wait.delete(id); resolve(false); }
  });
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

const itemIds = new Map(); // id de línea de comandos (svcl) -> id interno del dispositivo en Windows
async function listDevices(preRows) {
  const rows = preRows || (await readItems());
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const iName = col('name'), iType = col('type'), iDir = col('direction'), iDef = col('default');
  const iState = col('device state'), iMute = col('muted'), iVol = col('volume percent');
  const iId = col('command-line friendly id'), iDev = col('device name'), iItem = col('item id');
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
    const cid = (r[iId] || '').trim();
    if (iItem >= 0 && cid) itemIds.set(cid, (r[iItem] || '').trim());
    out[kind].push({
      id: cid,
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
ipcMain.handle('audio:setVolume', async (_, id, pct) => {
  if (!validId(id)) return;
  micWatch.lastSetAt = Date.now();
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (await fastAudio('EV', itemIds.get(id), v)) return;
  return svclLatest('dev|' + id, ['/SetVolume', id, String(v)]);
});
ipcMain.handle('audio:toggleMute', async (_, id, muted) => {
  if (!validId(id)) return;
  if (typeof muted === 'boolean') {
    if (await fastAudio('EM', itemIds.get(id), muted ? 1 : 0)) return;
    return svclLatest('devm|' + id, [muted ? '/Mute' : '/Unmute', id]);
  }
  return svcl(['/Switch', id]);
});
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
const micSeen = new Set();
const MIC_APPS = /discord|teams|zoom|skype|telegram|whatsapp|slack|obs|webex|viber|signal|teamspeak|ts3client|mumble|streamlabs|medal|overwolf|guilded|element|steam\.exe|meet/i;
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
    .filter((g) => !/system ?sounds|sonidos del sistema|systemsounds/i.test(`${g.name} ${g.target}`) && !/audiosrv/i.test(g.procPath || ''))
    .filter((g) => g.render || (g.capture && g.capture.active))
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  for (const a of list) a.icon = await iconFor(a.procPath);

  const defOut = (outs.find((d) => d.isDefault) || {}).id;
  const defIn = (ins.find((d) => d.isDefault) || {}).id;
  const apps = list.map((a) => {
    const canRoute = /\.exe$/i.test(a.target);
    if (a.capture) micSeen.add(a.key);
    // Programas de llamadas/streaming: el selector de micrófono se ofrece aunque ahora mismo no estén
    // usando el micrófono (Discord, por ejemplo, solo abre una sesión de entrada dentro de una llamada).
    const showIn = canRoute && (!!a.capture || micSeen.has(a.key) || MIC_APPS.test(a.target));
    const main = a.render || a.capture;
    return {
      key: a.key, target: a.target, name: a.name, icon: a.icon, canRoute,
      hasOut: !!a.render, hasIn: !!a.capture, showIn,
      volume: main.volume, muted: main.muted,
      active: a.render ? a.render.active : false,
      micActive: a.capture ? a.capture.active : false,
      out: a.render ? routeInfo(a.key + '|out', a.render, outs, defOut) : null,
      in: a.capture ? routeInfo(a.key + '|in', a.capture, ins, defIn) : (showIn ? routeInfo(a.key + '|in', { deviceRaw: '' }, ins, defIn) : null),
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
ipcMain.handle('apps:setVolume', async (_, t, pct) => {
  if (!validTarget(t)) return;
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (/\.exe$/i.test(t) && await fastAudio('AV', t, v)) return;
  return svclLatest('app|' + t.toLowerCase(), ['/SetVolume', t, String(v)]);
});
ipcMain.handle('apps:setDevice', async (_, t, deviceId, kind) => {
  if (!validTarget(t)) return;
  if (deviceId && !validTarget(deviceId)) return;
  const isIn = kind === 'input';
  const fallback = isIn ? 'DefaultCaptureDevice' : 'DefaultRenderDevice';
  await svcl(['/SetAppDefault', deviceId || fallback, 'all', t]);
  appDevices.set(t.toLowerCase() + (isIn ? '|in' : '|out'), deviceId || 'default');
});
ipcMain.handle('apps:setMute', async (_, t, muted) => {
  if (!validTarget(t)) return;
  if (/\.exe$/i.test(t) && await fastAudio('AM', t, muted ? 1 : 0)) return;
  return svclLatest('appm|' + t.toLowerCase(), [muted ? '/Mute' : '/Unmute', t]);
});

/* ---------- Vigilante del volumen del micrófono ---------- */

// Cada 5 s mira el volumen del micrófono predeterminado. Si baja sin que lo haya movido esta app,
// guarda la hora y qué programas estaban usando el micrófono en ese momento (pista del culpable).
// La lista se ve en "Copiar diagnóstico de sensores".
function micUsers(rows) {
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const iType = h.indexOf('type'), iDir = h.indexOf('direction'), iState = h.indexOf('device state');
  const iName = h.indexOf('name'), iPath = h.indexOf('process path');
  const names = new Set();
  if (iType < 0 || iDir < 0) return [];
  for (const r of rows.slice(1)) {
    if (!/^application$/i.test((r[iType] || '').trim()) || !/capture/i.test(r[iDir] || '')) continue;
    if (iState >= 0 && !/^active$/i.test((r[iState] || '').trim())) continue;
    const pp = iPath >= 0 ? (r[iPath] || '').trim() : '';
    names.add(pp ? path.win32.basename(pp) : (iName >= 0 ? (r[iName] || '').trim() : '?'));
  }
  return [...names];
}

async function micWatchTick() {
  if (micWatch.busy) return;
  micWatch.busy = true;
  try {
    const rows = await readItems();
    const def = (await listDevices(rows)).input.find((d) => d.isDefault);
    if (!def) { micWatch.id = ''; micWatch.vol = null; return; }
    if (def.id !== micWatch.id) { micWatch.id = def.id; micWatch.vol = def.volume; return; }
    const ours = Date.now() - micWatch.lastSetAt < 8000;
    if (micWatch.vol != null && def.volume <= micWatch.vol - 3 && !ours) {
      micWatch.log.push({
        at: new Date().toLocaleTimeString('es'),
        device: def.name, from: Math.round(micWatch.vol), to: Math.round(def.volume), apps: micUsers(rows),
      });
      if (micWatch.log.length > 30) micWatch.log.shift();
    }
    micWatch.vol = def.volume;
  } catch {} finally { micWatch.busy = false; }
}

function startMicWatch() {
  if (micWatch.timer) return;
  micWatch.timer = setInterval(micWatchTick, 5000);
}

/* ---------- Audífonos Corsair (preset de ecualizador y batería, vía SDK de iCUE) ---------- */

// Un ayudante de PowerShell (sin administrador) lee los datos del SDK de iCUE y los deja en estado.json.
// Solo se activa si la DLL del SDK viene incluida en la app (bin/iCUESDK.x64_2019.dll).
const HS_DLL = app.isPackaged ? path.join(process.resourcesPath, 'iCUESDK.x64_2019.dll') : path.join(__dirname, 'bin', 'iCUESDK.x64_2019.dll');
const HS_PS1 = app.isPackaged ? path.join(process.resourcesPath, 'audifonos.ps1') : path.join(__dirname, 'scripts', 'audifonos.ps1');
const hsDir = () => path.join(app.getPath('userData'), 'audifonos');
let hsProc = null, hsStartedAt = 0;

function startHeadsetHelper() {
  if (hsProc || Date.now() - hsStartedAt < 15000 || !fs.existsSync(HS_DLL) || !fs.existsSync(HS_PS1)) return;
  hsStartedAt = Date.now();
  try {
    hsProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', HS_PS1, '-ParentPid', String(process.pid), '-DllPath', HS_DLL, '-DataDir', hsDir()],
    { windowsHide: true, stdio: 'ignore' });
    hsProc.on('exit', () => { hsProc = null; });
    hsProc.on('error', () => { hsProc = null; });
  } catch { hsProc = null; }
}

ipcMain.handle('hs:state', () => {
  if (!fs.existsSync(HS_DLL)) return { available: false };
  startHeadsetHelper();
  const file = path.join(hsDir(), 'estado.json');
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(file).mtimeMs < 6000; } catch {}
  const j = fresh ? readJsonFile(file) : null;
  return j ? { available: true, running: true, ...j } : { available: true, running: false };
});

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
const NV_BASE = 'name,utilization.gpu,temperature.gpu,memory.used,memory.total,fan.speed';
let nvFields = null; // campos que este controlador acepta (el margen térmico solo existe en controladores nuevos)
async function readNvidia() {
  if (Date.now() < nvMissingUntil) return [];
  const cands = nvPath ? [nvPath] : [
    'nvidia-smi',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];
  const fieldSets = nvFields ? [nvFields] : [`${NV_BASE},temperature.gpu.tlimit`, NV_BASE];
  for (const c of cands) {
    for (const fields of fieldSets) {
      try {
        const out = await new Promise((res, rej) => execFile(c,
          [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'],
          { windowsHide: true, timeout: 3000 }, (e, so) => (e ? rej(e) : res(so))));
        const lines = String(out).split(/\r?\n/).filter((l) => l.trim());
        if (!lines.length) continue;
        nvPath = c; nvFields = fields;
        return lines.map((line) => {
          const p = line.split(',').map((x) => x.trim());
          const temp = toNum(p[2]);
          // El controlador informa cuántos grados faltan para que la tarjeta empiece a bajar rendimiento:
          // temperatura actual + margen = límite real de esta tarjeta.
          const margin = toNum(p[6]);
          const lim = temp != null && margin != null && margin > 0 ? temp + margin : null;
          return { vendor: 'nvidia', name: p[0], usage: toNum(p[1]), temp, tempLimit: lim && lim >= 70 && lim <= 115 ? lim : null,
                   vramUsed: toNum(p[3]), vramTotal: toNum(p[4]), fan: toNum(p[5]), source: 'nvidia-smi' };
        });
      } catch {}
    }
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
function buildGpus(nvidia, lhmSensors, cpuTemp) {
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
  // Las gráficas integradas (Radeon Vega/Graphics del Ryzen, Intel UHD/Iris) no tienen sensor propio:
  // viven dentro del mismo chip que la CPU, así que se muestra la temperatura del chip.
  for (const g of gpus) {
    const integrated = g.vendor === 'intel' || (g.vendor === 'amd' && !/\bRX\b|Radeon Pro|\bR[579]\s*\d{3}|\bW\d{4}/i.test(g.name || ''));
    if (g.temp == null && integrated && cpuTemp != null) { g.temp = cpuTemp; g.tempShared = true; }
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
  // Intel informa su "distancia a TjMax" por núcleo: temperatura del núcleo + distancia = límite real del procesador.
  // AMD no lo informa, y entonces la app usa los valores fijos.
  let cpuLimit = null;
  for (const d of sensors) {
    if (!/^\/intelcpu\//.test(d.id) || d.type !== 'temperature' || d.value == null || !/distance to tjmax/i.test(d.name)) continue;
    const coreName = d.name.replace(/\s*distance to tjmax/i, '').trim();
    const core = sensors.find((x) => x.id.startsWith(d.id.split('/').slice(0, 3).join('/')) && x.type === 'temperature' && x.name === coreName && x.value != null);
    if (core) { const lim = core.value + d.value; if (lim >= 80 && lim <= 125) { cpuLimit = Math.round(lim); break; } }
  }
  return {
    cpuLimit,
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
  for (const a of fpsState.apps.values()) a.batch = null; // FPS de la lectura actual (solo si llegaron fotogramas nuevos)
  const touched = new Map();
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
      fpsState.header = { app: h.indexOf('application'), ft: iFt, pid: h.indexOf('processid'), cols: h.length };
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
    const { app: ia, ft: ift, pid: ipid } = fpsState.header;
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
      const pidv = ipid >= 0 ? parseInt(c[ipid], 10) : 0;
      if (pidv > 0) a.pid = pidv;
      if (Number.isFinite(ft) && ft > 0.2 && ft < 2000) {
        a.frames.push({ t: now, ft });
        const t = touched.get(name) || { n: 0, sum: 0 };
        t.n++; t.sum += ft; touched.set(name, t);
      }
    }
  } catch (e) { fpsState.err = `${e.code || ''} ${e.message}`.trim(); } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  // FPS de esta lectura = fotogramas recibidos / tiempo que sumaron esos fotogramas
  for (const [name, t] of touched) {
    const a = fpsState.apps.get(name);
    if (a && t.n >= 5 && t.sum > 0) a.batch = { fps: (1000 * t.n) / t.sum, n: t.n };
  }
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
    if (!best || fps > best.fps) best = { app: name, name: base, fps, pid: a.pid || 0, batch: a.batch || null };
  }
  return best;
}


// FPS más bajo y más alto de la sesión: cada valor es el promedio de una lectura (~1 s).
// Se ignoran los primeros 5 s del juego (pantallas de carga al abrir). Se reinicia al cambiar de juego.
let gameStats = { app: '', min: null, max: null, since: 0, lastSeen: 0 };
function trackFps(game) {
  const now = Date.now();
  if (!game) { if (now - gameStats.lastSeen > 15000) gameStats = { app: '', min: null, max: null, since: 0, lastSeen: 0 }; return; }
  if (gameStats.app !== game.app) gameStats = { app: game.app, min: null, max: null, since: now, lastSeen: now };
  gameStats.lastSeen = now;
  if (now - gameStats.since < 5000 || !game.batch) return;
  const v = game.batch.fps;
  if (v < 1) return;
  if (gameStats.min == null || v < gameStats.min) gameStats.min = v;
  if (gameStats.max == null || v > gameStats.max) gameStats.max = v;
}
ipcMain.handle('game:resetStats', () => { gameStats.min = null; gameStats.max = null; gameStats.since = Date.now() - 5000; });

// Qué tarjeta gráfica usa el juego: Windows mide el uso por proceso y por tarjeta (contadores "GPU Engine").
// Se acumula durante la sesión y gana la tarjeta con más trabajo. También se lee la ruta del .exe del juego.
const GPU_PREF_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const gameGpu = { pid: 0, path: '', pref: null, acc: new Map(), at: 0, busy: false, luidNames: null, luidAt: 0, luidBusy: false };
const psEncoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
const luidKey = (hi, lo) => ((BigInt('0x' + hi) << 32n) | BigInt('0x' + lo)).toString();

function loadLuidNames() {
  if (gameGpu.luidBusy || (gameGpu.luidNames && Date.now() - gameGpu.luidAt < 600000)) return;
  gameGpu.luidBusy = true;
  const script = `Get-PnpDevice -Class Display -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {
  $l = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName '{60b193cb-5276-4d0f-96fc-f173abad3ec6} 2' -ErrorAction SilentlyContinue).Data
  "LUID|$l|$($_.FriendlyName)"
}`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(script)],
    { windowsHide: true, timeout: 15000 }, (err, so) => {
      gameGpu.luidBusy = false;
      gameGpu.luidAt = Date.now();
      const map = new Map();
      if (!err) for (const line of String(so).split(/\r?\n/)) {
        const m = line.match(/^LUID\|(\d+)\|(.+)$/);
        if (m) map.set(m[1], m[2].trim());
      }
      gameGpu.luidNames = map;
    });
}

function readGpuPref() {
  if (!gameGpu.path) return;
  execFile('reg.exe', ['query', GPU_PREF_KEY, '/v', gameGpu.path], { windowsHide: true, timeout: 5000 }, (err, so) => {
    const m = !err && String(so).match(/GpuPreference=(\d)/i);
    gameGpu.pref = m ? Number(m[1]) : 0;
  });
}

function pollGameGpu(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (gameGpu.pid !== pid) Object.assign(gameGpu, { pid, path: '', pref: null, acc: new Map(), at: 0 });
  loadLuidNames();
  if (gameGpu.busy || Date.now() - gameGpu.at < 5000) return;
  gameGpu.busy = true;
  gameGpu.at = Date.now();
  const script = `$p = ${pid}
try { 'PATH|' + (Get-Process -Id $p -ErrorAction Stop).Path } catch {}
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Filter "Name LIKE 'pid_${pid}_%'" -ErrorAction SilentlyContinue | ForEach-Object { 'ENG|' + $_.Name + '|' + $_.UtilizationPercentage }`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(script)],
    { windowsHide: true, timeout: 15000 }, (err, so) => {
      gameGpu.busy = false;
      if (err || gameGpu.pid !== pid) return;
      for (const line of String(so).split(/\r?\n/)) {
        const pm = line.match(/^PATH\|(.+\.exe)\s*$/i);
        if (pm && !gameGpu.path) { gameGpu.path = pm[1]; readGpuPref(); }
        const em = line.match(/^ENG\|pid_(\d+)_luid_0x([0-9a-f]+)_0x([0-9a-f]+)_phys_(\d+)_eng_\d+_engtype_([^|]+)\|([\d.]+)/i);
        if (!em || Number(em[1]) !== pid || !/3D|graphics|compute/i.test(em[5])) continue;
        const key = luidKey(em[2], em[3]);
        const cur = gameGpu.acc.get(key) || { sum: 0, phys: Number(em[4]) };
        cur.sum += parseFloat(em[6]) || 0;
        gameGpu.acc.set(key, cur);
      }
    });
}

function gameGpuInfo() {
  let best = null, bestKey = '';
  for (const [k, v] of gameGpu.acc) if (v.sum > 0 && (!best || v.sum > best.sum)) { best = v; bestKey = k; }
  const hasNvidia = (gpuNames || []).some((n) => vendorOf(n) === 'nvidia');
  let gpu = null;
  if (best) {
    const name = (gameGpu.luidNames && gameGpu.luidNames.get(bestKey)) || '';
    gpu = { name: name || `Tarjeta gráfica ${best.phys + 1}`, vendor: name ? vendorOf(name) : 'otra', known: !!name };
  }
  return { gpu, hasNvidia, canSet: !!gameGpu.path, pref: gameGpu.pref };
}

ipcMain.handle('game:setGpu', (_, pref) => new Promise((resolve) => {
  const p = Number(pref);
  if (![0, 1, 2].includes(p) || !gameGpu.path) return resolve({ ok: false });
  const args = p === 0
    ? ['delete', GPU_PREF_KEY, '/v', gameGpu.path, '/f']
    : ['add', GPU_PREF_KEY, '/v', gameGpu.path, '/t', 'REG_SZ', '/d', `GpuPreference=${p};`, '/f'];
  execFile('reg.exe', args, { windowsHide: true, timeout: 5000 }, (err) => {
    // borrar un valor que no existe da error, y entonces ya está en "Windows decide"
    if (err && p !== 0) return resolve({ ok: false });
    gameGpu.pref = p;
    resolve({ ok: true });
  });
}));

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
  const gpus = buildGpus(nvidia, lhmSensors, lhm ? lhm.cpuTemp : null);
  const helper = helperActive();
  const total = os.totalmem(), free = os.freemem();

  let game = null;
  if (helper) { ingestFps(); game = currentGame(); } else if (fpsState.apps.size) resetFps();
  const cpuTemp = lhm ? lhm.cpuTemp : null;
  trackFps(game);
  if (game) pollGameGpu(game.pid);

  // Punto más caliente: el sensor de temperatura más alto de todo el equipo (no es un promedio)
  let hottest = lhm && lhm.general ? lhm.general : null;
  gpus.forEach((g, i) => {
    if (g.temp != null && (!hottest || g.temp > hottest.value)) hottest = { value: g.temp, name: gpus.length > 1 ? `GPU ${i + 1}` : 'GPU' };
  });

  return {
    cpu: { usage: cpu.usage, maxCore: cpu.maxCore, temp: cpuTemp, tempLimit: lhm ? lhm.cpuLimit : null, cores: os.cpus().length, model: (os.cpus()[0] || {}).model || '' },
    gpus,
    ram: { used: total - free, total },
    fans: (lhm && lhm.fans.length) ? lhm.fans : wmiFans(),
    general: hottest,
    sensors: { lhm: !!lhm, helper, hasFiles: fs.existsSync(HELPER_PS1) },
    game: game ? { name: game.name, fps: game.fps, min: gameStats.min, max: gameStats.max, ...gameGpuInfo() } : null,
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

  L.push('', '── Volumen del micrófono: bajadas que NO hizo esta app ──');
  if (!micWatch.log.length) L.push('Ninguna detectada desde que se abrió la app (vigila cada 5 s).');
  else for (const m of micWatch.log.slice(-10)) L.push(`${m.at} · ${m.device}: ${m.from}% → ${m.to}% · usando el micrófono: ${m.apps.join(', ') || 'ningún programa'}`);

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
    startMicWatch();
    startFastAudio();
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
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (hsProc) { try { hsProc.kill(); } catch {} }
    if (fa.proc) { try { fa.proc.kill(); } catch {} }
  });
}
