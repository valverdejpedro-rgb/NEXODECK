const KINDS = ['output', 'input'];
const panels = {};
for (const kind of KINDS) {
  const el = document.querySelector(`.panel[data-kind="${kind}"]`);
  panels[kind] = {
    el,
    select: el.querySelector('.device'),
    slider: el.querySelector('.slider'),
    pct: el.querySelector('.pct'),
    mute: el.querySelector('.mute'),
    devices: [],
    current: null,
    dragging: false,
    sendTimer: null,
    signature: '',
  };
}
const errorEl = document.getElementById('error');
const versionEl = document.getElementById('version');
const updateEl = document.getElementById('update');
let busy = 0;

function paintSlider(p, value) {
  p.slider.style.setProperty('--v', value + '%');
  p.pct.textContent = Math.round(value);
}

function render(state) {
  for (const kind of KINDS) {
    const p = panels[kind];
    p.devices = state[kind] || [];
    p.current = p.devices.find((d) => d.isDefault) || p.devices[0] || null;

    const sig = p.devices.map((d) => d.id + '|' + d.name + '|' + d.isDefault).join('\n');
    if (sig !== p.signature) {
      p.signature = sig;
      p.select.replaceChildren(
        ...p.devices.map((d) => {
          const o = document.createElement('option');
          o.value = d.id;
          o.textContent = d.name;
          return o;
        })
      );
      if (!p.devices.length) {
        const o = document.createElement('option');
        o.textContent = kind === 'output' ? 'Sin dispositivos de salida' : 'Sin dispositivos de entrada';
        p.select.replaceChildren(o);
      }
    }
    p.select.disabled = !p.devices.length;
    p.slider.disabled = !p.current;
    p.mute.disabled = !p.current;
    if (!p.current) { paintSlider(p, 0); p.el.classList.remove('muted'); continue; }

    p.select.value = p.current.id;
    p.el.classList.toggle('muted', p.current.muted);
    p.mute.setAttribute('aria-pressed', String(p.current.muted));
    if (!p.dragging) {
      p.slider.value = p.current.volume;
      paintSlider(p, p.current.volume);
    }
  }
}

function showError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || '';
}

async function refresh() {
  if (busy) return;
  try {
    render(await window.api.getState());
    showError('');
  } catch (e) {
    showError('No se pudo leer el audio. Revisa que bin/svcl.exe esté incluido en la app.');
  }
}

async function act(fn) {
  busy++;
  try { await fn(); } catch {} finally { busy--; }
  refresh();
}

for (const kind of KINDS) {
  const p = panels[kind];

  p.slider.addEventListener('pointerdown', () => { p.dragging = true; });
  p.slider.addEventListener('input', () => {
    const v = Number(p.slider.value);
    paintSlider(p, v);
    if (!p.current) return;
    clearTimeout(p.sendTimer);
    p.sendTimer = setTimeout(() => window.api.setVolume(p.current.id, v), 40);
  });
  p.slider.addEventListener('change', () => {
    p.dragging = false;
    if (p.current) act(() => window.api.setVolume(p.current.id, Number(p.slider.value)));
  });

  p.el.addEventListener('wheel', (e) => {
    if (!p.current) return;
    e.preventDefault();
    const v = Math.max(0, Math.min(100, Number(p.slider.value) + (e.deltaY < 0 ? 5 : -5)));
    p.slider.value = v;
    paintSlider(p, v);
    clearTimeout(p.sendTimer);
    p.sendTimer = setTimeout(() => act(() => window.api.setVolume(p.current.id, v)), 60);
  }, { passive: false });

  p.mute.addEventListener('click', () => {
    if (p.current) act(() => window.api.toggleMute(p.current.id));
  });

  p.select.addEventListener('change', () => {
    act(() => window.api.setDefault(p.select.value));
  });
}

function renderUpdate(s) {
  updateEl.replaceChildren();
  if (!s || s.state === 'idle') return;
  if (s.state === 'downloading') updateEl.textContent = `Descargando la versión ${s.version}…`;
  else if (s.state === 'none') updateEl.textContent = 'Estás al día';
  else if (s.state === 'ready') {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `Reiniciar para actualizar a ${s.version}`;
    b.addEventListener('click', () => window.api.installUpdate());
    updateEl.appendChild(b);
  }
}

