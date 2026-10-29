// The whole pipeline: source outlines -> neon path -> printed body -> pieces.
import {
  type BBox, type Paths, type Polyline, type Pt, type Ring, bbox, clipLines, difference, polylineLength,
  simplify, toPolys, totalArea, tube, union,
} from './clip';
import type { Source } from './source';
import { type Piece, type SplitResult, splitBody } from './split';

export type OverlapMode = 'merge' | 'later-on-top' | 'earlier-on-top';

export interface Params {
  /** Overall width of the lettering in mm. */
  width: number;
  overlap: OverlapMode;
  stripWidth: number;
  channelClearance: number;
  wallThickness: number;
  wallHeight: number;
  baseThickness: number;
  minBendRadius: number;
  bridges: boolean;
  bridgeWidth: number;
  maxPiece: number;
  bedSize: number;
  connectors: boolean;
  connectorClearance: number;
}

export const defaultParams: Params = {
  width: 500,
  overlap: 'merge',
  stripWidth: 6,
  channelClearance: 0.4,
  wallThickness: 1.6,
  wallHeight: 10,
  baseThickness: 2.4,
  minBendRadius: 10,
  bridges: true,
  bridgeWidth: 8,
  maxPiece: 240,
  bedSize: 256,
  connectors: true,
  connectorClearance: 0.2,
};

/** Per-item nudge in layout units (same units as the source outlines). */
export interface Nudge { dx: number; dy: number }

export interface DesignItem { label: string; fill: Paths }

export interface Stats {
  letterWidth: number;
  letterHeight: number;
  printedWidth: number;
  printedHeight: number;
  pieces: number;
  neonMetres: number;
  neonRuns: number;
  tightSpots: number;
  filamentGrams: number;
}

export interface Design {
  params: Params;
  /** mm per layout unit. */
  scale: number;
  items: DesignItem[];
  fill: Paths;
  neon: Polyline[];
  channel: Paths;
  walls: Paths;
  bridges: Paths;
  base: Paths;
  tight: Pt[];
  split: SplitResult;
  pieces: Piece[];
  bounds: BBox;
  warnings: string[];
  stats: Stats;
}

const NO_SPLIT: SplitResult = { xCuts: [], yCuts: [], tabs: [], joints: [], pieces: [], warnings: [] };

/**
 * Builds the full design. With `split: false` the (slower) cutting into pieces is skipped, which is what the
 * live preview uses while a letter is being dragged.
 */
export function buildDesign(src: Source, params: Params, nudges: Record<number, Nudge> = {}, opts: { split?: boolean } = {}): Design | null {
  if (!src.items.length) return null;
  const raw = bbox(src.items.flatMap((i) => i.rings));
  const w = raw.maxX - raw.minX;
  if (!(w > 0)) return null;
  const scale = params.width / w;
  const items: DesignItem[] = src.items.map((it, idx) => {
    const n = nudges[idx] ?? { dx: 0, dy: 0 };
    const rings: Ring[] = it.rings.map((r) => r.map(([x, y]) => [(x + n.dx - raw.minX) * scale, (raw.maxY - (y + n.dy)) * scale] as Pt));
    // Flattened curves are denser than needed; 0.05 mm deviation is invisible in print and keeps clipping fast.
    return { label: it.label, fill: simplify(union(rings, [], it.fill), 0.05) };
  });
  const fill = union(items.flatMap((i) => i.fill));
  const neon = neonPaths(items, fill, params.overlap);

  const half = (params.stripWidth + params.channelClearance) / 2;
  const channel = tube(neon, half);
  const band = tube(neon, half + params.wallThickness);
  const walls = simplify(difference(band, channel), 0.03);
  const footprint = union(fill, band);
  const bridges = params.bridges ? bridgeIslands(footprint, params.bridgeWidth, params.wallThickness + 1) : [];
  const base = bridges.length ? union(footprint, bridges) : footprint;
  const tight = tightSpots(neon, params.minBendRadius);

  const split = opts.split === false ? NO_SPLIT : splitBody(base, walls, {
    maxPiece: params.maxPiece,
    connectors: params.connectors,
    connectorClearance: params.connectorClearance,
    tabNeck: 7,
    tabHead: 10,
    tabDepth: 6,
  });

  const warnings: string[] = [];
  const islands = toPolys(base).length;
  if (islands > 1) warnings.push(`${islands} separate parts are not joined to each other${params.bridges ? '' : ' (bridges are off)'} — mount them on a backing board.`);
  if (tight.length) warnings.push(`${tight.length} spot${tight.length > 1 ? 's' : ''} on the neon path bend tighter than ${params.minBendRadius} mm radius (shown as red rings).`);
  if (params.maxPiece > params.bedSize) warnings.push(`Max piece size ${params.maxPiece} mm is larger than the ${params.bedSize} mm bed.`);
  warnings.push(...split.warnings);

  const fb = bbox(fill);
  const bounds = bbox(base);
  let volume = 0;
  for (const p of split.pieces) {
    volume += totalArea([p.base.outer, ...p.base.holes]) * params.baseThickness;
    for (const wp of p.walls) volume += totalArea([wp.outer, ...wp.holes]) * params.wallHeight;
  }
  const stats: Stats = {
    letterWidth: fb.maxX - fb.minX,
    letterHeight: fb.maxY - fb.minY,
    printedWidth: bounds.maxX - bounds.minX,
    printedHeight: bounds.maxY - bounds.minY,
    pieces: split.pieces.length,
    neonMetres: neon.reduce((s, l) => s + polylineLength(l), 0) / 1000,
    neonRuns: neon.length,
    tightSpots: tight.length,
    // PLA at roughly 1.24 g/cm³, solid. Real prints with infill come in a bit lighter.
    filamentGrams: (volume / 1000) * 1.24,
  };
  return { params, scale, items, fill, neon, channel, walls, bridges, base, tight, split, pieces: split.pieces, bounds, warnings, stats };
}

