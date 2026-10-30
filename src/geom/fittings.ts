// Practical extras on top of the body: strip presets, a fit-test piece, cable holes and mounting points.
import {
  type Paths, type Polyline, type Pt, type Ring, bbox, difference, intersect, offset, polyPaths, toPolys,
  totalArea, tube, union,
} from './clip';
import { resample, type Params } from './design';
import type { Piece } from './split';

/** Common silicone LED neon flex sizes: width × height in mm. Walls stop 2 mm short so the strip sits proud. */
export const STRIP_PRESETS = [
  { name: '3 × 8 mm', width: 3, height: 8 },
  { name: '4 × 10 mm', width: 4, height: 10 },
  { name: '6 × 12 mm', width: 6, height: 12 },
  { name: '8 × 16 mm', width: 8, height: 16 },
  { name: '10 × 20 mm', width: 10, height: 20 },
  { name: '12 × 25 mm', width: 12, height: 25 },
];
export const presetWallHeight = (stripHeight: number) => Math.max(2, stripHeight - 2);

export function circle(c: Pt, r: number, n = 36): Ring {
  return Array.from({ length: n }, (_, i): Pt => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)]);
}

/**
 * A short U of channel: two 40 mm straights joined by a half circle at the minimum bend radius. Print it first
 * to check that the strip presses in snugly and takes the bend, before committing to the whole sign.
 */
export function fitTestPiece(params: Params): Piece {
  const half = (params.stripWidth + params.channelClearance) / 2;
  const R = Math.max(params.minBendRadius, half + params.wallThickness + 2);
  const pts: Pt[] = [[0, 0], [40, 0]];
  for (let i = 1; i < 36; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 36;
    pts.push([40 + R * Math.cos(a), R + R * Math.sin(a)]);
  }
  pts.push([40, 2 * R], [0, 2 * R]);
  const line: Polyline = { pts, closed: false };
  const channel = tube([line], half);
  const band = tube([line], half + params.wallThickness);
  const base = toPolys(band)[0];
  return { id: 'fit-test', col: 0, row: 0, base, walls: toPolys(difference(band, channel)), bbox: bbox([base.outer]) };
}

/**
 * Where the feed wire goes through the back: near the lower end of each open run, or at the bottom of a loop.
 * Holes are kept clear of the cuts between pieces.
 */
export function cableHolePoints(neon: Polyline[], r: number, cuts: { x: number[]; y: number[] }): Pt[] {
  const clear = (p: Pt) => cuts.x.every((c) => Math.abs(p[0] - c) > r + 1.5) && cuts.y.every((c) => Math.abs(p[1] - c) > r + 1.5);
  const out: Pt[] = [];
  for (const l of neon) {
    let s = resample(l.pts, l.closed, 1);
    if (s.length < 2) continue;
    let start: number;
    if (l.closed) {
      start = s.reduce((best, p, i) => (p[1] < s[best][1] ? i : best), 0);
    } else {
      if (s[s.length - 1][1] < s[0][1]) s = s.reverse();
      start = Math.min(s.length - 1, Math.ceil(r + 1.5));
    }
    let pick = s[start];
    // Slide along the run (both ways on a loop) until the hole is clear of every cut.
    for (let k = 0; k < 60; k++) {
      const fwd = s[l.closed ? (start + k) % s.length : Math.min(s.length - 1, start + k)];
      const back = l.closed ? s[(start - k + s.length) % s.length] : fwd;
      if (clear(fwd)) { pick = fwd; break; }
      if (clear(back)) { pick = back; break; }
    }
    out.push(pick);
  }
  return out;
}

export interface Mount { c: Pt; lug: boolean }

/**
 * Screw holes for fixing each piece to a wall or backing board. They go in solid back plate where there is
 * room (inside letters, on bridges); a piece with no room gets a small lug on its lower edge instead.
 * Wide pieces get two, as far apart as possible.
 */
export function mountPoints(piece: Piece, band: Paths, others: Paths, holeR: number, lugR: number, cuts: { x: number[]; y: number[] }): Mount[] {
  const ring = holeR + 2.5;
  const own = polyPaths(piece.base);
  const room = offset(difference(own, offset(band, 1)), -ring);
  const w = piece.bbox.maxX - piece.bbox.minX;
  const want = w > 150 ? 2 : 1;
  const candidates = room.flat();
  if (candidates.length) {
    if (want === 1) {
      const mid: Pt = [(piece.bbox.minX + piece.bbox.maxX) / 2, (piece.bbox.minY + piece.bbox.maxY) / 2];
      const c = candidates.reduce((b, p) => (dist(p, mid) < dist(b, mid) ? p : b));
      return [{ c, lug: false }];
    }
    const left = candidates.reduce((b, p) => (p[0] < b[0] ? p : b));
    const right = candidates.reduce((b, p) => (p[0] > b[0] ? p : b));
    return dist(left, right) > 40 ? [{ c: left, lug: false }, { c: right, lug: false }] : [{ c: left, lug: false }];
  }
  // Lugs: hang off the lowest point of the piece (or its left and right halves), if nothing else is in the way.
  const out: Mount[] = [];
  // Only the sign's real outer edge, not the straight edges left by cuts between pieces.
  const onCut = (p: Pt) => cuts.x.some((c) => Math.abs(p[0] - c) < 1) || cuts.y.some((c) => Math.abs(p[1] - c) < 1);
  const pts = piece.base.outer.filter((p) => !onCut(p));
  const halves = want === 2
    ? [pts.filter((p) => p[0] < piece.bbox.minX + w / 2), pts.filter((p) => p[0] >= piece.bbox.minX + w / 2)]
    : [pts];
  for (const h of halves) {
    if (!h.length) continue;
    const ranked = [...h].sort((a, b) => a[1] - b[1]).slice(0, 40);
    const topFirst = [...h].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [p, dir] of [...ranked.map((p) => [p, -1] as const), ...topFirst.map((p) => [p, 1] as const)]) {
      const c: Pt = [p[0], p[1] + dir * (lugR - 2)];
      if (cuts.x.some((x) => Math.abs(c[0] - x) < lugR + 1) || cuts.y.some((y) => Math.abs(c[1] - y) < lugR + 1)) continue;
      if (others.length && totalArea(intersect([circle(c, lugR + 1)], others)) > 0.01) continue;
      out.push({ c, lug: true });
      break;
    }
  }
  return out;
}

/** Adds lugs and cuts holes into a piece's base plate. Walls are left alone (holes sit in the channel floor). */
export function drillPiece(piece: Piece, mounts: Mount[], holeR: number, lugR: number, cable: Pt[], cableR: number): Piece {
  let base = polyPaths(piece.base);
  const lugs = mounts.filter((m) => m.lug).map((m) => circle(m.c, lugR));
  if (lugs.length) base = union(base, lugs);
  const holes = [...mounts.map((m) => circle(m.c, holeR, 24)), ...cable.map((c) => circle(c, cableR, 24))];
  if (holes.length) base = difference(base, holes);
  const polys = toPolys(base).sort((a, b) => totalArea(polyPaths(b)) - totalArea(polyPaths(a)));
  if (!polys.length) return piece;
  return { ...piece, base: polys[0], bbox: bbox([polys[0].outer]) };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