window.api.onUpdate(renderUpdate);
window.api.onShown(() => refreshActive());
window.api.info().then((i) => {
  versionEl.textContent = `Versión ${i.version}`;
  renderUpdate(i.update);
});


/* ---------- Pestañas ---------- */

const tabBtns = [...document.querySelectorAll('.tab')];
const tabPanels = {
  devices: document.getElementById('tab-devices'),
  apps: document.getElementById('tab-apps'),
  power: document.getElementById('tab-power'),
  system: document.getElementById('tab-system'),
};
let activeTab = 'devices';

function refreshActive() {
  if (activeTab === 'apps') return refreshApps();
  if (activeTab === 'power') return refreshPower();
  if (activeTab === 'system') return refreshSystem();
  return refresh();
}

function setTab(name) {
  activeTab = name;
  for (const b of tabBtns) {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const [k, el] of Object.entries(tabPanels)) el.hidden = k !== name;
  refreshActive();
}

tabBtns.forEach((b, i) => {
  b.addEventListener('click', () => setTab(b.dataset.tab));
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabBtns[(i + (e.key === 'ArrowRight' ? 1 : tabBtns.length - 1)) % tabBtns.length];
    next.focus();
    setTab(next.dataset.tab);
  });
});

/* ---------- Audio por aplicación ---------- */

const appsListEl = document.getElementById('apps-list');
const appsEmptyEl = document.getElementById('apps-empty');
const appsErrorEl = document.getElementById('apps-error');
const appsCountEl = document.getElementById('apps-count');
const appRows = new Map();
let appsBusy = 0;
let appsOrder = '';

const APP_TEMPLATE = `
  <div class="app-top">
    <img class="app-icon" alt="" hidden>
    <span class="app-name"></span>
    <span class="app-state"></span>
  </div>
  <div class="head app-route app-out">
    <span class="lbl">Salida</span>
    <select class="device dev-out"></select>
  </div>
  <p class="app-hint hint-out" hidden>Cambio pendiente: la app lo aplicará cuando reinicie su audio (pausa y reproduce, o ábrela de nuevo).</p>
  <div class="head app-route app-in">
    <span class="lbl">Entrada</span>
    <select class="device dev-in"></select>
  </div>
  <p class="app-hint hint-in" hidden>Cambio pendiente: la app lo aplicará cuando vuelva a abrir el micrófono (cuelga y vuelve a llamar, o ábrela de nuevo).</p>
  <div class="control">
    <button class="mute" type="button" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9v6h4l5 4V5L8 9H4z"/>
        <path class="waves" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>
        <path class="slash" d="M3.5 3.5l17 17"/>
      </svg>
    </button>
    <input class="slider" type="range" min="0" max="100" step="1" value="0">
    <output class="pct">0</output>
  </div>`;

function paintApp(row, value) {
  row.slider.style.setProperty('--v', value + '%');
  row.pct.textContent = Math.round(value);
}

async function actApps(fn) {
  appsBusy++;
  try { await fn(); } catch {} finally { appsBusy--; }
  setTimeout(refreshApps, 250);
}

function appStateText(a) {
  if (a.muted) return 'Silenciada';
  if (a.active) return 'Sonando';
  if (a.micActive) return 'Usando el micrófono';
  return 'En silencio';
}

