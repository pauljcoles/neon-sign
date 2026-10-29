// Thin wrapper around clipper-lib working in millimetres (floats).
// Clipper uses integers, so coordinates are scaled to micrometres internally.
import ClipperLib from 'clipper-lib';

export type Pt = [number, number];
export type Ring = Pt[];
export type Paths = Ring[];
/** A polygon with holes, as produced by a PolyTree walk. */
export interface Poly { outer: Ring; holes: Ring[] }

const SCALE = 1000;
/** Max deviation of round joins from a true arc, in mm. Well below what a 0.4 mm nozzle can show. */
const ARC_TOL = 0.08;
const { ClipType, PolyType, PolyFillType, JoinType, EndType } = ClipperLib;

export type FillRule = 'nonzero' | 'evenodd';
const fillType = (r: FillRule) => (r === 'evenodd' ? PolyFillType.pftEvenOdd : PolyFillType.pftNonZero);

const toC = (p: Paths): ClipperLib.Paths =>
  p.map((r) => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
const ringFromC = (r: ClipperLib.Path): Ring => r.map((q) => [q.X / SCALE, q.Y / SCALE] as Pt);
const fromC = (p: ClipperLib.Paths): Paths => p.map(ringFromC);

function newClipper(subj: Paths, clip: Paths) {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(toC(subj), PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(toC(clip), PolyType.ptClip, true);
  return c;
}

function exec(type: ClipperLib.ClipType, subj: Paths, clip: Paths, subjFill: FillRule = 'nonzero', clipFill: FillRule = 'nonzero'): Paths {
  if (!subj.length && !clip.length) return [];
  const out: ClipperLib.Paths = [];
  newClipper(subj, clip).Execute(type, out, fillType(subjFill), fillType(clipFill));
  return clean(fromC(out));
}

/** Drops degenerate rings (fewer than 3 points or near-zero area). */
function clean(p: Paths): Paths {
  return p.filter((r) => r.length >= 3 && Math.abs(area(r)) > 1e-4);
}

export const union = (a: Paths, b: Paths = [], fill: FillRule = 'nonzero') => exec(ClipType.ctUnion, a, b, fill, fill);
export const intersect = (a: Paths, b: Paths) => exec(ClipType.ctIntersection, a, b);
export const difference = (a: Paths, b: Paths) => exec(ClipType.ctDifference, a, b);

/** Grows (d > 0) or shrinks (d < 0) closed polygons with round joins. Input should be normalised (e.g. a union result). */
export function offset(p: Paths, d: number): Paths {
  if (!p.length) return [];
  if (d === 0) return union(p);
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL * SCALE);
  co.AddPaths(toC(p), JoinType.jtRound, EndType.etClosedPolygon);
  const out: ClipperLib.Paths = [];
  co.Execute(out, d * SCALE);
  return clean(fromC(out));
}

export interface Polyline { pts: Pt[]; closed: boolean }

/** A band of half-width `d` centred on each polyline (closed or open). */
export function tube(lines: Polyline[], d: number): Paths {
  if (!lines.length || d <= 0) return [];
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL * SCALE);
  for (const l of lines) {
    if (l.pts.length < 2) continue;
    co.AddPath(toC([l.pts])[0], JoinType.jtRound, l.closed ? EndType.etClosedLine : EndType.etOpenRound);
  }
  const out: ClipperLib.Paths = [];
  co.Execute(out, d * SCALE);
  return union(clean(fromC(out)));
}