/**
 * Where the LED strip runs. "merge" follows the outline of all letters fused together;
 * the stacking modes keep the full outline of the upper letter, cutting the lower one where it is covered.
 */
export function neonPaths(items: DesignItem[], fill: Paths, mode: OverlapMode): Polyline[] {
  const rings = (p: Paths): Polyline[] => p.map((pts) => ({ pts, closed: true }));
  if (mode === 'merge') return rings(fill);
  const order = mode === 'later-on-top' ? items : [...items].reverse();
  const out: Polyline[] = [];
  for (let i = 0; i < order.length; i++) {
    const above = union(order.slice(i + 1).flatMap((it) => it.fill));
    const own = rings(order[i].fill);
    out.push(...(above.length ? clipLines(own, above, false) : own));
  }
  return out.filter((l) => polylineLength(l) > 1);
}

/** Joins separate islands with straight bars along a minimum spanning tree of closest points. */
export function bridgeIslands(footprint: Paths, width: number, overlap: number): Paths {
  const polys = toPolys(footprint);
  if (polys.length < 2) return [];
  const samples = polys.map((p) => resample(p.outer, true, 2));
  const n = polys.length;
  const edges: { d: number; i: number; j: number; a: Pt; b: Pt }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let best = { d: Infinity, a: samples[i][0], b: samples[j][0] };
      for (const a of samples[i]) for (const b of samples[j]) {
        const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
        if (d < best.d) best = { d, a, b };
      }
      edges.push({ d: best.d, i, j, a: best.a, b: best.b });
    }
  }
  edges.sort((x, y) => x.d - y.d);
  const parent = polys.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const bars: Ring[] = [];
  for (const e of edges) {
    const ri = find(e.i), rj = find(e.j);
    if (ri === rj) continue;
    parent[ri] = rj;
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy * width / 2, ny = ux * width / 2;
    const a: Pt = [e.a[0] - ux * overlap, e.a[1] - uy * overlap];
    const b: Pt = [e.b[0] + ux * overlap, e.b[1] + uy * overlap];
    bars.push([[a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny]]);
  }
  return union(bars);
}

/** Evenly spaced points along a polyline. */
export function resample(pts: Pt[], closed: boolean, step: number): Pt[] {
  const src = closed ? [...pts, pts[0]] : pts;
  const out: Pt[] = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const [x0, y0] = src[i - 1], [x1, y1] = src[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    let t = step - carry;
    while (t <= seg) {
      out.push([x0 + ((x1 - x0) * t) / seg, y0 + ((y1 - y0) * t) / seg]);
      t += step;
    }
    carry = seg - (t - step);
  }
  return out;
}

/** Points where the path's bend radius (measured over ~4 mm) is below `minR`, at most one per 15 mm. */
export function tightSpots(lines: Polyline[], minR: number): Pt[] {
  const out: Pt[] = [];
  const step = 1, k = 2;
  for (const l of lines) {
    const s = resample(l.pts, l.closed, step);
    const n = s.length;
    if (n < 2 * k + 1) continue;
    let cooldown = 0;
    const first = out.length;
    const start = l.closed ? 0 : k, end = l.closed ? n : n - k;
    for (let i = start; i < end; i++) {
      if (cooldown > 0) { cooldown--; continue; }
      const a = s[(i - k + n) % n], b = s[i], c = s[(i + k) % n];
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
      const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (cross < 1e-9) continue;
      const r = (ab * bc * ca) / (2 * cross);
      if (r < minR) { out.push(b); cooldown = Math.round(15 / step); }
    }
    // On a loop the last hit can be the same bend as the first one, seen from the other side.
    if (l.closed && out.length - first > 1) {
      const a = out[first], z = out[out.length - 1];
      if (Math.hypot(a[0] - z[0], a[1] - z[1]) < 15) out.pop();
    }
  }
  return out;
}