function makeAppRow() {
  const el = document.createElement('section');
  el.className = 'panel app-row';
  el.innerHTML = APP_TEMPLATE;
  const row = {
    el,
    icon: el.querySelector('.app-icon'),
    name: el.querySelector('.app-name'),
    state: el.querySelector('.app-state'),
    outRoute: el.querySelector('.app-out'),
    outSelect: el.querySelector('.dev-out'),
    outHint: el.querySelector('.hint-out'),
    inRoute: el.querySelector('.app-in'),
    inSelect: el.querySelector('.dev-in'),
    inHint: el.querySelector('.hint-in'),
    control: el.querySelector('.control'),
    mute: el.querySelector('.mute'),
    slider: el.querySelector('.slider'),
    pct: el.querySelector('.pct'),
    target: '', muted: false, active: false, micActive: false, dragging: false, timer: null, sigOut: '', sigIn: '',
  };

  row.slider.addEventListener('pointerdown', () => { row.dragging = true; });
  row.slider.addEventListener('input', () => {
    const v = Number(row.slider.value);
    paintApp(row, v);
    clearTimeout(row.timer);
    row.timer = setTimeout(() => window.api.setAppVolume(row.target, v), 60);
  });
  row.slider.addEventListener('change', () => {
    row.dragging = false;
    actApps(() => window.api.setAppVolume(row.target, Number(row.slider.value)));
  });
  // La rueda solo actúa sobre el control de volumen, para poder desplazar la lista con normalidad.
  row.control.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = Math.max(0, Math.min(100, Number(row.slider.value) + (e.deltaY < 0 ? 5 : -5)));
    row.slider.value = v;
    paintApp(row, v);
    clearTimeout(row.timer);
    row.timer = setTimeout(() => actApps(() => window.api.setAppVolume(row.target, v)), 80);
  }, { passive: false });
  row.mute.addEventListener('click', () => {
    const next = !row.muted;
    row.muted = next;                       // se ve al instante, sin esperar a Windows
    row.el.classList.toggle('muted', next);
    row.mute.setAttribute('aria-pressed', String(next));
    row.state.textContent = appStateText(row);
    actApps(() => window.api.setAppMute(row.target, next));
  });
  row.outSelect.addEventListener('change', () => actApps(() => window.api.setAppDevice(row.target, row.outSelect.value, 'output')));
  row.inSelect.addEventListener('change', () => actApps(() => window.api.setAppDevice(row.target, row.inSelect.value, 'input')));
  return row;
}

function fillDeviceSelect(select, devices) {
  const first = document.createElement('option');
  first.value = '';
  first.textContent = 'Predeterminado del sistema';
  select.replaceChildren(first, ...devices.map((d) => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    return o;
  }));
}

function updateRoute(route, select, hint, info, show, devices, sigKey, row) {
  route.hidden = !show;
  hint.hidden = !(show && info && info.pending);
  if (!show || !info) return;
  const sig = devices.map((d) => d.id + '|' + d.name).join('\n');
  if (row[sigKey] !== sig) { row[sigKey] = sig; fillDeviceSelect(select, devices); }
  select.title = info.deviceRaw ? `Detectado: ${info.deviceRaw}` : '';
  if (document.activeElement !== select) {
    select.value = devices.some((d) => d.id === info.deviceId) ? info.deviceId : '';
  }
}

function updateAppRow(row, a, devices, inputs) {
  row.target = a.target;
  row.muted = a.muted;
  row.active = a.active;
  row.micActive = a.micActive;
  row.name.textContent = a.name;
  row.name.title = a.target;
  row.state.textContent = appStateText(a);
  row.el.classList.toggle('playing', (a.active || a.micActive) && !a.muted);
  row.el.classList.toggle('muted', a.muted);
  row.mute.setAttribute('aria-pressed', String(a.muted));
  row.mute.setAttribute('aria-label', `Silenciar ${a.name}`);
  row.slider.setAttribute('aria-label', `Volumen de ${a.name}`);
  row.outSelect.setAttribute('aria-label', `Dispositivo de salida de ${a.name}`);
  row.inSelect.setAttribute('aria-label', `Dispositivo de entrada de ${a.name}`);

  if (a.icon) {
    if (row.icon.src !== a.icon) row.icon.src = a.icon;
    row.icon.hidden = false;
  } else row.icon.hidden = true;

  updateRoute(row.outRoute, row.outSelect, row.outHint, a.out, a.canRoute && a.hasOut, devices, 'sigOut', row);
  updateRoute(row.inRoute, row.inSelect, row.inHint, a.in, a.canRoute && a.hasIn, inputs, 'sigIn', row);

  row.control.hidden = !a.hasOut; // una app que solo usa el micrófono no tiene volumen de salida
  if (!row.dragging) {
    row.slider.value = a.volume;
    paintApp(row, a.volume);
  }
}

