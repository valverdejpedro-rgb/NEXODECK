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
const tabPanels = { devices: document.getElementById('tab-devices'), apps: document.getElementById('tab-apps') };
let activeTab = 'devices';

function refreshActive() {
  return activeTab === 'apps' ? refreshApps() : refresh();
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
  <div class="head app-route">
    <span class="lbl">Salida</span>
    <select class="device"></select>
  </div>
  <p class="app-hint" hidden>Cambio pendiente: la app lo aplicará cuando reinicie su audio (pausa y reproduce, o ábrela de nuevo).</p>
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
  refreshApps();
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
    route: el.querySelector('.app-route'),
    select: el.querySelector('select'),
    hint: el.querySelector('.app-hint'),
    control: el.querySelector('.control'),
    mute: el.querySelector('.mute'),
    slider: el.querySelector('.slider'),
    pct: el.querySelector('.pct'),
    target: '', muted: false, dragging: false, timer: null, sig: '',
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
  row.mute.addEventListener('click', () => actApps(() => window.api.setAppMute(row.target, !row.muted)));
  row.select.addEventListener('change', () => actApps(() => window.api.setAppDevice(row.target, row.select.value)));
  return row;
}

function updateAppRow(row, a, devices) {
  row.target = a.target;
  row.muted = a.muted;
  row.name.textContent = a.name;
  row.name.title = a.target;
  row.state.textContent = a.active ? 'Sonando' : 'En silencio';
  row.el.classList.toggle('playing', a.active);
  row.el.classList.toggle('muted', a.muted);
  row.mute.setAttribute('aria-pressed', String(a.muted));
  row.mute.setAttribute('aria-label', `Silenciar ${a.name}`);
  row.slider.setAttribute('aria-label', `Volumen de ${a.name}`);
  row.select.setAttribute('aria-label', `Dispositivo de salida de ${a.name}`);

  if (a.icon) {
    if (row.icon.src !== a.icon) row.icon.src = a.icon;
    row.icon.hidden = false;
  } else row.icon.hidden = true;

  row.route.hidden = !a.canRoute;
  row.hint.hidden = !(a.canRoute && a.pending);

  const sig = devices.map((d) => d.id + '|' + d.name).join('\n');
  if (row.sig !== sig) {
    row.sig = sig;
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Predeterminado del sistema';
    row.select.replaceChildren(first, ...devices.map((d) => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.name;
      return o;
    }));
  }
  row.select.title = a.deviceRaw ? `Detectado: ${a.deviceRaw}` : '';
  if (document.activeElement !== row.select) {
    row.select.value = devices.some((d) => d.id === a.deviceId) ? a.deviceId : '';
  }

  if (!row.dragging) {
    row.slider.value = a.volume;
    paintApp(row, a.volume);
  }
}

function renderApps({ apps, devices }) {
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
    updateAppRow(row, a, devices);
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

refresh();
setInterval(() => { if (!document.hidden) refreshActive(); }, 2000);
