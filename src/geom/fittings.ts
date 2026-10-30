// Practical extras on top of the body: strip presets, a fit-test piece, cable holes and mounting points.
import {
  type Paths, type Polyline, type Pt, type Ring, bbox, difference, intersect, offset, pointInPaths, polyPaths, toPolys,
  totalArea, tube, union,
} from './clip';
import { resample, type Params } from './design';
import type { Piece } from './split';
import { textArea } from './strokefont';

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
 * Puts the runs in a sensible order for building: each one starts where its feed wire comes in (the lower end
 * of an open run, the bottom of a loop), and runs are numbered left to right, top line first.
 */
export function orderRuns(neon: Polyline[]): Polyline[] {
  const oriented = neon.map((l): Polyline => {
    if (!l.closed) return l.pts[l.pts.length - 1][1] < l.pts[0][1] ? { pts: [...l.pts].reverse(), closed: false } : l;
    const i = l.pts.reduce((best, p, k) => (p[1] < l.pts[best][1] ? k : best), 0);
    return { pts: [...l.pts.slice(i), ...l.pts.slice(0, i)], closed: true };
  });
  const key = (l: Polyline) => { const b = bbox([l.pts]); return { x: b.minX, top: b.maxY, h: b.maxY - b.minY }; };
  return oriented
    .map((l) => ({ l, k: key(l) }))
    // Same text line when the tops are within half a run's height; otherwise higher first.
    .sort((a, b) => (Math.abs(a.k.top - b.k.top) < Math.max(a.k.h, b.k.h) / 2 ? a.k.x - b.k.x : b.k.top - a.k.top))
    .map((x) => x.l);
}

export interface RunInfo {
  /** Strip length to cut, mm. */
  length: number;
  start: Pt;
  /** Unit direction the run sets off in, for the start arrow. */
  dir: Pt;
  /** Pieces the run passes through, in order. */
  pieces: string[];
}

export function runInfo(neon: Polyline[], pieces: Piece[]): RunInfo[] {
  return neon.map((l) => {
    const s = resample(l.pts, l.closed, 2);
    const a = s[0], b = s[Math.min(s.length - 1, 3)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const seq: string[] = [];
    for (const p of s) {
      const pc = pieces.find((q) => p[0] >= q.bbox.minX && p[0] <= q.bbox.maxX && p[1] >= q.bbox.minY && p[1] <= q.bbox.maxY && pointInPaths([q.base.outer], p[0], p[1]));
      if (pc && seq[seq.length - 1] !== pc.id) seq.push(pc.id);
    }
    let length = 0;
    for (let i = 1; i < l.pts.length; i++) length += dist(l.pts[i], l.pts[i - 1]);
    if (l.closed) length += dist(l.pts[0], l.pts[l.pts.length - 1]);
    return { length, start: a, dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len], pieces: seq };
  });
}

/**
 * Where the feed wire goes through the back: just inside the start of each run (see `orderRuns`), slid along
 * the run if needed to stay clear of the cuts between pieces.
 */
export function cableHolePoints(neon: Polyline[], r: number, cuts: { x: number[]; y: number[] }): Pt[] {
  const clear = (p: Pt) => cuts.x.every((c) => Math.abs(p[0] - c) > r + 1.5) && cuts.y.every((c) => Math.abs(p[1] - c) > r + 1.5);
  const out: Pt[] = [];
  for (const l of neon) {
    const s = resample(l.pts, l.closed, 1);
    if (s.length < 2) continue;
    const start = l.closed ? 0 : Math.min(s.length - 1, Math.ceil(r + 1.5));
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
  const b = piece.bbox;
  const localBand = intersect(band, [[[b.minX - 2, b.minY - 2], [b.maxX + 2, b.minY - 2], [b.maxX + 2, b.maxY + 2], [b.minX - 2, b.maxY + 2]]]);
  const room = offset(difference(own, offset(localBand, 1)), -ring);
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
  // In the solid style a screw hole goes through the solid letter as well as the plate.
  const walls = holes.length ? toPolys(difference(piece.walls.flatMap(polyPaths), holes)) : piece.walls;
  return { ...piece, base: polys[0], walls, bbox: bbox([polys[0].outer]) };
}

/**
 * Finds a spot on the underside of a piece for its engraved ID: plain floor with no wall above it, so the
 * engraving does not weaken a wall. Tries open back plate first (level text), then the channel floor, with the
 * text turned to follow the channel. Returns the engraved area, or null if nothing fits.
 */
export function placeLabel(piece: Piece, neon: Polyline[], text: string, stroke = 0.8): Paths | null {
  const walls = [...piece.walls, ...(piece.raised ?? [])].flatMap(polyPaths);
  const allowed = offset(walls.length ? difference(polyPaths(piece.base), walls) : polyPaths(piece.base), -0.5);
  if (!allowed.length) return null;
  const mid: Pt = [(piece.bbox.minX + piece.bbox.maxX) / 2, (piece.bbox.minY + piece.bbox.maxY) / 2];
  const fits = (area: Paths) => {
    // Clip to a box around the label first; the whole piece outline is far too big to test against each time.
    const b = bbox(area);
    const local = intersect(allowed, [[[b.minX - 1, b.minY - 1], [b.maxX + 1, b.minY - 1], [b.maxX + 1, b.maxY + 1], [b.minX - 1, b.maxY + 1]]]);
    return totalArea(difference(area, local)) < 0.01;
  };
  for (const height of [5, 4]) {
    const width = (text.length * 5.5 - 1.5) * (height / 6) + stroke;
    // Open back plate: anywhere a circle round the whole label fits, the label fits level.
    const open = offset(allowed, -(Math.hypot(width, height + stroke) / 2 + 0.2)).flat();
    if (open.length) {
      const at = open.reduce((best, p) => (dist(p, mid) < dist(best, mid) ? p : best));
      const area = textArea(text, height, stroke, at, 0, true);
      if (fits(area)) return area;
    }
    // Channel floor: follow the channel, straightest stretches near the middle first.
    const cands: { at: Pt; angle: number; score: number }[] = [];
    for (const l of neon) {
      const s = resample(l.pts, l.closed, 2);
      const k = Math.max(1, Math.round(width / 4));
      for (let i = k; i + k < s.length; i++) {
        if (!pointInPaths(allowed, s[i][0], s[i][1])) continue;
        const a0 = Math.atan2(s[i][1] - s[i - k][1], s[i][0] - s[i - k][0]);
        const a1 = Math.atan2(s[i + k][1] - s[i][1], s[i + k][0] - s[i][0]);
        let bend = Math.abs(a1 - a0);
        if (bend > Math.PI) bend = 2 * Math.PI - bend;
        let a = Math.atan2(s[i + k][1] - s[i - k][1], s[i + k][0] - s[i - k][0]);
        // Keep the text the right way up.
        if (a > Math.PI / 2) a -= Math.PI;
        if (a <= -Math.PI / 2) a += Math.PI;
        cands.push({ at: s[i], angle: a, score: bend * 100 + dist(s[i], mid) / 50 });
      }
    }
    cands.sort((x, y) => x.score - y.score);
    for (const c of cands.slice(0, 40)) {
      const area = textArea(text, height, stroke, c.at, c.angle, true);
      if (fits(area)) return area;
    }
  }
  return null;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