function renderApps({ apps, devices, inputs }) {
  const seen = new Set();
  for (const a of apps) {
    seen.add(a.key);
    let row = appRows.get(a.key);
    if (!row) {
      row = makeAppRow();
      appRows.set(a.key, row);
      appsListEl.appendChild(row.el);
      appsOrder = '';
    }
    updateAppRow(row, a, devices, inputs || []);
  }
  for (const [key, row] of appRows) {
    if (!seen.has(key)) { row.el.remove(); appRows.delete(key); appsOrder = ''; }
  }
  // Orden alfabético; solo se recoloca si cambió, para no romper un arrastre en curso.
  const order = apps.map((a) => a.key).join('|');
  if (order !== appsOrder && ![...appRows.values()].some((r) => r.dragging)) {
    for (const a of apps) appsListEl.appendChild(appRows.get(a.key).el);
    appsOrder = order;
  }
  appsEmptyEl.hidden = apps.length > 0;
  appsCountEl.textContent = apps.length === 1 ? '1 aplicación' : `${apps.length} aplicaciones`;
}

async function refreshApps() {
  if (appsBusy) return;
  try {
    renderApps(await window.api.getApps());
    appsErrorEl.hidden = true;
  } catch {
    appsErrorEl.hidden = false;
    appsErrorEl.textContent = 'No se pudo leer el audio de las aplicaciones. Revisa que svcl.exe esté incluido en la app.';
  }
}

/* ---------- Perfiles de energía ---------- */

const powerListEl = document.getElementById('power-list');
const powerCountEl = document.getElementById('power-count');
const powerErrorEl = document.getElementById('power-error');
let powerBusy = 0;
let powerSig = '';

function renderPower(plans) {
  const sig = plans.map((p) => `${p.id}|${p.name}|${p.active}`).join('\n');
  if (sig === powerSig) return;
  powerSig = sig;
  powerListEl.replaceChildren(...plans.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'plan' + (p.active ? ' active' : '');
    b.setAttribute('aria-pressed', String(p.active));
    b.dataset.id = p.id;
    const dot = document.createElement('span');
    dot.className = 'plan-dot';
    const name = document.createElement('span');
    name.className = 'plan-name';
    name.textContent = p.name;
    const badge = document.createElement('span');
    badge.className = 'plan-badge';
    badge.textContent = p.active ? 'Activo' : '';
    b.append(dot, name, badge);
    b.addEventListener('click', () => choosePlan(p.id));
    return b;
  }));
  powerCountEl.textContent = plans.length === 1 ? '1 perfil de energía' : `${plans.length} perfiles de energía`;
}

async function choosePlan(id) {
  for (const b of powerListEl.children) {
    const on = b.dataset.id === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('.plan-badge').textContent = on ? 'Activo' : '';
  }
  powerBusy++;
  try {
    await window.api.setPower(id);
    powerErrorEl.hidden = true;
  } catch {
    powerErrorEl.hidden = false;
    powerErrorEl.textContent = 'No se pudo cambiar el perfil de energía.';
  } finally { powerBusy--; }
  powerSig = '';
  refreshPower();
}

async function refreshPower() {
  if (powerBusy) return;
  try {
    renderPower(await window.api.getPower());
    powerErrorEl.hidden = true;
  } catch {
    powerErrorEl.hidden = false;
    powerErrorEl.textContent = 'No se pudieron leer los perfiles de energía de Windows.';
  }
}

/* ---------- Estado del sistema ---------- */

const sysGridEl = document.getElementById('sys-grid');
const sysErrorEl = document.getElementById('sys-error');
const sysBannerEl = document.getElementById('sys-banner');
const sysBannerText = document.getElementById('sys-banner-text');
const sysEnableBtn = document.getElementById('sys-enable');
const sysGameEl = document.getElementById('sys-game');
const sysAlertEl = document.getElementById('sys-alert');
const sysAlertList = document.getElementById('sys-alert-list');
const sysCards = {};
let sysBusy = false;
let sysEnabling = false;
let sysOrder = '';

