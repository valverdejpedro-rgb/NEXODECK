'use strict';
const $ = (id) => document.getElementById(id);
const ov = $('ov');
const LIM = { usage: [70, 90], cpuT: [85, 95], gpuT: [80, 87], ram: [75, 90], vram: [75, 92] };
const lv = (v, l) => (v == null ? '' : v >= l[1] ? 'hot' : v >= l[0] ? 'warm' : 'ok');
const gb = (mb) => (mb / 1024).toFixed(1);

let cfg = null;      // ajustes guardados (orientación, tamaño, qué mostrar…)
let sys = null;      // última lectura del sistema
let cfgOpen = false;

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Una "celda" del overlay: etiqueta + valor (+ dato extra)
function cell(label, value, unit, valLevel, ext, extLevel, cls) {
  const c = mk('div', `cell${cls ? ' ' + cls : ''}`);
  c.append(mk('span', 'lbl', label));
  const vv = mk('span', 'vv');
  const v = mk('b', `val ${valLevel || ''}`, value);
  if (unit) v.append(mk('small', '', unit));
  vv.append(v);
  if (ext) vv.append(mk('span', `ext ${extLevel || ''}`, ext));
  c.append(vv);
  return c;
}

const deg = (t) => (t == null ? '' : `${Math.round(t)}°`);

function render() {
  if (!cfg) return;
  const it = cfg.items;
  const cells = [];
  const s = sys;

  if (it.fps) {
    const g = s && s.game;
    const range = it.range && g && g.min != null && g.max != null ? `${Math.round(g.min)}–${Math.round(g.max)}` : '';
    cells.push(cell('FPS', g ? Math.round(g.fps) : '–', '', g ? '' : 'dim', range, '', 'fps'));
  }
  if (it.gpu || it.vram) {
    const gpus = (s && s.gpus) || [];
    const multi = gpus.length > 1;
    gpus.forEach((g, i) => {
      const n = multi ? ` ${i + 1}` : '';
      if (it.gpu) cells.push(cell(`GPU${n}`, g.usage == null ? '–' : Math.round(g.usage), g.usage == null ? '' : '%', lv(g.usage, LIM.usage), deg(g.temp), lv(g.temp, g.tempLimit ? [g.tempLimit - 10, g.tempLimit - 3] : LIM.gpuT)));
      if (it.vram && g.vramTotal) {
        const pct = (g.vramUsed / g.vramTotal) * 100;
        cells.push(cell(`VRAM${n}`, `${gb(g.vramUsed)}`, `/ ${gb(g.vramTotal)} GB`, lv(pct, LIM.vram)));
      }
    });
    if (!gpus.length && it.gpu) cells.push(cell('GPU', '–', '', 'dim'));
  }
  if (it.cpu) {
    const c = s && s.cpu;
    cells.push(cell('CPU', c ? Math.round(c.usage) : '–', c ? '%' : '', c ? lv(c.usage, LIM.usage) : 'dim', c ? deg(c.temp) : '', c ? lv(c.temp, c.tempLimit ? [c.tempLimit - 10, c.tempLimit - 3] : LIM.cpuT) : ''));
  }
  if (it.ram) {
    const r = s && s.ram;
    const pct = r ? (r.used / r.total) * 100 : null;
    cells.push(r ? cell('RAM', gb(r.used / 1048576), `/ ${gb(r.total / 1048576)} GB`, lv(pct, LIM.ram)) : cell('RAM', '–', '', 'dim'));
  }
  if (!cells.length) cells.push(mk('p', 'none', 'No hay nada para mostrar. Abre los ajustes (⚙) y elige qué datos ver.'));
  $('rows').replaceChildren(...cells);
}

/* ---------- ajustes ---------- */
function syncCfgUi() {
  if (!cfg) return;
  document.querySelectorAll('#cfg [data-item]').forEach((b) => b.classList.toggle('on', !!cfg.items[b.dataset.item]));
  document.querySelectorAll('#cfg [data-orient]').forEach((b) => b.classList.toggle('on', cfg.orient === b.dataset.orient));
  $('v-scale').textContent = `${Math.round(cfg.scale * 100)}%`;
  $('v-op').textContent = `${Math.round(cfg.opacity * 100)}%`;
  $('b-cfg').classList.toggle('on', cfgOpen);
  $('b-lock').classList.toggle('on', !!cfg.locked);
  $('cfg').hidden = !cfgOpen;
}

function applyCfg(st) {
  cfg = st;
  document.documentElement.style.setProperty('--s', String(cfg.scale));
  document.documentElement.style.setProperty('--op', String(cfg.opacity));
  ov.className = cfg.orient === 'h' ? 'h' : 'v';
  syncCfgUi();
  render();
}

const set = (patch) => window.api.overlaySet(patch).then(applyCfg).catch(() => {});

$('b-cfg').addEventListener('click', () => { cfgOpen = !cfgOpen; syncCfgUi(); });
$('b-lock').addEventListener('click', () => set({ locked: true }));
$('b-x').addEventListener('click', () => window.api.overlayClose());
document.querySelectorAll('#cfg [data-item]').forEach((b) => b.addEventListener('click', () => set({ items: { [b.dataset.item]: !cfg.items[b.dataset.item] } })));
document.querySelectorAll('#cfg [data-orient]').forEach((b) => b.addEventListener('click', () => set({ orient: b.dataset.orient })));
document.querySelectorAll('#cfg [data-scale]').forEach((b) => b.addEventListener('click', () => set({ scale: Math.round((cfg.scale + Number(b.dataset.scale) * 0.1) * 10) / 10 })));
document.querySelectorAll('#cfg [data-op]').forEach((b) => b.addEventListener('click', () => set({ opacity: Math.round((cfg.opacity + Number(b.dataset.op) * 0.1) * 10) / 10 })));

/* ---------- arrastrar (mouse y dedo) ---------- */
let dragging = false;
let lastMove = null;
ov.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || e.target.closest('button')) return;
  dragging = true;
  ov.setPointerCapture(e.pointerId);
  window.api.overlayDrag({ phase: 'start', x: e.screenX, y: e.screenY });
});
ov.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const first = lastMove == null;
  lastMove = { x: e.screenX, y: e.screenY };
  if (first) requestAnimationFrame(() => { if (lastMove) window.api.overlayDrag({ phase: 'move', ...lastMove }); lastMove = null; });
});
const endDrag = () => { if (!dragging) return; dragging = false; lastMove = null; window.api.overlayDrag({ phase: 'end', x: 0, y: 0 }); };
ov.addEventListener('pointerup', endDrag);
ov.addEventListener('pointercancel', endDrag);

/* ---------- tamaño de la ventana = tamaño del contenido ---------- */
let lastSize = '';
new ResizeObserver(() => {
  const r = ov.getBoundingClientRect();
  const w = Math.ceil(r.width), h = Math.ceil(r.height);
  const key = `${w}x${h}`;
  if (key !== lastSize) { lastSize = key; window.api.overlaySize(w, h); }
}).observe(ov);

/* ---------- datos en vivo ---------- */
let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try { sys = await window.api.getSystem(); } catch { /* se mantiene la última lectura */ }
  render();
  busy = false;
}

window.api.onOverlay((st) => applyCfg(st));
window.api.overlayState().then(applyCfg).catch(() => {});
refresh();
setInterval(refresh, 700);
