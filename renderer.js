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
window.api.onShown(refresh);
window.api.info().then((i) => {
  versionEl.textContent = `Versión ${i.version}`;
  renderUpdate(i.update);
});

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2500);