/* Umbrales de color: [aviso (ámbar), crítico (rojo)]. Cámbialos aquí si quieres más o menos sensibilidad. */
const LIMITS = {
  usage: [70, 90],     // uso de CPU / GPU (%)
  cpuTemp: [80, 90],   // °C
  gpuTemp: [75, 85],   // °C
  hottest: [80, 92],   // °C, sensor más caliente
  ram: [75, 90],       // % de RAM usada
  vram: [75, 92],      // % de VRAM usada
};

function mkStat(id, title) {
  const el = document.createElement('section');
  el.className = 'panel stat';
  el.innerHTML = `
    <div class="stat-head"><span class="stat-title"></span><span class="stat-sub"></span></div>
    <div class="stat-row"><span class="big">–</span><span class="unit"></span><span class="temp"></span></div>
    <div class="bar"><i></i></div>
    <p class="stat-note"></p>`;
  el.querySelector('.stat-title').textContent = title;
  sysCards[id] = {
    el,
    title: el.querySelector('.stat-title'),
    sub: el.querySelector('.stat-sub'),
    row: el.querySelector('.stat-row'),
    big: el.querySelector('.big'),
    unit: el.querySelector('.unit'),
    temp: el.querySelector('.temp'),
    barWrap: el.querySelector('.bar'),
    bar: el.querySelector('.bar i'),
    note: el.querySelector('.stat-note'),
  };
  if (id === 'fans') {
    const c = sysCards.fans;
    c.list = document.createElement('ul');
    c.list.className = 'fan-list';
    c.row.hidden = true;
    c.barWrap.hidden = true;
    c.el.insertBefore(c.list, c.note);
  }
}

// Crea las tarjetas que faltan, quita las que sobran y las coloca en orden (solo toca el DOM si cambió algo)
function syncCards(ids, titles) {
  for (const id of ids) {
    if (!sysCards[id]) mkStat(id, titles[id]);
    else if (sysCards[id].title.textContent !== titles[id]) sysCards[id].title.textContent = titles[id];
  }
  for (const id of Object.keys(sysCards)) {
    if (!ids.includes(id)) { sysCards[id].el.remove(); delete sysCards[id]; }
  }
  const key = ids.join('|');
  if (key !== sysOrder) {
    sysOrder = key;
    for (const id of ids) sysGridEl.appendChild(sysCards[id].el);
  }
}

// ok / warm / hot según los umbrales
const level = (v, lim) => (v == null ? '' : v >= lim[1] ? 'hot' : v >= lim[0] ? 'warm' : 'ok');
const fmtT = (t) => (t == null ? '' : `${Math.round(t)} °C`);
const gb = (mb) => (mb / 1024).toFixed(1);

function setStat(id, o) {
  const c = sysCards[id];
  c.sub.textContent = o.sub || '';
  c.big.textContent = o.big == null ? '–' : o.big;
  c.unit.textContent = o.unit || '';
  c.temp.textContent = o.temp || '';
  c.temp.dataset.level = o.tempLevel || '';
  c.barWrap.hidden = o.pct == null;
  if (o.pct != null) c.bar.style.width = Math.max(0, Math.min(100, o.pct)) + '%';
  c.el.dataset.level = o.level || '';
  c.el.dataset.alert = o.alert || '';
  c.note.textContent = o.note || '';
  c.note.hidden = !o.note;
}

/* FPS del juego (solo FPS) */
const GAME_TEMPLATE = `
  <div class="game-idle"></div>
  <div class="game-body" hidden>
    <div class="game-head"><span class="game-title"></span><span class="game-tag">Jugando</span></div>
    <div class="game-fps"><span class="big fps">–</span><span class="unit">FPS</span></div>
  </div>`;
sysGameEl.innerHTML = GAME_TEMPLATE;
const gm = {
  idle: sysGameEl.querySelector('.game-idle'),
  body: sysGameEl.querySelector('.game-body'),
  title: sysGameEl.querySelector('.game-title'),
  fps: sysGameEl.querySelector('.fps'),
};

function renderGame(s) {
  if (!s.sensors.helper) { sysGameEl.hidden = true; return; }
  sysGameEl.hidden = false;
  const g = s.game;
  gm.idle.hidden = !!g;
  gm.body.hidden = !g;
  if (!g) {
    gm.idle.textContent = 'Sin juego detectado. Abre un juego y aquí verás sus FPS.';
    return;
  }
  gm.title.textContent = g.name;
  gm.fps.textContent = Math.round(g.fps);
}

