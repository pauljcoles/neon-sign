// The whole pipeline: source outlines -> neon path -> printed body -> pieces.
import {
  type BBox, type Paths, type Polyline, type Pt, type Ring, bbox, clipLines, difference, pointInPaths, polylineLength,
  simplify, simplifyChain, toPolys, totalArea, tube, union,
} from './clip';
import { cableHolePoints, drillPiece, type Mount, mountPoints } from './fittings';
import { centrelines } from './skeleton';
import type { Source } from './source';
import { type Piece, type SplitResult, splitBody } from './split';

export type OverlapMode = 'merge' | 'later-on-top' | 'earlier-on-top';
/** `outline` runs the neon around each letter; `single` runs one line down the middle of each stroke. */
export type NeonStyle = 'outline' | 'single';

export interface Params {
  /** Overall width of the lettering in mm. */
  width: number;
  neonStyle: NeonStyle;
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
  /** A hole through the channel floor at the start of each run, for the feed wire. */
  cableHoles: boolean;
  cableHoleDiameter: number;
  /** Screw holes in each piece (or a small lug where there is no room). */
  mountHoles: boolean;
  screwHoleDiameter: number;
}

export const defaultParams: Params = {
  width: 500,
  neonStyle: 'outline',
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
  cableHoles: true,
  cableHoleDiameter: 5,
  mountHoles: true,
  screwHoleDiameter: 4.5,
};

/** Per-item nudge in layout units (same units as the source outlines). */
export interface Nudge { dx: number; dy: number }

