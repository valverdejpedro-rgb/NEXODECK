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

async function listDevices() {
  const tmp = path.join(os.tmpdir(), `centro-control-${process.pid}.csv`);
  await svcl(['/scomma', tmp]);
  const buf = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch {}
  const rows = parseCsv(decode(buf));
  if (!rows.length) throw new Error('svcl.exe no devolvió dispositivos');

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
    width: b.width || 460,
    height: b.height || 430,
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