function renderBanner(s) {
  const sn = s.sensors;
  if (sn.helper && sn.lhm) { sysBannerEl.hidden = true; return; }
  sysBannerEl.hidden = false;
  if (!sn.hasFiles) {
    sysBannerText.textContent = 'Faltan componentes de sensores en esta versión de la app.';
    sysEnableBtn.hidden = true;
  } else if (sn.helper) {
    sysBannerText.textContent = 'Iniciando sensores… la primera vez puede tardar unos segundos.';
    sysEnableBtn.hidden = true;
  } else {
    if (!sysEnabling) sysBannerText.textContent = 'Para ver la temperatura del CPU, las demás tarjetas gráficas, los ventiladores y los FPS en juegos hay que activar los sensores avanzados. Windows pedirá permiso de administrador.';
    sysEnableBtn.hidden = false;
    sysEnableBtn.disabled = sysEnabling;
  }
}

/* Aviso de "equipo exigido": solo aparece si algo está en rojo varias lecturas seguidas
   y se quita tras varias lecturas normales, para que no parpadee. */
const alertState = new Map(); // clave -> { msg, on, streak }
function updateAlerts(found) {
  const now = new Map(found.map((f) => [f.key, f.msg]));
  for (const [key, msg] of now) {
    const a = alertState.get(key) || { msg, on: false, streak: 0 };
    a.msg = msg;
    a.streak = a.streak > 0 ? a.streak + 1 : 1;
    if (a.streak >= 3) a.on = true;
    alertState.set(key, a);
  }
  for (const [key, a] of alertState) {
    if (now.has(key)) continue;
    a.streak = a.streak < 0 ? a.streak - 1 : -1;
    if (a.streak <= -4) alertState.delete(key);
  }
  const active = [...alertState.values()].filter((a) => a.on);
  sysAlertEl.hidden = !active.length;
  sysAlertList.replaceChildren(...active.map((a) => { const li = document.createElement('li'); li.textContent = a.msg; return li; }));
}

