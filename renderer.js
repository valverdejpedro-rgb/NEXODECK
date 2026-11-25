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
    send: null,
  };
}
// Envía el valor al instante y, mientras se arrastra, como mucho cada ~30 ms (siempre llega el último valor).
function makeSender(fn, ms = 30) {
  let last = 0, timer = null, val = 0;
  return (v) => {
    val = v;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { clearTimeout(timer); timer = null; last = Date.now(); fn(val); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(val); }, wait);
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

let lastState = null;
function render(state) {
  lastState = state;
  for (const kind of KINDS) {
    const p = panels[kind];
    p.devices = state[kind] || [];
    // Mientras Windows confirma el cambio, se sigue mostrando el dispositivo que acabas de elegir
    // (hasta que Windows confirme o pasen unos segundos).
    if (p.want) {
      const cur = p.devices.find((d) => d.isDefault);
      if (Date.now() > p.want.until || (cur && cur.id === p.want.id)) p.want = null;
      else if (p.devices.some((d) => d.id === p.want.id)) p.devices = p.devices.map((d) => ({ ...d, isDefault: d.id === p.want.id }));
    }
    p.current = p.devices.find((d) => d.isDefault) || p.devices[0] || null;

    // La firma NO incluye cuál es el predeterminado: cambiarlo no debe reconstruir la lista (cerraría el menú abierto).
    const sig = p.devices.map((d) => d.id + '|' + d.name).join('\n');
    const rebuilt = sig !== p.signature;
    if (rebuilt) {
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

    // Con el menú abierto o enfocado no se toca la selección (si no, "salta" mientras eliges); al soltar el foco se repinta.
    if (rebuilt || document.activeElement !== p.select) p.select.value = p.current.id;
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

/* Audífonos Corsair: preset de ecualizador activo (solo aparece si la app trae el SDK de iCUE).
   El SDK numera los presets desde 0, en el mismo orden que muestra iCUE. */
const HS_PRESETS = ['Pure Direct', 'Movie Theater', 'FPS Competition', 'Clear Chat', 'Bass Boost'];
const hsEl = document.createElement('section');
hsEl.className = 'panel hs';
hsEl.hidden = true;
hsEl.innerHTML = '<div class="head"><label>Audífonos Corsair</label><b class="hs-preset">–</b></div><p class="hs-note"></p>';
document.getElementById('home-devs').appendChild(hsEl);
const hsPreset = hsEl.querySelector('.hs-preset');
const hsNote = hsEl.querySelector('.hs-note');

async function refreshHeadset() {
  let s;
  try { s = await window.api.getHeadset(); } catch { return; }
  if (!s || !s.available) { hsEl.hidden = true; return; }
  hsEl.hidden = false;
  let big = '–', note = '';
  if (!s.running) note = 'Conectando con iCUE…';
  else if (!s.connected) note = 'No se conecta con iCUE. Ábrelo y activa el control de terceros (SDK) en sus ajustes.';
  else if (!s.headset) note = 'No se detecta ningún audífono Corsair.';
  else {
    if (s.preset != null) big = HS_PRESETS[s.preset] || `Preset ${s.preset + 1}`;
    note = `${s.model || 'Audífonos'}${s.battery != null ? ` · Batería ${s.battery}%` : ''}`;
  }
  hsPreset.textContent = big;
  hsNote.textContent = note;
}

// El preset del audífono se lee aparte y más seguido (cada 0,5 s) para que el cambio se vea casi al instante.
setInterval(() => { if (!document.hidden && activeTab === 'home') refreshHeadset(); }, 500);

let refreshing = false;
async function refresh() {
  if (busy || refreshing) return;
  refreshing = true;
  try {
    const st = await window.api.getState();
    if (!busy) render(st);   // si mientras tanto se tocó un control, esta lectura ya es vieja
    showError('');
    refreshHeadset();
  } catch (e) {
    showError('No se pudo leer el audio. Revisa que bin/svcl.exe esté incluido en la app.');
  } finally { refreshing = false; }
}

async function act(fn) {
  busy++;
  try { await fn(); } catch {} finally { busy--; }
  refresh();
}

for (const kind of KINDS) {
  const p = panels[kind];

  p.send = makeSender((v) => { if (p.current) window.api.setVolume(p.current.id, v).catch(() => {}); });
  p.slider.addEventListener('pointerdown', () => { p.dragging = true; });
  p.slider.addEventListener('input', () => {
    const v = Number(p.slider.value);
    paintSlider(p, v);
    if (p.current) p.send(v);
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
    p.send(v);
    clearTimeout(p.sendTimer);
    p.sendTimer = setTimeout(() => act(() => window.api.setVolume(p.current.id, v)), 300);
  }, { passive: false });

  p.mute.addEventListener('click', () => {
    if (!p.current) return;
    const next = !p.current.muted;
    p.current.muted = next;                  // se ve al instante, sin esperar a Windows
    p.el.classList.toggle('muted', next);
    p.mute.setAttribute('aria-pressed', String(next));
    act(() => window.api.toggleMute(p.current.id, next));
  });

  p.select.addEventListener('change', () => {
    const id = p.select.value;
    p.want = { id, until: Date.now() + 6000 };
    const d = p.devices.find((x) => x.id === id);
    if (d) {                                   // se refleja al instante, sin esperar a Windows
      p.current = d;
      p.el.classList.toggle('muted', d.muted);
      p.mute.setAttribute('aria-pressed', String(d.muted));
      if (!p.dragging) { p.slider.value = d.volume; paintSlider(p, d.volume); }
    }
    p.select.blur();                           // así la lista vuelve a seguir lo que informa Windows
    act(() => window.api.setDefault(id));
  });
  p.select.addEventListener('blur', () => { if (lastState) render(lastState); });
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
// El programa avisa cuando el dispositivo predeterminado cambió por fuera (Windows, otra app, enchufar/desenchufar)
// o cuando terminó de aplicarlo a las apps: se actualiza al instante, sin esperar al siguiente ciclo.
window.api.onAudioChanged(() => { if (!document.hidden) refreshActive(); });
window.api.info().then((i) => {
  versionEl.textContent = `Versión ${i.version}`;
  renderUpdate(i.update);
});


/* ---------- Pestañas ---------- */

const tabBtns = [...document.querySelectorAll('.tab')];
const tabPanels = {
  home: document.getElementById('tab-home'),
  apps: document.getElementById('tab-apps'),
  power: document.getElementById('tab-power'),
  system: document.getElementById('tab-system'),
};
let activeTab = 'home';

function refreshActive() {
  if (activeTab === 'apps') return refreshApps();
  if (activeTab === 'power') return refreshPower();
  if (activeTab === 'system') return refreshSystem();
  refreshHomeApps();
  refreshHomeSystem();
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
/* Cada fila de aplicación sirve para dos listas: la pestaña «Aplicaciones» (todas) y la de «Inicio» (solo las que se usan ahora). */

const appsListEl = document.getElementById('apps-list');
const appsEmptyEl = document.getElementById('apps-empty');
const appsErrorEl = document.getElementById('apps-error');
const appsCountEl = document.getElementById('apps-count');
let appsBusy = 0;

const makeAppList = (container) => ({ container, rows: new Map(), order: '' });
const appsList = makeAppList(appsListEl);
const homeList = makeAppList(document.getElementById('home-apps'));

const SPK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="waves" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/><path class="slash" d="M3.5 3.5l17 17"/></svg>';
const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path class="waves" d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/><path class="slash" d="M3.5 3.5l17 17"/></svg>';
const ctlHtml = (cls, svg) => `
  <div class="control ${cls}">
    <button class="mute" type="button" aria-pressed="false">${svg}</button>
    <input class="slider" type="range" min="0" max="100" step="1" value="0">
    <output class="pct">0</output>
  </div>`;

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
  ${ctlHtml('app-out-control', SPK_SVG)}
  <div class="head app-route app-in">
    <span class="lbl">Entrada</span>
    <select class="device dev-in"></select>
  </div>
  <p class="app-hint hint-in" hidden>Cambio pendiente: la app lo aplicará cuando vuelva a abrir el micrófono (cuelga y vuelve a llamar, o ábrela de nuevo).</p>
  ${ctlHtml('app-in-control', MIC_SVG)}`;

function paintCtl(c, value) {
  c.slider.style.setProperty('--v', value + '%');
  c.pct.textContent = Math.round(value);
}

function setCtlMuted(c, muted) {
  c.muted = muted;
  c.el.classList.toggle('cmuted', muted);
  c.mute.setAttribute('aria-pressed', String(muted));
}

async function actApps(fn) {
  appsBusy++;
  let failed = false;
  try { await fn(); } catch { failed = true; } finally { appsBusy--; }
  if (failed) {
    const msg = 'No se pudo aplicar el cambio. Inténtalo de nuevo.';
    for (const el of [appsErrorEl, homeErrorEl]) {
      el.hidden = false;
      el.textContent = msg;
      setTimeout(() => { el.hidden = true; }, 4000);
    }
  }
  setTimeout(refreshAppsView, 250);
}

// Texto de estado de la fila: la salida y el micrófono se describen por separado.
function appStateText(st) {
  const parts = [];
  if (st.hasOut) parts.push(st.muted ? 'Silenciada' : st.active ? 'Sonando' : 'En silencio');
  if (st.hasIn && st.micActive) parts.push(st.inMuted ? 'Micrófono silenciado' : 'Usando el micrófono');
  return parts.join(' · ') || 'En silencio';
}

// Un control de volumen + silencio (el de la salida o el del micrófono de la app).
function makeCtl(el, volFn, muteFn, row, onMute) {
  const c = {
    el, mute: el.querySelector('.mute'), slider: el.querySelector('.slider'), pct: el.querySelector('.pct'),
    muted: false, dragging: false, timer: null, send: null,
  };
  c.send = makeSender((v) => volFn(row.target, v).catch(() => {}));
  c.slider.addEventListener('pointerdown', () => { c.dragging = true; });
  c.slider.addEventListener('input', () => {
    const v = Number(c.slider.value);
    paintCtl(c, v);
    c.send(v);
  });
  c.slider.addEventListener('change', () => {
    c.dragging = false;
    actApps(() => volFn(row.target, Number(c.slider.value)));
  });
  // La rueda solo actúa sobre el control de volumen, para poder desplazar la lista con normalidad.
  c.el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = Math.max(0, Math.min(100, Number(c.slider.value) + (e.deltaY < 0 ? 5 : -5)));
    c.slider.value = v;
    paintCtl(c, v);
    c.send(v);
    clearTimeout(c.timer);
    c.timer = setTimeout(() => actApps(() => volFn(row.target, v)), 300);
  }, { passive: false });
  c.mute.addEventListener('click', () => {
    const next = !c.muted;
    setCtlMuted(c, next);                   // se ve al instante, sin esperar a Windows
    onMute(next);
    actApps(() => muteFn(row.target, next));
  });
  return c;
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
    st: { muted: false, active: false, micActive: false, inMuted: false, hasOut: false, hasIn: false },
    target: '', sigOut: '', sigIn: '',
    out: null, in: null,
    get dragging() { return this.out.dragging || this.in.dragging; },
  };
  const refreshState = () => {
    row.state.textContent = appStateText(row.st);
    row.el.classList.toggle('out-muted', row.st.hasOut && row.st.muted);
  };
  row.out = makeCtl(el.querySelector('.app-out-control'),
    (t, v) => window.api.setAppVolume(t, v), (t, m) => window.api.setAppMute(t, m), row,
    (m) => { row.st.muted = m; refreshState(); });
  row.in = makeCtl(el.querySelector('.app-in-control'),
    (t, v) => window.api.setAppInVolume(t, v), (t, m) => window.api.setAppInMute(t, m), row,
    (m) => { row.st.inMuted = m; refreshState(); });

  // Al elegir se quita el foco del selector: así la lista vuelve a seguir lo que informa Windows.
  row.outSelect.addEventListener('change', () => { const v = row.outSelect.value; row.outSelect.blur(); actApps(() => window.api.setAppDevice(row.target, v, 'output')); });
  row.inSelect.addEventListener('change', () => { const v = row.inSelect.value; row.inSelect.blur(); actApps(() => window.api.setAppDevice(row.target, v, 'input')); });
  // Al soltar el foco sin elegir nada, la lista se vuelve a sincronizar con Windows enseguida.
  row.outSelect.addEventListener('blur', () => setTimeout(refreshAppsView, 100));
  row.inSelect.addEventListener('blur', () => setTimeout(refreshAppsView, 100));
  return row;
}

function fillDeviceSelect(select, devices, defName) {
  const first = document.createElement('option');
  first.value = '';
  first.textContent = defName ? `Predeterminado del sistema (${defName})` : 'Predeterminado del sistema';
  select.replaceChildren(first, ...devices.map((d) => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    return o;
  }));
}

function updateRoute(route, select, hint, info, show, devices, sigKey, row, defId) {
  route.hidden = !show;
  hint.hidden = !(show && info && info.pending);
  if (!show || !info) return;
  if (!hint.dataset.base) hint.dataset.base = hint.textContent;
  if (info.pending) hint.textContent = info.inUse ? `Ahora usa «${info.inUse}». ${hint.dataset.base}` : hint.dataset.base;
  const defName = ((devices.find((d) => d.id === defId) || {}).name) || '';
  const sig = devices.map((d) => d.id + '|' + d.name).join('\n') + '\n#' + defName;
  const rebuilt = row[sigKey] !== sig;
  if (rebuilt) { row[sigKey] = sig; fillDeviceSelect(select, devices, defName); }
  select.title = info.deviceRaw ? `Detectado: ${info.deviceRaw}` : '';
  if (rebuilt || document.activeElement !== select) {
    select.value = devices.some((d) => d.id === info.deviceId) ? info.deviceId : '';
  }
}

function updateAppRow(row, a, devices, inputs, defOut, defIn) {
  row.target = a.target;
  row.st = { muted: a.muted, active: a.active, micActive: a.micActive, inMuted: a.inMuted, hasOut: a.hasOut, hasIn: a.hasIn };
  row.name.textContent = a.name;
  row.name.title = a.target;
  row.state.textContent = appStateText(row.st);
  row.el.classList.toggle('playing', (a.active && !a.muted) || (a.micActive && !a.inMuted));
  row.el.classList.toggle('out-muted', a.hasOut && a.muted);
  row.out.mute.setAttribute('aria-label', `Silenciar ${a.name}`);
  row.out.slider.setAttribute('aria-label', `Volumen de ${a.name}`);
  row.in.mute.setAttribute('aria-label', `Silenciar el micrófono de ${a.name}`);
  row.in.slider.setAttribute('aria-label', `Volumen del micrófono de ${a.name}`);
  row.outSelect.setAttribute('aria-label', `Dispositivo de salida de ${a.name}`);
  row.inSelect.setAttribute('aria-label', `Dispositivo de entrada de ${a.name}`);

  if (a.icon) {
    if (row.icon.src !== a.icon) row.icon.src = a.icon;
    row.icon.hidden = false;
  } else row.icon.hidden = true;

  updateRoute(row.outRoute, row.outSelect, row.outHint, a.out, a.canRoute && a.hasOut, devices, 'sigOut', row, defOut);
  updateRoute(row.inRoute, row.inSelect, row.inHint, a.in, a.canRoute && a.hasIn, inputs, 'sigIn', row, defIn);

  // Volumen y silencio de la salida (una app que solo usa el micrófono no tiene) y del micrófono (solo si lo usa).
  row.out.el.hidden = !a.hasOut;
  row.in.el.hidden = !(a.hasIn && a.canRoute);
  setCtlMuted(row.out, a.muted);
  setCtlMuted(row.in, a.inMuted);
  if (!row.out.dragging) { row.out.slider.value = a.volume; paintCtl(row.out, a.volume); }
  if (!row.in.dragging) { row.in.slider.value = a.inVolume; paintCtl(row.in, a.inVolume); }
}

function renderAppList(list, apps, devices, inputs, defOut, defIn) {
  const seen = new Set();
  for (const a of apps) {
    seen.add(a.key);
    let row = list.rows.get(a.key);
    if (!row) {
      row = makeAppRow();
      list.rows.set(a.key, row);
      list.container.appendChild(row.el);
      list.order = '';
    }
    updateAppRow(row, a, devices, inputs || [], defOut || '', defIn || '');
  }
  for (const [key, row] of list.rows) {
    if (!seen.has(key)) { row.el.remove(); list.rows.delete(key); list.order = ''; }
  }
  // Orden alfabético; solo se recoloca si cambió, para no romper un arrastre en curso.
  const order = apps.map((a) => a.key).join('|');
  if (order !== list.order && ![...list.rows.values()].some((r) => r.dragging)) {
    for (const a of apps) list.container.appendChild(list.rows.get(a.key).el);
    list.order = order;
  }
}

function renderApps({ apps, devices, inputs, defaultOut, defaultIn }) {
  renderAppList(appsList, apps, devices, inputs, defaultOut, defaultIn);
  appsEmptyEl.hidden = apps.length > 0;
  appsCountEl.textContent = apps.length === 1 ? '1 aplicación' : `${apps.length} aplicaciones`;
}

let appsRefreshing = false;
async function refreshApps() {
  if (appsBusy || appsRefreshing) return;
  appsRefreshing = true;
  try {
    const st = await window.api.getApps();
    if (!appsBusy) renderApps(st);
    appsErrorEl.hidden = true;
  } catch {
    appsErrorEl.hidden = false;
    appsErrorEl.textContent = 'No se pudo leer el audio de las aplicaciones. Revisa que svcl.exe esté incluido en la app.';
  } finally { appsRefreshing = false; }
}

/* ---------- Inicio: aplicaciones en uso ahora ---------- */

const homeEmptyEl = document.getElementById('home-empty');
const homeErrorEl = document.getElementById('home-error');
const homeCountEl = document.getElementById('home-count');
const homeHold = new Map();      // app -> última vez que estuvo en uso (para que no parpadee al pausar un instante)
const HOME_HOLD_MS = 6000;
let homeRefreshing = false;

async function refreshHomeApps() {
  if (appsBusy || homeRefreshing) return;
  homeRefreshing = true;
  try {
    const st = await window.api.getApps();
    if (!appsBusy) {
      const now = Date.now();
      for (const a of st.apps) if (a.inUse) homeHold.set(a.key, now);
      for (const [k, t] of homeHold) if (now - t > HOME_HOLD_MS) homeHold.delete(k);
      const list = st.apps.filter((a) => homeHold.has(a.key));
      renderAppList(homeList, list, st.devices, st.inputs, st.defaultOut, st.defaultIn);
      homeEmptyEl.hidden = list.length > 0;
      homeCountEl.textContent = list.length === 1 ? '1 aplicación' : `${list.length} aplicaciones`;
    }
    homeErrorEl.hidden = true;
  } catch {
    homeErrorEl.hidden = false;
    homeErrorEl.textContent = 'No se pudo leer el audio de las aplicaciones. Revisa que svcl.exe esté incluido en la app.';
  } finally { homeRefreshing = false; }
}

function refreshAppsView() {
  return activeTab === 'home' ? refreshHomeApps() : refreshApps();
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
const homeAlertEl = document.getElementById('home-alert');
const homeAlertList = document.getElementById('home-alert-list');
const sysCards = {};
let sysBusy = false;
let sysEnabling = false;
let sysOrder = '';

/* Umbrales de color: [aviso (ámbar), crítico (rojo)]. Cámbialos aquí si quieres más o menos sensibilidad. */
const LIMITS = {
  usage: [70, 90],     // uso de CPU / GPU (%)
  cpuTemp: [85, 95],   // °C (los CPU de laptop suelen limitarse cerca de 100 °C)
  gpuTemp: [80, 87],   // °C, núcleo de la GPU (las GPU de laptop de esta generación reportan 87 °C como máximo operativo)
  hottest: [90, 100],  // °C, sensor más caliente (incluye el "Hot Spot" de la GPU, que va más alto que el núcleo)
  ram: [75, 90],       // % de RAM usada
  vram: [75, 92],      // % de VRAM usada
};

function buildStat(title) {
  const el = document.createElement('section');
  el.className = 'panel stat';
  el.innerHTML = `
    <div class="stat-head"><span class="stat-title"></span><span class="stat-sub"></span></div>
    <div class="stat-row"><span class="big">–</span><span class="unit"></span><span class="temp"></span></div>
    <div class="bar"><i></i></div>
    <p class="stat-note"></p>`;
  el.querySelector('.stat-title').textContent = title;
  return {
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
}
function mkStat(id, title) {
  sysCards[id] = buildStat(title);
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
// Si el chip informa su límite real de temperatura, los umbrales se calculan a partir de él
// (ámbar a 10 °C del límite, rojo a 3 °C); si no lo informa, se usan los valores fijos de LIMITS.
const limitsFor = (maxT, fixed) => (maxT && maxT > 60 ? [maxT - 10, maxT - 3] : fixed);
const fmtT = (t) => (t == null ? '' : `${Math.round(t)} °C`);
const gb = (mb) => (mb / 1024).toFixed(1);

function setStat(id, o) { setStatOn(sysCards[id], o); }
function setStatOn(c, o) {
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

/* Juego: FPS actual, más bajo / más alto y gráfica que usa */
const GAME_TEMPLATE = `
  <div class="game-idle"></div>
  <div class="game-body" hidden>
    <div class="game-top">
      <div class="game-id">
        <div class="game-head"><span class="game-title"></span><span class="game-tag">Jugando</span></div>
        <div class="game-fps"><span class="big fps">–</span><span class="unit">FPS</span></div>
      </div>
      <div class="game-range">
        <div class="range lo"><span class="range-lbl">Más bajo</span><b class="range-val rmin">–</b></div>
        <div class="range hi"><span class="range-lbl">Más alto</span><b class="range-val rmax">–</b></div>
        <button class="mini reset-range" type="button">Reiniciar</button>
      </div>
    </div>
    <div class="game-gpu">
      <div class="gpu-line"><span class="gpu-lbl">Gráfica que usa el juego</span><b class="gpu-name">Detectando…</b></div>
      <p class="gpu-msg"></p>
      <div class="gpu-pref" role="group" aria-label="Gráfica preferida por Windows para este juego">
        <button type="button" data-pref="0">Windows decide</button>
        <button type="button" data-pref="1">Ahorro de energía</button>
        <button type="button" data-pref="2">Alto rendimiento</button>
      </div>
      <p class="gpu-hint"></p>
    </div>
  </div>`;
sysGameEl.innerHTML = GAME_TEMPLATE;
const gm = {
  idle: sysGameEl.querySelector('.game-idle'),
  body: sysGameEl.querySelector('.game-body'),
  title: sysGameEl.querySelector('.game-title'),
  fps: sysGameEl.querySelector('.fps'),
  min: sysGameEl.querySelector('.rmin'),
  max: sysGameEl.querySelector('.rmax'),
  reset: sysGameEl.querySelector('.reset-range'),
  gpuName: sysGameEl.querySelector('.gpu-name'),
  gpuMsg: sysGameEl.querySelector('.gpu-msg'),
  prefBox: sysGameEl.querySelector('.gpu-pref'),
  prefBtns: [...sysGameEl.querySelectorAll('.gpu-pref button')],
  hint: sysGameEl.querySelector('.gpu-hint'),
};
let prefSent = null; // preferencia recién enviada (se muestra al instante mientras se confirma)

gm.reset.addEventListener('click', () => { window.api.resetGameStats(); gm.min.textContent = '–'; gm.max.textContent = '–'; });
gm.prefBtns.forEach((b) => b.addEventListener('click', async () => {
  const pref = Number(b.dataset.pref);
  prefSent = pref;
  gm.prefBtns.forEach((x) => x.classList.toggle('on', x === b));
  const res = await window.api.setGameGpu(pref).catch(() => ({ ok: false }));
  if (!res.ok) { prefSent = null; gm.hint.textContent = 'No se pudo guardar el cambio.'; }
  else gm.hint.textContent = 'Guardado. Cierra el juego y vuelve a abrirlo para que Windows use esta gráfica.';
}));

function renderGame(s) {
  if (!s.sensors.helper) { sysGameEl.hidden = true; return; }
  sysGameEl.hidden = false;
  const g = s.game;
  gm.idle.hidden = !!g;
  gm.body.hidden = !g;
  if (!g) {
    gm.idle.textContent = 'Sin juego detectado. Abre un juego y aquí verás sus FPS.';
    prefSent = null;
    return;
  }
  gm.title.textContent = g.name;
  gm.fps.textContent = Math.round(g.fps);
  gm.min.textContent = g.min == null ? '–' : Math.round(g.min);
  gm.max.textContent = g.max == null ? '–' : Math.round(g.max);

  // Gráfica en uso y si conviene cambiarla
  const gp = g.gpu;
  gm.gpuName.textContent = gp ? gp.name : 'Detectando… (necesita unos segundos de juego)';
  gm.gpuName.dataset.state = '';
  gm.gpuMsg.textContent = '';
  if (gp) {
    if (gp.vendor === 'nvidia') {
      gm.gpuName.dataset.state = 'ok';
      gm.gpuMsg.textContent = 'Está usando la tarjeta dedicada NVIDIA. Es lo esperado para jugar.';
    } else if (g.hasNvidia) {
      gm.gpuName.dataset.state = 'warn';
      gm.gpuMsg.textContent = 'Está usando otra tarjeta y tu equipo tiene una NVIDIA, que normalmente rinde mucho más. Prueba "Alto rendimiento".';
    }
  }
  const pref = prefSent != null ? prefSent : g.pref;
  gm.prefBtns.forEach((b) => b.classList.toggle('on', pref != null && Number(b.dataset.pref) === pref));
  gm.prefBox.hidden = !g.canSet;
  if (!g.canSet) gm.hint.textContent = 'No se pudo leer la ruta de este juego, así que no se puede cambiar su gráfica desde aquí.';
  else if (!gm.hint.textContent || /No se pudo leer la ruta/.test(gm.hint.textContent)) gm.hint.textContent = 'El cambio se aplica al volver a abrir el juego. Algunos juegos eligen su gráfica en sus propios ajustes.';
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
  for (const [box, list] of [[sysAlertEl, sysAlertList], [homeAlertEl, homeAlertList]]) {
    box.hidden = !active.length;
    list.replaceChildren(...active.map((a) => { const li = document.createElement('li'); li.textContent = a.msg; return li; }));
  }
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

  const cpuTempLv = level(cpu.temp, limitsFor(cpu.tempLimit, LIMITS.cpuTemp));
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
    const tLv = level(g.temp, limitsFor(g.tempLimit, LIMITS.gpuTemp));
    setStat(`gpu${i}`, {
      sub: (g.name || '').replace(/^NVIDIA\s+/i, '').replace(/GeForce\s+/i, '').replace(/^AMD\s+/i, '').replace(/\s*\(TM\)/gi, ''),
      big: g.usage == null ? null : Math.round(g.usage), unit: g.usage == null ? '' : '%',
      temp: fmtT(g.temp), tempLevel: tLv, alert: tLv,
      pct: g.usage, level: level(g.usage, LIMITS.usage),
      note: g.tempShared ? 'Gráfica integrada: comparte chip con la CPU, por eso muestra la temperatura del chip.' : (hasData ? '' : 'Detectada. Activa los sensores avanzados para ver su uso y temperatura.'),
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


/* ---------- Inicio: batería y sistema ---------- */

const homeSysEl = document.getElementById('home-sys');
const homeCards = {};
let homeSysOrder = '';
let batMgr = null;          // administrador de batería de Chromium (navigator.getBattery)
let batFailed = false;

async function readBattery() {
  if (batFailed || typeof navigator.getBattery !== 'function') return null;
  try {
    if (!batMgr) batMgr = await navigator.getBattery();
    return batMgr;
  } catch { batFailed = true; return null; }
}
const fmtDur = (sec) => {
  if (!isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

// Pone/actualiza una tarjeta de la rejilla de Inicio (se crean al primer uso).
function homeStat(ids, id, title, o) {
  if (!homeCards[id]) homeCards[id] = buildStat(title);
  homeCards[id].title.textContent = title;
  setStatOn(homeCards[id], o);
  ids.push(id);
}

async function renderHomeSystem(s) {
  const ids = [];
  const alerts = [];

  const b = await readBattery();
  if (b) {
    const pct = Math.round(b.level * 100);
    const lvl = b.charging ? 'ok' : pct <= 15 ? 'hot' : pct <= 30 ? 'warm' : 'ok';
    const left = b.charging ? (b.level < 1 ? fmtDur(b.chargingTime) : '') : fmtDur(b.dischargingTime);
    homeStat(ids, 'bat', 'Batería', {
      sub: b.charging ? (b.level >= 1 ? 'Conectada' : 'Cargando') : 'Usando batería',
      big: pct, unit: '%', pct, level: lvl,
      note: left ? (b.charging ? `Carga completa en ${left}` : `Quedan unos ${left}`) : '',
    });
    if (!b.charging && pct <= 15) alerts.push({ key: 'bat', msg: `Batería baja: ${pct}%.` });
  }

  if (s) {
    const { cpu, gpus, ram } = s;
    const multi = gpus.length > 1;

    const cpuLv = level(cpu.temp, limitsFor(cpu.tempLimit, LIMITS.cpuTemp));
    homeStat(ids, 'cpu', 'CPU', {
      sub: `${cpu.cores} hilos`, big: Math.round(cpu.usage), unit: '%',
      temp: fmtT(cpu.temp), tempLevel: cpuLv, alert: cpuLv,
      pct: cpu.usage, level: level(cpu.usage, LIMITS.usage),
    });
    if (cpuLv === 'hot') alerts.push({ key: 'cpu-temp', msg: `CPU a ${Math.round(cpu.temp)} °C: está muy caliente.` });

    gpus.forEach((g, i) => {
      const label = multi ? `GPU ${i + 1}` : 'GPU';
      const tLv = level(g.temp, limitsFor(g.tempLimit, LIMITS.gpuTemp));
      homeStat(ids, `gpu${i}`, label, {
        sub: (g.name || '').replace(/^NVIDIA\s+/i, '').replace(/GeForce\s+/i, '').replace(/^AMD\s+/i, '').replace(/\s*\(TM\)/gi, ''),
        big: g.usage == null ? null : Math.round(g.usage), unit: g.usage == null ? '' : '%',
        temp: fmtT(g.temp), tempLevel: tLv, alert: tLv,
        pct: g.usage, level: level(g.usage, LIMITS.usage),
        note: g.usage == null && g.temp == null ? 'Activa los sensores avanzados (pestaña Estado del sistema)' : '',
      });
      if (tLv === 'hot') alerts.push({ key: `gpu-temp-${i}`, msg: `${label} a ${Math.round(g.temp)} °C: está muy caliente.` });
      if (g.vramTotal) {
        const vp = (g.vramUsed / g.vramTotal) * 100;
        if (level(vp, LIMITS.vram) === 'hot') alerts.push({ key: `vram-${i}`, msg: `Memoria de video casi llena${multi ? ` (${label})` : ''}: ${Math.round(vp)}%.` });
      }
    });

    const ramPct = (ram.used / ram.total) * 100;
    const ramLv = level(ramPct, LIMITS.ram);
    homeStat(ids, 'ram', 'RAM', {
      sub: `${gb(ram.total / 1048576)} GB en total`, big: gb(ram.used / 1048576), unit: 'GB', pct: ramPct, level: ramLv,
    });
    if (ramLv === 'hot') alerts.push({ key: 'ram', msg: `RAM casi llena: ${Math.round(ramPct)}% en uso.` });

    if (s.general) {
      const hotLv = level(s.general.value, LIMITS.hottest);
      homeStat(ids, 'general', 'Punto más caliente', { sub: s.general.name, big: Math.round(s.general.value), unit: '°C', level: hotLv });
      if (hotLv === 'hot') alerts.push({ key: 'hottest', msg: `Un sensor llegó a ${Math.round(s.general.value)} °C (${s.general.name}).` });
    }
    updateAlerts(alerts);
  } else if (b) updateAlerts(alerts);

  // Se quitan las tarjetas que ya no aplican y se colocan en orden (solo se toca el DOM si cambió algo).
  for (const id of Object.keys(homeCards)) {
    if (!ids.includes(id)) { homeCards[id].el.remove(); delete homeCards[id]; }
  }
  const key = ids.join('|');
  if (key !== homeSysOrder) {
    homeSysOrder = key;
    for (const id of ids) homeSysEl.appendChild(homeCards[id].el);
  }
}

let homeSysBusy = false;
async function refreshHomeSystem() {
  if (homeSysBusy) return;
  homeSysBusy = true;
  try {
    let s = null;
    try { s = await window.api.getSystem(); } catch {}
    await renderHomeSystem(s);
  } finally { homeSysBusy = false; }
}

setInterval(() => { if (!document.hidden && activeTab === 'system') refreshSystem(); }, 500);
// Volumen y silencio se leen directo de Windows (milisegundos), así que se pueden consultar muy seguido.
setInterval(() => { if (!document.hidden && activeTab === 'home') refresh(); }, 400);
setInterval(() => { if (!document.hidden && activeTab === 'home') refreshHomeApps(); }, 700);
setInterval(() => { if (!document.hidden && activeTab === 'home') refreshHomeSystem(); }, 1000);
setInterval(() => { if (!document.hidden && activeTab === 'apps') refreshApps(); }, 700);

refresh();
setInterval(() => { if (!document.hidden) refreshActive(); }, 2000);
