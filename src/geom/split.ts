// Cuts the printed body into bed-sized pieces and adds dovetail connectors along the joints.
import {
  type BBox, type Paths, type Poly, type Ring, area, bbox, difference, intersect, lineIntervals,
  offset, polyPaths, rect, toPolys, totalArea, union,
} from './clip';

export interface SplitParams {
  maxPiece: number;
  connectors: boolean;
  connectorClearance: number;
  tabNeck: number;
  tabHead: number;
  tabDepth: number;
}

export interface Joint { axis: 0 | 1; at: number; from: number; to: number; tabs: number }

export interface Piece {
  id: string;
  col: number;
  row: number;
  base: Poly;
  walls: Poly[];
  bbox: BBox;
}

export interface SplitResult {
  xCuts: number[];
  yCuts: number[];
  tabs: Ring[];
  joints: Joint[];
  pieces: Piece[];
  warnings: string[];
}

const FAR = 1e5;

/**
 * Picks cut positions along one axis so every cell is at most `maxCell` long,
 * preferring lines that cross as little material as possible.
 */
export function chooseCuts(base: Paths, axis: 0 | 1, lo: number, hi: number, maxCell: number): number[] {
  const span = hi - lo;
  if (span <= maxCell) return [];
  const n = Math.ceil(span / maxCell);
  const cuts: number[] = [];
  let prev = lo;
  for (let k = 1; k < n; k++) {
    const ideal = lo + (span * k) / n;
    const from = Math.max(prev + 0.25 * maxCell, hi - (n - k) * maxCell);
    const to = prev + maxCell;
    let best = Math.min(Math.max(ideal, from), to);
    let bestScore = Infinity;
    for (let c = from; c <= to + 1e-9; c += 0.5) {
      const iv = lineIntervals(base, axis, c);
      const crossing = iv.reduce((s, [a, b]) => s + (b - a), 0);
      const score = crossing + 4 * iv.length + 0.1 * Math.abs(c - ideal);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    cuts.push(best);
    prev = best;
  }
  return cuts;
}

/** Dovetail tab on the cut `axis = at`, centred at `m` along the cut, protruding in the + direction. */
export function dovetail(axis: 0 | 1, at: number, m: number, p: SplitParams): Ring {
  const n = p.tabNeck / 2, h = p.tabHead / 2, d = p.tabDepth;
  const local: Ring = [[at - 0.5, m - n], [at, m - n], [at + d, m - h], [at + d, m + h], [at, m + n], [at - 0.5, m + n]];
  const r: Ring = axis === 0 ? local : local.map(([a, b]) => [b, a]);
  return area(r) < 0 ? r.reverse() : r;
}

export const colName = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`);

export function splitBody(base: Paths, walls: Paths, p: SplitParams): SplitResult {
  const warnings: string[] = [];
  const b = bbox(base);
  const depth = p.connectors ? p.tabDepth : 0;
  const maxCell = p.maxPiece - depth;
  const xCuts = chooseCuts(base, 0, b.minX, b.maxX, maxCell);
  const yCuts = chooseCuts(base, 1, b.minY, b.maxY, maxCell);
  const xs = [-FAR, ...xCuts, FAR];
  const ys = [-FAR, ...yCuts, FAR];
  const cols = xs.length - 1, rows = ys.length - 1;

  // Tabs indexed by owning cell and by the cell they intrude into.
  const owned = new Map<string, Ring[]>();
  const intruding = new Map<string, Ring[]>();
  const key = (c: number, r: number) => `${c},${r}`;
  const push = (m: Map<string, Ring[]>, k: string, t: Ring) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(t); };
  const tabs: Ring[] = [];
  const joints: Joint[] = [];

  const doCut = (axis: 0 | 1, idx: number, at: number) => {
    const across = axis === 0 ? ys : xs;
    for (let s = 0; s < across.length - 1; s++) {
      // Keep connectors away from the corners where two cuts cross.
      const lo = across[s] + (s > 0 ? 8 : 0), hi = across[s + 1] - (s < across.length - 2 ? 8 : 0);
      for (const [a0, b0] of lineIntervals(base, axis, at)) {
        const a = Math.max(a0, across[s]), bb = Math.min(b0, across[s + 1]);
        if (bb - a <= 0.05) continue;
        const joint: Joint = { axis, at, from: a, to: bb, tabs: 0 };
        joints.push(joint);
        if (!p.connectors) continue;
        const ia = Math.max(a, lo), ib = Math.min(bb, hi);
        const spans: [number, number][] = ib - ia > 70 ? [[ia, (ia + ib) / 2], [(ia + ib) / 2, ib]] : [[ia, ib]];
        for (const [sa, sb] of spans) {
          const t = placeTab(base, walls, axis, at, sa, sb, p);
          if (!t) continue;
          joint.tabs++;
          tabs.push(t);
          const owner = axis === 0 ? key(idx, s) : key(s, idx);
          const into = axis === 0 ? key(idx + 1, s) : key(s, idx + 1);
          push(owned, owner, t);
          push(intruding, into, t);
        }
      }
    }
  };
  xCuts.forEach((c, i) => doCut(0, i, c));
  yCuts.forEach((c, i) => doCut(1, i, c));

  for (const j of joints) {
    if (j.tabs > 0 || !p.connectors) continue;
    const where = j.axis === 0 ? `x = ${j.at.toFixed(0)} mm (y ${j.from.toFixed(0)}–${j.to.toFixed(0)})` : `y = ${j.at.toFixed(0)} mm (x ${j.from.toFixed(0)}–${j.to.toFixed(0)})`;
    const len = j.to - j.from;
    warnings.push(len < p.tabHead + 3
      ? `Joint at ${where} is only ${len.toFixed(1)} mm long and got no connector — glue it or add a backing strip.`
      : `Joint at ${where} crosses a tight curve or thin wall and got no connector — glue it or add a backing strip.`);
  }

  const pieces: Piece[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      let region: Paths = [rect(xs[c], ys[r], xs[c + 1], ys[r + 1])];
      const own = owned.get(key(c, r));
      if (own) region = union(region, own);
      const intr = intruding.get(key(c, r));
      if (intr) region = difference(region, offset(union(intr), p.connectorClearance));
      const cellBase = intersect(base, region);
      if (!cellBase.length) continue;
      const cellWalls = intersect(walls, region);
      const comps = toPolys(cellBase).filter((q) => totalArea(polyPaths(q)) > 2).sort((m, n) => area(n.outer) - area(m.outer));
      const rowLabel = rows - r;
      comps.forEach((comp, k) => {
        const id = `${colName(c)}${rowLabel}${comps.length > 1 ? String.fromCharCode(97 + k) : ''}`;
        const w = cellWalls.length ? toPolys(intersect(cellWalls, polyPaths(comp))) : [];
        const pb = bbox([comp.outer]);
        if (pb.maxX - pb.minX > p.maxPiece + 0.01 || pb.maxY - pb.minY > p.maxPiece + 0.01) {
          warnings.push(`Piece ${id} is ${(pb.maxX - pb.minX).toFixed(0)} × ${(pb.maxY - pb.minY).toFixed(0)} mm, larger than the ${p.maxPiece} mm limit.`);
        }
        pieces.push({ id, col: c, row: r, base: comp, walls: w, bbox: pb });
      });
    }
  }
  return { xCuts, yCuts, tabs, joints, pieces, warnings };
}

/** Finds a spot on the joint [a, b] where a dovetail sits in solid material, preferring spots clear of the walls. */
function placeTab(base: Paths, walls: Paths, axis: 0 | 1, at: number, a: number, b: number, p: SplitParams): Ring | null {
  const margin = p.tabHead / 2 + 1.5;
  const lo = a + margin, hi = b - margin;
  if (hi < lo) return null;
  const reach = p.tabDepth + 4;
  const box = axis === 0 ? rect(at - reach, a - 2, at + reach, b + 2) : rect(a - 2, at - reach, b + 2, at + reach);
  const localBase = intersect(base, [box]);
  const localWalls = intersect(walls, [box]);
  const mid = (lo + hi) / 2;
  const cands: number[] = [mid];
  for (let s = 1.5; mid - s >= lo || mid + s <= hi; s += 1.5) {
    if (mid + s <= hi) cands.push(mid + s);
    if (mid - s >= lo) cands.push(mid - s);
    if (cands.length > 40) break;
  }
  let best: Ring | null = null;
  let bestOverlap = Infinity;
  for (const m of cands) {
    const t = dovetail(axis, at, m, p);
    // The socket side needs material all round the tab, so test a grown copy.
    if (totalArea(difference(offset([t], p.connectorClearance + 1.2), localBase)) > 0.05) continue;
    const ov = localWalls.length ? totalArea(intersect(offset([t], p.connectorClearance + 0.6), localWalls)) : 0;
    if (ov < 0.01) return t;
    if (ov < bestOverlap) { bestOverlap = ov; best = t; }
  }
  return best;
}