function renderSystem(s) {
  const { cpu, gpus, ram } = s;
  const alerts = [];
  const multi = gpus.length > 1;

  const ids = ['cpu'];
  const titles = { cpu: 'CPU', ram: 'RAM', general: 'Punto más caliente', fans: 'Ventiladores' };
  gpus.forEach((g, i) => {
    ids.push(`gpu${i}`);
    titles[`gpu${i}`] = multi ? `GPU ${i + 1}` : 'GPU';
    if (g.vramTotal) { ids.push(`vram${i}`); titles[`vram${i}`] = multi ? `VRAM · GPU ${i + 1}` : 'VRAM'; }
  });
  ids.push('ram', 'general', 'fans');
  if (!gpus.length) { ids.splice(1, 0, 'gpu0'); titles.gpu0 = 'GPU'; }
  syncCards(ids, titles);

  const cpuTempLv = level(cpu.temp, LIMITS.cpuTemp);
  setStat('cpu', {
    sub: `${cpu.cores} hilos`,
    big: Math.round(cpu.usage), unit: '%',
    temp: fmtT(cpu.temp), tempLevel: cpuTempLv, alert: cpuTempLv,
    pct: cpu.usage, level: level(cpu.usage, LIMITS.usage),
    note: cpu.temp == null ? 'Temperatura: activa los sensores avanzados' : `Núcleo más cargado: ${Math.round(cpu.maxCore)}%`,
  });
  if (cpuTempLv === 'hot') alerts.push({ key: 'cpu-temp', msg: `CPU a ${Math.round(cpu.temp)} °C: está muy caliente.` });

  if (!gpus.length) {
    setStat('gpu0', { note: 'No se detectó ninguna tarjeta gráfica.' });
  }
  gpus.forEach((g, i) => {
    const label = multi ? `GPU ${i + 1}` : 'GPU';
    const hasData = g.usage != null || g.temp != null;
    const tLv = level(g.temp, LIMITS.gpuTemp);
    setStat(`gpu${i}`, {
      sub: (g.name || '').replace(/^NVIDIA\s+/i, '').replace(/GeForce\s+/i, '').replace(/^AMD\s+/i, '').replace(/\s*\(TM\)/gi, ''),
      big: g.usage == null ? null : Math.round(g.usage), unit: g.usage == null ? '' : '%',
      temp: fmtT(g.temp), tempLevel: tLv, alert: tLv,
      pct: g.usage, level: level(g.usage, LIMITS.usage),
      note: hasData ? '' : 'Detectada. Activa los sensores avanzados para ver su uso y temperatura.',
    });
    if (tLv === 'hot') alerts.push({ key: `gpu-temp-${i}`, msg: `${label} a ${Math.round(g.temp)} °C: está muy caliente.` });
    if (g.vramTotal) {
      const pct = (g.vramUsed / g.vramTotal) * 100;
      const lv = level(pct, LIMITS.vram);
      setStat(`vram${i}`, {
        big: gb(g.vramUsed), unit: `/ ${gb(g.vramTotal)} GB`,
        pct, level: lv,
      });
      if (lv === 'hot') alerts.push({ key: `vram-${i}`, msg: `Memoria de video casi llena${multi ? ` (${label})` : ''}: ${Math.round(pct)}%.` });
    }
  });

  const ramPct = (ram.used / ram.total) * 100;
  const ramLv = level(ramPct, LIMITS.ram);
  setStat('ram', {
    sub: `${gb(ram.total / 1048576)} GB en total`,
    big: gb(ram.used / 1048576), unit: 'GB',
    pct: ramPct, level: ramLv,
  });
  if (ramLv === 'hot') alerts.push({ key: 'ram', msg: `RAM casi llena: ${Math.round(ramPct)}% en uso.` });

  const hotLv = s.general ? level(s.general.value, LIMITS.hottest) : '';
  setStat('general', s.general ? {
    sub: s.general.name,
    big: Math.round(s.general.value), unit: '°C',
    level: hotLv,
    note: 'El sensor más caliente de todo el equipo (no es un promedio)',
  } : { note: 'Activa los sensores avanzados para ver las temperaturas' });
  if (hotLv === 'hot') alerts.push({ key: 'hottest', msg: `Un sensor llegó a ${Math.round(s.general.value)} °C (${s.general.name}).` });

  const fans = sysCards.fans;
  const rows = s.fans.map((f) => `${f.name}: ${f.rpm} RPM`);
  gpus.forEach((g, i) => { if (g.fan != null) rows.push(`${multi ? `GPU ${i + 1}` : 'GPU'}: ${Math.round(g.fan)}%`); });
  fans.list.replaceChildren(...rows.map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
  fans.list.hidden = !rows.length;
  fans.note.hidden = rows.length > 0;
  fans.note.textContent = s.sensors.lhm
    ? 'Este equipo no expone la velocidad de sus ventiladores.'
    : 'Activa los sensores avanzados para ver los ventiladores';

  updateAlerts(alerts);
  renderBanner(s);
  renderGame(s);
}

async function refreshSystem() {
  if (sysBusy) return;
  sysBusy = true;
  try {
    renderSystem(await window.api.getSystem());
    sysErrorEl.hidden = true;
  } catch {
    sysErrorEl.hidden = false;
    sysErrorEl.textContent = 'No se pudo leer el estado del sistema.';
  } finally { sysBusy = false; }
}

sysEnableBtn.addEventListener('click', async () => {
  sysEnabling = true;
  sysEnableBtn.disabled = true;
  sysBannerText.textContent = 'Esperando el permiso de administrador de Windows…';
  const res = await window.api.enableSensors().catch(() => ({ ok: false, error: 'No se pudo activar.' }));
  sysEnabling = false;
  if (!res.ok) {
    sysBannerText.textContent = res.error || 'No se pudo activar.';
    sysEnableBtn.disabled = false;
  } else sysBannerText.textContent = 'Iniciando sensores… la primera vez puede tardar unos segundos.';
  setTimeout(refreshSystem, 1500);
});

setInterval(() => { if (!document.hidden && activeTab === 'system') refreshSystem(); }, 1000);

refresh();
setInterval(() => { if (!document.hidden) refreshActive(); }, 2000);