export interface DesignItem {
  label: string;
  /** The item's area: the letter shape, or a stroked SVG line widened to its stroke width. Used for dragging. */
  fill: Paths;
  /** Centre lines that came straight from stroked SVG paths. */
  lines: Polyline[];
}

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
  cableHoles: Pt[];
  mounts: Mount[];
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
  const raw = bbox(src.items.flatMap((i) => [...i.rings, ...(i.lines ?? []).map((l) => l.pts)]));
  const w = raw.maxX - raw.minX;
  if (!(w > 0)) return null;
  const scale = params.width / w;
  const items: DesignItem[] = src.items.map((it, idx) => {
    const n = nudges[idx] ?? { dx: 0, dy: 0 };
    const map = (r: Pt[]) => r.map(([x, y]) => [(x + n.dx - raw.minX) * scale, (raw.maxY - (y + n.dy)) * scale] as Pt);
    const rings: Ring[] = it.rings.map(map);
    const lines: Polyline[] = (it.lines ?? []).map((l) => ({ pts: simplifyChain(map(l.pts), 0.05), closed: l.closed }));
    // Flattened curves are denser than needed; 0.05 mm deviation is invisible in print and keeps clipping fast.
    const shape = rings.length ? simplify(union(rings, [], it.fill), 0.05) : [];
    const stroke = lines.length ? tube(lines, Math.max(0.5, ((it.strokeWidth ?? 1) * scale) / 2)) : [];
    return { label: it.label, fill: stroke.length ? union(shape, stroke) : shape, lines };
  });
  const fill = union(items.flatMap((i) => i.fill));
  const single = params.neonStyle === 'single';
  const neon = single ? singleLinePaths(items, params.overlap) : neonPaths(items, fill, params.overlap);

  const half = (params.stripWidth + params.channelClearance) / 2;
  const channel = tube(neon, half);
  const band = tube(neon, half + params.wallThickness);
  const walls = simplify(difference(band, channel), 0.03);
  // In single-line mode the body is just the channel: the letter shape itself is not printed.
  const footprint = single ? band : union(fill, band);
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

  // Holes and lugs go on after splitting, so they can avoid the cuts and belong to exactly one piece.
  const cableR = Math.min(params.cableHoleDiameter / 2, half - 0.4);
  const cableHoles = params.cableHoles && cableR > 0.5 ? cableHolePoints(neon, cableR, { x: split.xCuts, y: split.yCuts }) : [];
  const holeR = params.screwHoleDiameter / 2, lugR = holeR + 4;
  const mounts: Mount[] = [];
  let pieces = split.pieces;
  if (pieces.length && (cableHoles.length || params.mountHoles)) {
    pieces = pieces.map((pc, i) => {
      const others = params.mountHoles ? union(pieces.flatMap((o, j) => (j === i ? [] : [o.base.outer]))) : [];
      const m = params.mountHoles ? mountPoints(pc, band, others, holeR, lugR, { x: split.xCuts, y: split.yCuts }) : [];
      mounts.push(...m);
      const mine = cableHoles.filter(([x, y]) => x > pc.bbox.minX - cableR && x < pc.bbox.maxX + cableR && y > pc.bbox.minY - cableR && y < pc.bbox.maxY + cableR);
      return drillPiece(pc, m, holeR, lugR, mine, cableR);
    });
  }

  const warnings: string[] = [];
  const islands = toPolys(base).length;
  if (islands > 1) warnings.push(`${islands} separate parts are not joined to each other${params.bridges ? '' : ' (bridges are off)'} — mount them on a backing board.`);
  if (single) {
    const neonPts = neon.flatMap((l) => l.pts);
    const lost = toPolys(fill).filter((p) => !neonPts.some(([x, y]) => pointInPaths([p.outer, ...p.holes], x, y))).length;
    if (lost) warnings.push(`${lost} small shape${lost > 1 ? 's are' : ' is'} too small for a line of neon (like the dot on an i) and ${lost > 1 ? 'are' : 'is'} left out.`);
  }
  if (tight.length) warnings.push(`${tight.length} spot${tight.length > 1 ? 's' : ''} on the neon path bend tighter than ${params.minBendRadius} mm radius (shown as red rings).`);
  if (params.maxPiece > params.bedSize) warnings.push(`Max piece size ${params.maxPiece} mm is larger than the ${params.bedSize} mm bed.`);
  warnings.push(...split.warnings);

  const fb = bbox(fill);
  const bounds = pieces.length ? bbox(pieces.map((p) => p.base.outer)) : bbox(base);
  const lugs = mounts.filter((m) => m.lug).length;
  if (lugs) warnings.push(`${lugs} mounting hole${lugs > 1 ? 's are' : ' is'} on a small lug sticking out from the edge of a piece, where there is no solid back plate to put a hole in. Turn mounting holes off and use a backing board if you would rather not see them.`);
  for (const p of pieces) {
    const w = p.bbox.maxX - p.bbox.minX, h = p.bbox.maxY - p.bbox.minY;
    if (w > params.bedSize || h > params.bedSize) warnings.push(`Piece ${p.id} is ${w.toFixed(0)} × ${h.toFixed(0)} mm with its lugs, larger than the ${params.bedSize} mm bed.`);
  }
  let volume = 0;
  for (const p of pieces) {
    volume += totalArea([p.base.outer, ...p.base.holes]) * params.baseThickness;
    for (const wp of p.walls) volume += totalArea([wp.outer, ...wp.holes]) * params.wallHeight;
  }
  const stats: Stats = {
    letterWidth: fb.maxX - fb.minX,
    letterHeight: fb.maxY - fb.minY,
    printedWidth: bounds.maxX - bounds.minX,
    printedHeight: bounds.maxY - bounds.minY,
    pieces: pieces.length,
    neonMetres: neon.reduce((s, l) => s + polylineLength(l), 0) / 1000,
    neonRuns: neon.length,
    tightSpots: tight.length,
    // PLA at roughly 1.24 g/cm³, solid. Real prints with infill come in a bit lighter.
    filamentGrams: (volume / 1000) * 1.24,
  };
  return { params, scale, items, fill, neon, channel, walls, bridges, base, tight, cableHoles, mounts, split, pieces, bounds, warnings, stats };
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

/**
 * Single-line neon: stroked SVG lines are used as they are; filled shapes are reduced to their centre line.
 * In merge mode overlapping letters are fused first, so joined script letters give one continuous line.
 */
export function singleLinePaths(items: DesignItem[], mode: OverlapMode): Polyline[] {
  const out: Polyline[] = items.flatMap((i) => i.lines);
  const shapes = items.filter((i) => !i.lines.length).map((i) => i.fill);
  if (mode === 'merge') out.push(...centrelines(union(shapes.flat())));
  else for (const s of shapes) out.push(...centrelines(s));
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
