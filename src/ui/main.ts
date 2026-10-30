import { type Font, parse } from 'opentype.js';
import '../style.css';
import { type Design, defaultParams, type NeonStyle, type Nudge, type OverlapMode, type Params } from '../geom/design';
import type { BuildRequest } from '../geom/worker';
import { type Source, svgSource, textSource } from '../geom/source';
import { buildZip, templateSvg } from '../export/files';
import { type Layer, type Mode, Viewer } from './viewer';

const BUNDLED: Record<string, string> = {
  Pacifico: 'Pacifico-Regular.ttf',
  Lobster: 'Lobster-Regular.ttf',
  Righteous: 'Righteous-Regular.ttf',
};

interface State {
  source: 'text' | 'svg';
  text: string;
  font: string;
  letterSpacing: number;
  lineHeight: number;
  kerning: boolean;
  glowColor: string;
  params: Params;
  nudges: Record<number, Nudge>;
}

const STORE_KEY = 'glowline.v1';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function loadState(): State {
  const base: State = {
    source: 'text', text: 'Glow', font: 'Pacifico', letterSpacing: 0, lineHeight: 1.1, kerning: true,
    glowColor: '#ff3d9a', params: { ...defaultParams }, nudges: {},
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (saved) return { ...base, ...saved, source: 'text', params: { ...base.params, ...saved.params } };
  } catch { /* storage unavailable */ }
  return base;
}

const state = loadState();
const fonts = new Map<string, Font>();
let svg: { name: string; source: Source } | null = null;
let design: Design | null = null;
let source: Source | null = null;
let dragMode: 'letter' | 'word' | 'line' = 'word';

const viewer = new Viewer($<HTMLCanvasElement>('canvas'));
viewer.glow = state.glowColor;

function save() {
  try {
    const { source: _s, ...rest } = state;
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...rest, font: BUNDLED[state.font] ? state.font : 'Pacifico' }));
  } catch { /* storage unavailable */ }
}

async function loadBundled(name: string): Promise<Font> {
  const have = fonts.get(name);
  if (have) return have;
  const res = await fetch(`${import.meta.env.BASE_URL}fonts/${BUNDLED[name]}`);
  const font = parse(await res.arrayBuffer());
  fonts.set(name, font);
  return font;
}

// ---- recompute -------------------------------------------------------------

let pending = 0;
function schedule(delay = 120) {
  window.clearTimeout(pending);
  pending = window.setTimeout(recompute, delay);
}

async function currentSource(): Promise<Source | null> {
  if (state.source === 'svg') return svg?.source ?? null;
  if (!state.text.trim()) return null;
  const font = fonts.get(state.font) ?? (BUNDLED[state.font] ? await loadBundled(state.font) : await loadBundled('Pacifico'));
  return textSource(font, state.text, { letterSpacing: state.letterSpacing, lineHeight: state.lineHeight, kerning: state.kerning });
}

// Geometry runs in a worker. Only one build is in flight at a time; while it runs, newer requests replace each
// other so the preview always jumps straight to the latest state (no backlog while dragging).
const worker = new Worker(new URL('../geom/worker.ts', import.meta.url), { type: 'module' });
type Job = Omit<BuildRequest, 'id'> & { liveDelta: { dx: number; dy: number }; keepView?: boolean };
let inflight: (Job & { id: number }) | null = null;
let queued: Job | null = null;
let nextId = 1;

function submit(job: Job) {
  if (inflight) { queued = job; return; }
  inflight = { ...job, id: nextId++ };
  $('busy').hidden = false;
  const { liveDelta: _l, keepView: _k, ...req } = inflight;
  worker.postMessage(req);
}

worker.onmessage = (e: MessageEvent<{ id: number; design?: Design | null; ms?: number; error?: string }>) => {
  const job = inflight;
  inflight = null;
  if (e.data.error) {
    renderWarnings([`Could not build the design: ${e.data.error}`]);
  } else if (job) {
    design = e.data.design ?? null;
    viewer.setDesign(design, job.liveDelta, job.keepView);
    if (job.split) {
      renderStats(e.data.ms ?? 0);
      renderWarnings();
    }
  }
  if (queued) { const q = queued; queued = null; submit(q); } else $('busy').hidden = true;
};

const activeNudges = () => (state.source === 'text' ? state.nudges : svgNudges);
let svgNudges: Record<number, Nudge> = {};

async function recompute(keepView = false) {
  try {
    source = await currentSource();
  } catch (err) {
    renderWarnings([`Could not lay out the text: ${(err as Error).message}`]);
    return;
  }
  if (!source) { design = null; viewer.setDesign(null); renderStats(0); renderWarnings(); return; }
  submit({ src: source, params: state.params, nudges: activeNudges(), split: true, liveDelta: { dx: 0, dy: 0 }, keepView });
  save();
}

