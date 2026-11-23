import { type Font, parse } from 'opentype.js';
import '../style.css';
import { type BBox, bbox } from '../geom/clip';
import { bedRegion, type Design, defaultParams, type NeonStyle, type Nudge, type OverlapMode, type Params } from '../geom/design';
import type { BuildRequest } from '../geom/worker';
import { remapNudges, type Source, svgSource, textSource } from '../geom/source';
import { buildSheet, buildSheetHtml, defaultStrip, type StripSpec } from '../export/buildsheet';
import { buildZip, templateSvg } from '../export/files';
import { build3mf } from '../export/threemf';
import { pieceMesh, toBinaryStl } from '../export/mesh';
import { fitTestPiece, presetWallHeight, STRIP_PRESETS } from '../geom/fittings';
import { type Layer, type Mode, Viewer } from './viewer';

/**
 * Build plate sizes in mm (x × y). `front` is the depth of a strip along the front edge that cannot be printed on:
 * the P1S, P1P and X1C keep an 18 × 28 mm corner clear, so pieces are kept out of the whole 28 mm strip.
 */
const PRINTERS: { name: string; bed: [number, number]; front?: number }[] = [
  { name: 'Bambu Lab P2S / A1', bed: [256, 256] },
  { name: 'Bambu Lab P1S / P1P / X1C', bed: [256, 256], front: 28 },
  { name: 'Bambu Lab A1 mini', bed: [180, 180] },
  { name: 'Prusa MK4S', bed: [250, 210] },
  { name: 'Prusa CORE One', bed: [250, 220] },
  { name: 'Prusa MINI+', bed: [180, 180] },
  { name: 'Creality Ender-3 V3', bed: [220, 220] },
  { name: 'Creality K1 Max', bed: [300, 300] },
];

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
  /** How multi-line text lines up. */
  align: 'left' | 'center' | 'right';
  kerning: boolean;
  glowColor: string;
  /** Space kept free on each side of the bed; the max piece size is the bed minus twice this. */
  margin: number;
  /** The strip being used, for the power and parts numbers (does not change the geometry). */
  strip: StripSpec;
  params: Params;
  nudges: Record<number, Nudge>;
  /** Words grouped to move together, by word number. Cleared when the text changes. */
  groups: number[][];
}

const STORE_KEY = 'glowline.v1';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function loadState(): State {
  const base: State = {
    source: 'text', text: 'Glow', font: 'Pacifico', letterSpacing: 0, lineHeight: 1.1, align: 'center', kerning: true,
    glowColor: '#ff3d9a', margin: 8, strip: { ...defaultStrip }, params: { ...defaultParams }, nudges: {}, groups: [],
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (saved) return { ...base, ...saved, source: 'text', strip: { ...base.strip, ...saved.strip }, params: { ...base.params, ...saved.params } };
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
  return textSource(font, state.text, { letterSpacing: state.letterSpacing, lineHeight: state.lineHeight, kerning: state.kerning, align: state.align });
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
    viewer.selected = itemsOfWords(selectedWords);
    viewer.groups = activeGroups().map((g) => itemsOfWords(g));
    viewer.setDesign(design, job.liveDelta, job.keepView);
    if (job.split) {
      renderStats(e.data.ms ?? 0);
      renderWarnings();
    }
  }
  if (queued) { const q = queued; queued = null; submit(q); } else $('busy').hidden = true;
};

/** The layout from before a font change, so moves can be carried over to the new font. */
let remapFrom: Source | null = null;
const activeNudges = () => (state.source === 'text' ? state.nudges : svgNudges);
let svgNudges: Record<number, Nudge> = {};

/**
 * Whether the next build should fit the view to the sign. Only new content does that (first load, new text, a new
 * SVG, switching between text and SVG); setting changes keep the user's zoom and pan.
 */
let fitNext = true;