/** Clips open polylines against a region; returns the parts outside (keepInside = false) or inside it. */
export function clipLines(lines: Polyline[], region: Paths, keepInside: boolean): Polyline[] {
  if (!region.length) return keepInside ? [] : lines;
  const c = new ClipperLib.Clipper();
  for (const l of lines) {
    const pts = l.closed ? [...l.pts, l.pts[0]] : l.pts;
    c.AddPath(toC([pts])[0], PolyType.ptSubject, false);
  }
  c.AddPaths(toC(region), PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(keepInside ? ClipType.ctIntersection : ClipType.ctDifference, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const open = ClipperLib.Clipper.OpenPathsFromPolyTree(tree);
  return joinOpen(fromC(open).filter((r) => r.length >= 2)).map((pts) => ({ pts, closed: false }));
}

/** Clipper may split one polyline into several pieces that share endpoints; stitch them back together. */
function joinOpen(parts: Ring[]): Ring[] {
  const eq = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
  const out = parts.map((p) => p.slice());
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = 0; j < out.length && !merged; j++) {
        if (i === j) continue;
        if (eq(out[i][out[i].length - 1], out[j][0])) {
          out[i] = out[i].concat(out[j].slice(1));
          out.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return out;
}

/** Groups a set of paths into polygons with holes. */
export function toPolys(p: Paths): Poly[] {
  if (!p.length) return [];
  const c = newClipper(p, []);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const polys: Poly[] = [];
  const walk = (nodes: ClipperLib.PolyNode[]) => {
    for (const n of nodes) {
      const outer = ringFromC(n.Contour());
      if (outer.length < 3) continue;
      const holes: Ring[] = [];
      for (const h of n.Childs()) {
        const hr = ringFromC(h.Contour());
        if (hr.length >= 3) holes.push(hr);
        walk(h.Childs());
      }
      polys.push({ outer, holes });
    }
  };
  walk(tree.Childs());
  return polys;
}

/** Ramer–Douglas–Peucker simplification of a closed ring (tol in mm). */
export function simplifyRing(r: Ring, tol: number): Ring {
  if (r.length < 8) return r;
  // Split the loop at its two farthest-apart-ish points so both halves are open chains.
  let far = 0, best = -1;
  for (let i = 1; i < r.length; i++) {
    const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = simplifyChain(r.slice(0, far + 1), tol);
  const b = simplifyChain([...r.slice(far), r[0]], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : r;
}

export function simplifyChain(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k][0] - ax, py = pts[k][1] - ay;
      let d: number;
      if (len2 === 0) d = px * px + py * py;
      else {
        const c = px * dy - py * dx;
        d = (c * c) / len2;
      }
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > t2) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

export const simplify = (p: Paths, tol: number): Paths => p.map((r) => simplifyRing(r, tol)).filter((r) => r.length >= 3);

export const polyPaths = (p: Poly): Paths => [p.outer, ...p.holes];

/** Signed area; positive for counter-clockwise rings (y up). */
export function area(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}

/** Net area of a normalised path set (holes subtract). */
export const totalArea = (p: Paths) => p.reduce((s, r) => s + area(r), 0);

export function polylineLength(l: Polyline): number {
  let len = 0;
  const n = l.pts.length;
  for (let i = 1; i < n; i++) len += Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]);
  if (l.closed && n > 1) len += Math.hypot(l.pts[0][0] - l.pts[n - 1][0], l.pts[0][1] - l.pts[n - 1][1]);
  return len;
}

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export function bbox(p: Paths | Pt[][]): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const r of p) for (const [x, y] of r) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

export function pointInPaths(p: Paths, x: number, y: number): boolean {
  // Non-zero winding over all rings.
  let w = 0;
  for (const r of p) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yj <= y) {
        if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
      } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
    }
  }
  return w !== 0;
}

/** Intervals where a normalised region crosses the line `axis = c` (axis 0: vertical line x = c). */
export function lineIntervals(p: Paths, axis: 0 | 1, c: number): [number, number][] {
  const o = 1 - axis;
  const hits: number[] = [];
  for (const r of p) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j][axis];
      const b = r[i][axis];
      if ((a <= c && b > c) || (b <= c && a > c)) {
        const t = (c - a) / (b - a);
        hits.push(r[j][o] + t * (r[i][o] - r[j][o]));
      }
    }
  }
  hits.sort((m, n) => m - n);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
  return out;
}

export function rect(x0: number, y0: number, x1: number, y1: number): Ring {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