/** Nudges with an extra drag offset (mm, y up) applied to some items. */
function nudgedBy(items: number[], dx: number, dy: number): Record<number, Nudge> {
  const out = { ...activeNudges() };
  if (!design) return out;
  for (const i of items) {
    const n = out[i] ?? { dx: 0, dy: 0 };
    // Nudges are stored in layout units (y down) so they survive size changes.
    out[i] = { dx: n.dx + dx / design.scale, dy: n.dy - dy / design.scale };
  }
  return out;
}

function groupOf(index: number): number[] {
  const items = source?.items;
  if (!items || dragMode === 'letter') return [index];
  const key = dragMode === 'word' ? 'word' : 'line';
  return items.flatMap((it, i) => (it[key] === items[index][key] ? [i] : []));
}

function renderStats(ms: number) {
  const el = $('stats');
  if (!design) { el.innerHTML = ''; return; }
  const s = design.stats;
  const cell = (k: string, v: string) => `<div><span>${k}</span><b>${v}</b></div>`;
  el.innerHTML = [
    cell('Letters', `${s.letterWidth.toFixed(0)} × ${s.letterHeight.toFixed(0)} mm`),
    cell('Printed', `${s.printedWidth.toFixed(0)} × ${s.printedHeight.toFixed(0)} mm`),
    cell('Pieces', String(s.pieces)),
    cell('Neon', `${s.neonMetres.toFixed(2)} m · ${s.neonRuns} run${s.neonRuns === 1 ? '' : 's'}`),
    cell('Filament', `≈ ${s.filamentGrams.toFixed(0)} g`),
  ].join('');
  el.title = `Computed in ${ms.toFixed(0)} ms`;
  $('export-note').textContent = `${s.pieces} STL file${s.pieces === 1 ? '' : 's'}, each within ${design.params.maxPiece} mm.`;
}