async function recompute(keepView = false) {
  keepView = keepView || !fitNext;
  fitNext = false;
  try {
    source = await currentSource();
    // Same text, new font: keep the moves, matched letter by letter.
    if (remapFrom && source && state.source === 'text') state.nudges = remapNudges(remapFrom, source, state.nudges);
    remapFrom = null;
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

// ---- selection and groups ---------------------------------------------------
// Words (or SVG shapes, which each count as a word) can be selected with a click and grouped, so they move
// together in Word mode. Dragging a selected word also moves everything else that is selected.

let svgGroups: number[][] = [];
let selectedWords = new Set<number>();
const activeGroups = () => (state.source === 'text' ? state.groups : svgGroups);
const setGroups = (g: number[][]) => { if (state.source === 'text') state.groups = g; else svgGroups = g; };
const groupWith = (word: number) => activeGroups().find((g) => g.includes(word)) ?? [word];
const itemsOfWords = (words: Iterable<number>) => {
  const set = new Set(words);
  return (source?.items ?? []).flatMap((it, i) => (set.has(it.word) ? [i] : []));
};

function groupOf(index: number): number[] {
  const items = source?.items;
  if (!items || dragMode === 'letter') return [index];
  if (dragMode === 'line') return items.flatMap((it, i) => (it.line === items[index].line ? [i] : []));
  const word = items[index].word;
  const words = new Set(groupWith(word));
  if (selectedWords.has(word)) for (const w of selectedWords) for (const g of groupWith(w)) words.add(g);
  return itemsOfWords(words);
}

function refreshSelection() {
  viewer.selected = itemsOfWords(selectedWords);
  viewer.groups = activeGroups().map((g) => itemsOfWords(g));
  const grouped = [...selectedWords].some((w) => groupWith(w).length > 1);
  const distinct = new Set([...selectedWords].map((w) => groupWith(w).join(',')));
  $<HTMLButtonElement>('group').disabled = distinct.size < 2;
  $<HTMLButtonElement>('ungroup').disabled = !grouped;
  viewer.draw();
}

function clearSelection(dropGroups: boolean) {
  selectedWords = new Set();
  if (dropGroups) setGroups([]);
  refreshSelection();
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
  renderSheet();
  $('export-note').textContent = `${s.pieces} STL file${s.pieces === 1 ? '' : 's'}, each within ${design.params.maxPiece} mm.`;
}

function renderSheet() {
  $('buildsheet').innerHTML = design ? buildSheetHtml(buildSheet(design, state.strip), state.strip) : '';
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
  'width', 'height', 'bedSize', 'stripWidth', 'channelClearance', 'minBendRadius', 'wallThickness', 'wallHeight',
  'baseThickness', 'bridgeWidth', 'bridgeHeight', 'connectorClearance', 'cableHoleDiameter', 'screwHoleDiameter',
  'engraveDepth',
];

function bindControls() {
  const text = $<HTMLTextAreaElement>('text');
  text.value = state.text;
  text.addEventListener('input', () => { state.text = text.value; state.nudges = {}; clearSelection(true); fitNext = true; schedule(); });

  const sel = $<HTMLSelectElement>('font');
  sel.addEventListener('change', () => { state.font = sel.value; remapFrom = source; schedule(0); });

  $<HTMLInputElement>('font-file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const font = parse(await file.arrayBuffer());
      const name = file.name.replace(/\.[^.]+$/, '');
      fonts.set(name, font);
      state.font = name;
      remapFrom = source;
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

  const align = $<HTMLSelectElement>('align');
  align.value = state.align;
  align.addEventListener('change', () => { state.align = align.value as State['align']; schedule(0); });

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

  const preset = $<HTMLSelectElement>('stripPreset');
  preset.innerHTML = '<option value="">Custom</option>' + STRIP_PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
  const syncPreset = () => {
    const i = STRIP_PRESETS.findIndex((p) => p.width === state.params.stripWidth && presetWallHeight(p.height) === state.params.wallHeight);
    preset.value = i < 0 ? '' : String(i);
  };
  syncPreset();
  preset.addEventListener('change', () => {
    const p = STRIP_PRESETS[Number(preset.value)];
    if (!preset.value || !p) return;
    state.params.stripWidth = p.width;
    state.params.wallHeight = presetWallHeight(p.height);
    $<HTMLInputElement>('stripWidth').value = String(p.width);
    $<HTMLInputElement>('wallHeight').value = String(state.params.wallHeight);
    schedule(0);
  });
  // After the generic number handlers below have stored the new value.
  for (const id of ['stripWidth', 'wallHeight']) $(id).addEventListener('input', () => setTimeout(syncPreset));

  const choice = <K extends 'sizeBy' | 'cutMode' | 'bodyStyle'>(key: K, after?: () => void) => {
    const el = $<HTMLSelectElement>(key);
    el.value = state.params[key];
    el.addEventListener('change', () => { state.params[key] = el.value as Params[K]; after?.(); schedule(0); });
  };
  const showSize = () => {
    $('width-field').hidden = state.params.sizeBy !== 'width';
    $('height-field').hidden = state.params.sizeBy !== 'height';
  };
  choice('sizeBy', showSize);
  showSize();
  choice('cutMode');
  choice('bodyStyle');

  // Printer presets set the bed; the margin turns that into the max piece size.
  const printer = $<HTMLSelectElement>('printer');
  printer.innerHTML = '<option value="">Custom</option>' + PRINTERS.map((p, i) => `<option value="${i}">${p.name} (${p.bed[0]} × ${p.bed[1]})</option>`).join('');
  const bed = $<HTMLInputElement>('bedSize'), margin = $<HTMLInputElement>('margin');
  margin.value = String(state.margin);
  const applyBed = () => {
    const p = state.params;
    p.bedMargin = state.margin;
    const r = bedRegion(p);
    p.maxPiece = Math.max(40, Math.floor(Math.min(r.w, r.h)));
    const i = PRINTERS.findIndex((x) => Math.min(...x.bed) === p.bedSize && (x.front ?? 0) === p.bedFrontExclude);
    printer.value = i < 0 ? '' : String(i);
    $('maxPiece-note').textContent = `Pieces up to ${p.maxPiece} × ${p.maxPiece} mm.`
      + (p.bedFrontExclude ? ` The front ${p.bedFrontExclude} mm of this printer's plate cannot be printed on, so pieces are kept clear of it.` : '')
      + ' Rectangular beds use the shorter side.';
  };
  applyBed();
  printer.addEventListener('change', () => {
    const p = PRINTERS[Number(printer.value)];
    if (!printer.value || !p) return;
    state.params.bedSize = Math.min(...p.bed);
    state.params.bedFrontExclude = p.front ?? 0;
    bed.value = String(state.params.bedSize);
    applyBed();
    schedule(0);
  });
  // Typing a bed size means a printer that is not in the list, so no front strip is assumed.
  bed.addEventListener('input', () => setTimeout(() => { state.params.bedFrontExclude = 0; applyBed(); schedule(250); }));
  margin.addEventListener('input', () => {
    const v = Number(margin.value);
    if (!Number.isFinite(v) || v < 0) return;
    state.margin = v;
    applyBed();
    schedule(250);
  });

  // Strip electrics only change the build sheet, not the geometry, so no rebuild.
  for (const key of ['wattsPerMetre', 'cutInterval'] as const) {
    const input = $<HTMLInputElement>(key);
    input.value = String(state.strip[key]);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!(v > 0)) return;
      state.strip[key] = v;
      renderSheet();
      save();
    });
  }
  const voltage = $<HTMLSelectElement>('voltage');
  voltage.value = String(state.strip.voltage);
  voltage.addEventListener('change', () => { state.strip.voltage = Number(voltage.value) as 12 | 24; renderSheet(); save(); });

  $('download-fit').addEventListener('click', () => {
    const piece = fitTestPiece(state.params);
    downloadBlob(new Blob([toBinaryStl(pieceMesh(piece, state.params), 'fit test')], { type: 'model/stl' }), `fit-test-${state.params.stripWidth}mm.stl`);
  });

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
  for (const key of ['bridges', 'connectors', 'cableHoles', 'mountHoles', 'labels'] as const) {
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
    clearSelection(false);
    fitNext = true;
    schedule(0);
  }));

  $<HTMLInputElement>('svg-file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      svg = { name: file.name, source: svgSource(await file.text()) };
      svgNudges = {};
      clearSelection(true);
      fitNext = true;
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
  viewer.snapTargets = (group) => {
    const items = source?.items, d = design;
    if (!items || !d) return [];
    const inGroup = new Set(group);
    const words = new Map<number, number[]>(), lines = new Map<number, number[]>();
    items.forEach((it, i) => {
      if (inGroup.has(i)) return;
      (words.get(it.word) ?? words.set(it.word, []).get(it.word)!).push(i);
      (lines.get(it.line) ?? lines.set(it.line, []).get(it.line)!).push(i);
    });
    // Each other word, and each other line as a whole, is something to line up with.
    const out: BBox[] = [];
    for (const idx of [...words.values(), ...lines.values()]) {
      const fills = idx.flatMap((i) => d.items[i]?.fill ?? []);
      if (!fills.length) continue;
      const b = bbox(fills);
      if (Number.isFinite(b.minX)) out.push(b);
    }
    return out;
  };
  viewer.onClick = (index, add) => {
    const items = source?.items;
    if (index < 0 || !items) { if (!add) clearSelection(false); return; }
    // Clicking picks the whole group a word belongs to.
    const words = groupWith(items[index].word);
    const on = words.every((w) => selectedWords.has(w));
    if (!add) selectedWords = new Set(on && selectedWords.size === words.length ? [] : words);
    else for (const w of words) on ? selectedWords.delete(w) : selectedWords.add(w);
    refreshSelection();
  };
  $('group').addEventListener('click', () => {
    // Merge the selected words, and any groups they are already in, into one group.
    const merged = new Set<number>();
    for (const w of selectedWords) for (const g of groupWith(w)) merged.add(g);
    setGroups([...activeGroups().filter((g) => !g.some((w) => merged.has(w))), [...merged].sort((a, b) => a - b)]);
    selectedWords = merged;
    refreshSelection();
    save();
  });
  $('ungroup').addEventListener('click', () => {
    setGroups(activeGroups().filter((g) => !g.some((w) => selectedWords.has(w))));
    refreshSelection();
    save();
  });
  // While dragging, rebuild without the (slower) split on every move; once the pointer rests for a moment,
  // rebuild with the cuts too, so pieces and connectors follow the drag without waiting for the drop.
  let restTimer = 0;
  viewer.onDragMove = (items, dx, dy) => {
    if (!design || !source) return;
    const src = source;
    const job = { src, params: state.params, nudges: nudgedBy(items, dx, dy), liveDelta: { dx, dy } };
    // The overlay covers whatever the worker has not caught up with yet.
    submit({ ...job, split: false });
    window.clearTimeout(restTimer);
    restTimer = window.setTimeout(() => submit({ ...job, split: true, keepView: true }), 300);
  };
  viewer.onNudge = (items, dx, dy) => {
    window.clearTimeout(restTimer);
    if (!design) return;
    const n = nudgedBy(items, dx, dy);
    if (state.source === 'text') state.nudges = n; else svgNudges = n;
    window.clearTimeout(pending);
    recompute(true);
  };
  document.querySelectorAll<HTMLButtonElement>('[data-drag]').forEach((b) => b.addEventListener('click', () => {
    dragMode = b.dataset.drag as typeof dragMode;
    $('group-tools').hidden = dragMode !== 'word';
    document.querySelectorAll('[data-drag]').forEach((x) => x.classList.toggle('on', x === b));
  }));

  $('download').addEventListener('click', async () => {
    if (!design) return;
    const btn = $<HTMLButtonElement>('download');
    btn.disabled = true;
    try {
      const blob = await buildZip(design, title(), { text: state.source === 'text' ? state.text : svg?.name, font: state.font, letterSpacing: state.letterSpacing, lineHeight: state.lineHeight, params: state.params, nudges: state.nudges, strip: state.strip }, state.strip);
      downloadBlob(blob, `${slug()}-neon-sign.zip`);
    } finally {
      btn.disabled = false;
    }
  });
  $('download-3mf').addEventListener('click', async () => {
    if (!design) return;
    const btn = $<HTMLButtonElement>('download-3mf');
    btn.disabled = true;
    try {
      downloadBlob(await build3mf(design, title()), `${slug()}-neon-sign.3mf`);
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
