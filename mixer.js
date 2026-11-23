const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const countEl = document.getElementById('count');

const rows = new Map();
let busy = 0;
let lastOrder = '';

const TEMPLATE = `
  <div class="app-top">
    <img class="app-icon" alt="" hidden>
    <span class="app-name"></span>
    <span class="app-state"></span>
  </div>
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

function paint(row, value) {
  row.slider.style.setProperty('--v', value + '%');
  row.pct.textContent = Math.round(value);
}

async function act(fn) {
  busy++;
  try { await fn(); } catch {} finally { busy--; }
  refresh();
}

function makeRow() {
  const el = document.createElement('section');
  el.className = 'panel app-row';
  el.innerHTML = TEMPLATE;
  const row = {
    el,
    icon: el.querySelector('.app-icon'),
    name: el.querySelector('.app-name'),
    state: el.querySelector('.app-state'),
    mute: el.querySelector('.mute'),
    slider: el.querySelector('.slider'),
    pct: el.querySelector('.pct'),
    target: '',
    muted: false,
    dragging: false,
    timer: null,
  };

  row.slider.addEventListener('pointerdown', () => { row.dragging = true; });
  row.slider.addEventListener('input', () => {
    const v = Number(row.slider.value);
    paint(row, v);
    clearTimeout(row.timer);
    row.timer = setTimeout(() => window.api.setAppVolume(row.target, v), 60);
  });
  row.slider.addEventListener('change', () => {
    row.dragging = false;
    act(() => window.api.setAppVolume(row.target, Number(row.slider.value)));
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = Math.max(0, Math.min(100, Number(row.slider.value) + (e.deltaY < 0 ? 5 : -5)));
    row.slider.value = v;
    paint(row, v);
    clearTimeout(row.timer);
    row.timer = setTimeout(() => act(() => window.api.setAppVolume(row.target, v)), 80);
  }, { passive: false });
  row.mute.addEventListener('click', () => act(() => window.api.setAppMute(row.target, !row.muted)));
  return row;
}

function update(row, a) {
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
  if (a.icon) {
    if (row.icon.src !== a.icon) row.icon.src = a.icon;
    row.icon.hidden = false;
  } else row.icon.hidden = true;
  if (!row.dragging) {
    row.slider.value = a.volume;
    paint(row, a.volume);
  }
}

function render(apps) {
  const seen = new Set();
  for (const a of apps) {
    seen.add(a.key);
    let row = rows.get(a.key);
    if (!row) {
      row = makeRow();
      rows.set(a.key, row);
      listEl.appendChild(row.el);
      lastOrder = '';
    }
    update(row, a);
  }
  for (const [key, row] of rows) {
    if (!seen.has(key)) { row.el.remove(); rows.delete(key); lastOrder = ''; }
  }
  // Orden alfabético; solo se recoloca si cambió, para no romper un arrastre en curso.
  const order = apps.map((a) => a.key).join('|');
  if (order !== lastOrder && ![...rows.values()].some((r) => r.dragging)) {
    for (const a of apps) listEl.appendChild(rows.get(a.key).el);
    lastOrder = order;
  }
  emptyEl.hidden = apps.length > 0;
  countEl.textContent = apps.length === 1 ? '1 aplicación' : `${apps.length} aplicaciones`;
}

async function refresh() {
  if (busy) return;
  try {
    render(await window.api.getApps());
    errorEl.hidden = true;
  } catch {
    errorEl.hidden = false;
    errorEl.textContent = 'No se pudo leer el audio de las aplicaciones. Revisa que svcl.exe esté incluido en la app.';
  }
}

window.api.onShown(refresh);
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 1500);