function renderWarnings(extra: string[] = []) {
  const list = [...extra, ...(design?.warnings ?? [])];
  const el = $('warnings');
  el.innerHTML = list.length
    ? `<h3>Check</h3><ul>${list.map((w) => `<li>${w.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</li>`).join('')}</ul>`
    : design ? '<p class="ok">No problems found.</p>' : '';
}

// ---- controls --------------------------------------------------------------

function fillFontSelect() {
  const sel = $<HTMLSelectElement>('font');
  const names = [...new Set([...Object.keys(BUNDLED), ...fonts.keys()])];
  sel.innerHTML = names.map((n) => `<option value="${n}">${n}${BUNDLED[n] ? '' : ' (uploaded)'}</option>`).join('');
  sel.value = state.font;
}

const numericParams: (keyof Params)[] = [
  'width', 'maxPiece', 'bedSize', 'stripWidth', 'channelClearance', 'minBendRadius', 'wallThickness', 'wallHeight',
  'baseThickness', 'bridgeWidth', 'connectorClearance',
];

function bindControls() {
  const text = $<HTMLTextAreaElement>('text');
  text.value = state.text;
  text.addEventListener('input', () => { state.text = text.value; state.nudges = {}; schedule(); });

  const sel = $<HTMLSelectElement>('font');
  sel.addEventListener('change', () => { state.font = sel.value; state.nudges = {}; schedule(0); });

  $<HTMLInputElement>('font-file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const font = parse(await file.arrayBuffer());
      const name = file.name.replace(/\.[^.]+$/, '');
      fonts.set(name, font);
      state.font = name;
      fillFontSelect();
      schedule(0);
    } catch (err) {
      renderWarnings([`Could not read ${file.name}: ${(err as Error).message}. WOFF2 is not supported; use TTF, OTF or WOFF.`]);
    }
  });

  const range = (id: 'letterSpacing' | 'lineHeight', fmt: (v: number) => string) => {
    const input = $<HTMLInputElement>(id), out = $(`${id}-out`);
    input.value = String(state[id]);
    out.textContent = fmt(state[id]);
    input.addEventListener('input', () => {
      state[id] = Number(input.value);
      out.textContent = fmt(state[id]);
      schedule();
    });
  };
  range('letterSpacing', (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
  range('lineHeight', (v) => `${v.toFixed(2)}×`);

  const kerning = $<HTMLInputElement>('kerning');
  kerning.checked = state.kerning;
  kerning.addEventListener('change', () => { state.kerning = kerning.checked; schedule(0); });

  const overlap = $<HTMLSelectElement>('overlap');
  overlap.value = state.params.overlap;
  overlap.addEventListener('change', () => { state.params.overlap = overlap.value as OverlapMode; schedule(0); });

  const styles = [$<HTMLSelectElement>('neonStyle'), $<HTMLSelectElement>('neonStyle-svg')];
  for (const sel of styles) {
    sel.value = state.params.neonStyle;
    sel.addEventListener('change', () => {
      state.params.neonStyle = sel.value as NeonStyle;
      for (const other of styles) other.value = sel.value;
      schedule(0);
    });
  }

  $('reset-nudges').addEventListener('click', () => { state.nudges = {}; svgNudges = {}; schedule(0); });

  for (const key of numericParams) {
    const input = $<HTMLInputElement>(key);
    input.value = String(state.params[key]);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v <= 0 && key !== 'channelClearance' && key !== 'connectorClearance' && key !== 'minBendRadius') return;
      (state.params[key] as number) = v;
      schedule(250);
    });
  }
  for (const key of ['bridges', 'connectors'] as const) {
    const input = $<HTMLInputElement>(key);
    input.checked = state.params[key];
    input.addEventListener('change', () => { state.params[key] = input.checked; schedule(0); });
  }

  const color = $<HTMLInputElement>('glowColor');
  color.value = state.glowColor;
  color.addEventListener('input', () => { state.glowColor = viewer.glow = color.value; viewer.draw(); save(); });

  document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((b) => b.addEventListener('click', () => {
    state.source = b.dataset.source as State['source'];
    document.querySelectorAll('[data-source]').forEach((x) => x.classList.toggle('on', x === b));
    $('text-controls').hidden = state.source !== 'text';
    $('svg-controls').hidden = state.source !== 'svg';
    schedule(0);
  }));

  $<HTMLInputElement>('svg-file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      svg = { name: file.name, source: svgSource(await file.text()) };
      svgNudges = {};
      $('svg-name').textContent = `${file.name}: ${svg.source.items.length} shape${svg.source.items.length === 1 ? '' : 's'}.`;
      schedule(0);
    } catch (err) {
      $('svg-name').textContent = `Could not use ${file.name}: ${(err as Error).message}`;
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    viewer.mode = b.dataset.mode as Mode;
    document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
    $('layers').classList.toggle('dim', viewer.mode === 'glow');
    viewer.draw();
  }));
  document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((c) => c.addEventListener('change', () => {
    const layer = c.dataset.layer as Layer;
    if (c.checked) viewer.layers.add(layer); else viewer.layers.delete(layer);
    viewer.draw();
  }));
  $('fit').addEventListener('click', () => viewer.fit());

  viewer.groupOf = groupOf;
  viewer.onDragMove = (items, dx, dy) => {
    if (!design || !source) return;
    // Live rebuild without splitting; the overlay covers whatever the worker has not caught up with yet.
    submit({ src: source, params: state.params, nudges: nudgedBy(items, dx, dy), split: false, liveDelta: { dx, dy } });
  };
  viewer.onNudge = (items, dx, dy) => {
    if (!design) return;
    const n = nudgedBy(items, dx, dy);
    if (state.source === 'text') state.nudges = n; else svgNudges = n;
    window.clearTimeout(pending);
    recompute(true);
  };
  document.querySelectorAll<HTMLButtonElement>('[data-drag]').forEach((b) => b.addEventListener('click', () => {
    dragMode = b.dataset.drag as typeof dragMode;
    document.querySelectorAll('[data-drag]').forEach((x) => x.classList.toggle('on', x === b));
  }));

  $('download').addEventListener('click', async () => {
    if (!design) return;
    const btn = $<HTMLButtonElement>('download');
    btn.disabled = true;
    try {
      const blob = await buildZip(design, title(), { text: state.source === 'text' ? state.text : svg?.name, font: state.font, letterSpacing: state.letterSpacing, lineHeight: state.lineHeight, params: state.params, nudges: state.nudges });
      downloadBlob(blob, `${slug()}-neon-sign.zip`);
    } finally {
      btn.disabled = false;
    }
  });
  $('download-svg').addEventListener('click', () => {
    if (design) downloadBlob(new Blob([templateSvg(design)], { type: 'image/svg+xml' }), `${slug()}-template.svg`);
  });
}

const title = () => (state.source === 'text' ? state.text.replace(/\s+/g, ' ').trim() : svg?.name ?? 'SVG') || 'Neon sign';
const slug = () => title().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sign';

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

if (!BUNDLED[state.font]) state.font = 'Pacifico';
fillFontSelect();
bindControls();
recompute();
