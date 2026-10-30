// Single-line mode: the centre line of filled strokes, found by rasterising the shape and thinning it to a
// one-pixel skeleton, then tracing that back into smooth polylines.
import { type Paths, type Polyline, type Pt, bbox, lineIntervals, polylineLength, simplifyChain, totalArea } from './clip';

export interface CentrelineOptions {
  /** Pixel size in mm. Smaller is more accurate and slower; it is raised automatically for very large signs. */
  res?: number;
  /** Branches that stick out of a junction by less than this many mm are treated as noise and dropped. */
  minSpur?: number;
  /** Lines shorter than this (mm) are dropped. */
  minLength?: number;
  /** Max bend (degrees) between two branches that the neon will run straight through at a junction. */
  joinAngle?: number;
}

const MAX_PIXELS = 3_000_000;

export function centrelines(fill: Paths, opts: CentrelineOptions = {}): Polyline[] {
  if (!fill.length) return [];
  const b = bbox(fill);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  if (!(w > 0 && h > 0)) return [];
  let res = opts.res ?? 0.3;
  if ((w / res) * (h / res) > MAX_PIXELS) res = Math.sqrt((w * h) / MAX_PIXELS);
  const pad = 2;
  const W = Math.ceil(w / res) + 2 * pad, H = Math.ceil(h / res) + 2 * pad;
  const ox = b.minX - pad * res, oy = b.minY - pad * res;

  // Rasterise: a pixel is inside when its centre is.
  const img = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const cy = oy + (y + 0.5) * res;
    for (const [x0, x1] of lineIntervals(fill, 1, cy)) {
      const a = Math.max(0, Math.ceil((x0 - ox) / res - 0.5)), z = Math.min(W - 1, Math.floor((x1 - ox) / res - 0.5));
      img.fill(1, y * W + a, y * W + z + 1);
    }
  }
  thin(img, W, H);

  const toMm = (i: number): Pt => [ox + ((i % W) + 0.5) * res, oy + (Math.floor(i / W) + 0.5) * res];
  const g = new PixelGraph(img, W);
  g.pruneSpurs(Math.max(1, Math.round((opts.minSpur ?? 3) / res)));
  const chains = g.chains().map((c) => ({ pts: c.pts.map(toMm), closed: c.closed }));
  // Mean stroke width = area / centre-line length. Junctions closer than this are one crossing that thinning
  // split in two (an "x" comes out as two Y shapes joined by a short bar).
  const len = chains.reduce((t, c) => t + polylineLength(c), 0);
  const strokeWidth = len > 0 ? totalArea(fill) / len : 0;
  const joined = joinAtJunctions(chains, opts.joinAngle ?? 50, res, strokeWidth);
  const minLength = opts.minLength ?? 2;
  return joined
    .map((l) => ({ pts: simplifyChain(smooth(l.pts, l.closed, Math.max(2, Math.round(1.2 / res))), 0.04), closed: l.closed }))
    .filter((l) => l.pts.length >= 2 && polylineLength(l) >= minLength);
}

/** Zhang–Suen thinning, in place. Works on the list of foreground pixels so cost scales with ink, not area. */
function thin(img: Uint8Array, W: number, H: number) {
  let fg: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i]) {
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && y > 0 && x < W - 1 && y < H - 1) fg.push(i);
    else img[i] = 0;
  }
  const del: number[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (const i of fg) {
        const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
        const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
        const n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (n < 2 || n > 6) continue;
        const a = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (a !== 1) continue;
        if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(i);
      }
      if (del.length) {
        changed = true;
        for (const i of del) img[i] = 0;
      }
    }
    fg = fg.filter((i) => img[i]);
  }
}

const OFFSETS = (W: number) => [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];

/**
 * 8-connected skeleton pixels. A diagonal link is ignored when the two pixels already share a 4-connected
 * neighbour, which removes the little triangles that would otherwise look like junctions.
 */
class PixelGraph {
  constructor(private img: Uint8Array, private W: number) {}

  neighbours(i: number): number[] {
    const { img, W } = this;
    const out: number[] = [];
    for (const o of OFFSETS(W)) {
      const j = i + o;
      if (!img[j]) continue;
      const dx = o === -W - 1 || o === -1 || o === W - 1 ? -1 : o === -W + 1 || o === 1 || o === W + 1 ? 1 : 0;
      const dy = o < -1 ? -1 : o > 1 ? 1 : 0;
      if (dx && dy && (img[i + dx] || img[i + dy * W])) continue;
      out.push(j);
    }
    return out;
  }

  pixels(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.img.length; i++) if (this.img[i]) out.push(i);
    return out;
  }

  /** Removes short branches that end in free space, a few rounds so spurs on spurs go too. */
  pruneSpurs(maxLen: number) {
    for (let round = 0; round < 3; round++) {
      let removed = false;
      for (const start of this.pixels()) {
        if (!this.img[start] || this.neighbours(start).length !== 1) continue;
        const path = [start];
        let prev = -1, cur = start, hitJunction = false;
        while (path.length <= maxLen) {
          const next = this.neighbours(cur).filter((j) => j !== prev);
          if (next.length !== 1) { hitJunction = next.length > 1; break; }
          prev = cur; cur = next[0];
          if (this.neighbours(cur).length > 2) { hitJunction = true; break; }
          path.push(cur);
        }
        if (hitJunction && path.length <= maxLen) {
          for (const p of path) this.img[p] = 0;
          removed = true;
        }
      }
      if (!removed) break;
    }
  }

  /** Splits the skeleton into chains between endpoints and junctions; loops with no junction come out closed. */
  chains(): { pts: number[]; closed: boolean }[] {
    const deg = new Map<number, number>();
    const all = this.pixels();
    for (const i of all) deg.set(i, this.neighbours(i).length);
    const isNode = (i: number) => deg.get(i) !== 2;
    const used = new Set<string>();
    const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    const out: { pts: number[]; closed: boolean }[] = [];
    const walk = (from: number, first: number) => {
      const pts = [from, first];
      used.add(key(from, first));
      let prev = from, cur = first;
      while (!isNode(cur)) {
        const next = this.neighbours(cur).find((j) => j !== prev && !used.has(key(cur, j)));
        if (next === undefined) break;
        used.add(key(cur, next));
        pts.push(next);
        prev = cur; cur = next;
        if (cur === from) return { pts, closed: true };
      }
      return { pts, closed: false };
    };
    for (const n of all) {
      if (!isNode(n)) continue;
      if (deg.get(n) === 0) continue;
      for (const j of this.neighbours(n)) if (!used.has(key(n, j))) out.push(walk(n, j));
    }
    // Whatever is left is made of pure loops (an "O").
    for (const i of all) {
      for (const j of this.neighbours(i)) {
        if (used.has(key(i, j))) continue;
        const c = walk(i, j);
        if (c.closed) c.pts.pop();
        out.push({ pts: c.pts, closed: c.closed });
      }
    }
    return out.filter((c) => c.pts.length >= 2);
  }
}

/**
 * Chains meet at junctions. Where two of them line up, run the neon straight through (the longest join),
 * so an "x" or a script loop is one strip rather than four stubs.
 */
export function joinAtJunctions(chains: Polyline[], maxAngle: number, tol: number, mergeLen = 0): Polyline[] {
  const near = 2.5 * tol + 1e-9;
  const all = chains.filter((c) => !c.closed);
  // Group chain ends into junctions by position, then fold short chains between two junctions into one junction.
  const pos: Pt[] = all.flatMap((c) => [c.pts[0], c.pts[c.pts.length - 1]]);
  const parent = pos.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const unite = (a: number, b: number) => { parent[find(a)] = find(b); };
  for (let a = 0; a < pos.length; a++) for (let b = a + 1; b < pos.length; b++) {
    if (Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]) <= near) unite(a, b);
  }
  const degree = (e: number) => pos.reduce((n, _, i) => n + (find(i) === find(e) ? 1 : 0), 0);
  const drop = new Set<number>();
  all.forEach((c, i) => {
    if (polylineLength(c) < mergeLen && degree(2 * i) >= 3 && degree(2 * i + 1) >= 3 && find(2 * i) !== find(2 * i + 1)) {
      drop.add(i);
      unite(2 * i, 2 * i + 1);
    }
  });
  const open = all.filter((_, i) => !drop.has(i));
  const junction = all.flatMap((_, i) => (drop.has(i) ? [] : [find(2 * i), find(2 * i + 1)]));
  const done = chains.filter((c) => c.closed);
  // Ends that sit at the same junction (within a couple of pixels of each other).
  type End = { c: number; atStart: boolean; p: Pt; dir: Pt };
  const ends: End[] = [];
  const lookAhead = (pts: Pt[], atStart: boolean): Pt => {
    const seq = atStart ? pts : [...pts].reverse();
    const p0 = seq[0];
    let q = seq[seq.length - 1];
    let d = 0;
    for (let i = 1; i < seq.length; i++) {
      d += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]);
      if (d >= 3) { q = seq[i]; break; }
    }
    const len = Math.hypot(q[0] - p0[0], q[1] - p0[1]) || 1;
    // Direction pointing out of the junction, along the chain.
    return [(q[0] - p0[0]) / len, (q[1] - p0[1]) / len];
  };
  open.forEach((c, i) => {
    ends.push({ c: i, atStart: true, p: c.pts[0], dir: lookAhead(c.pts, true) });
    ends.push({ c: i, atStart: false, p: c.pts[c.pts.length - 1], dir: lookAhead(c.pts, false) });
  });
  const cos = Math.cos((maxAngle * Math.PI) / 180);
  const pairs: { a: number; b: number; s: number }[] = [];
  for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) {
    const ea = ends[a], eb = ends[b];
    if (ea.c === eb.c && open[ea.c].pts.length < 4) continue;
    if (junction[a] !== junction[b]) continue;
    // Going in along one and out along the other: the two outward directions should be opposite.
    const s = -(ea.dir[0] * eb.dir[0] + ea.dir[1] * eb.dir[1]);
    if (s >= cos) pairs.push({ a, b, s });
  }
  pairs.sort((x, y) => y.s - x.s);
  const mate = new Map<number, number>();
  for (const { a, b } of pairs) {
    if (mate.has(a) || mate.has(b)) continue;
    mate.set(a, b); mate.set(b, a);
  }
  const endIndex = (c: number, atStart: boolean) => 2 * c + (atStart ? 0 : 1);
  const seen = new Set<number>();
  const follow = (startEnd: number): Polyline => {
    const pts: Pt[] = [];
    let e = startEnd, closed = false;
    for (;;) {
      const c = ends[e].c;
      seen.add(c);
      const seq = ends[e].atStart ? open[c].pts : [...open[c].pts].reverse();
      pts.push(...(pts.length ? seq.slice(1) : seq));
      const exit = endIndex(c, !ends[e].atStart);
      const m = mate.get(exit);
      if (m === undefined) break;
      if (seen.has(ends[m].c)) { closed = ends[m].c === ends[startEnd].c && m === startEnd; break; }
      e = m;
    }
    if (closed) pts.pop();
    return { pts, closed };
  };
  // Start from ends with no partner first, then whatever remains is a ring of joined chains.
  for (let e = 0; e < ends.length; e++) if (!mate.has(e) && !seen.has(ends[e].c)) done.push(follow(e));
  for (let e = 0; e < ends.length; e++) if (!seen.has(ends[e].c)) done.push(follow(e));
  return done;
}

/** Moving average that keeps the ends of open lines in place. Takes the pixel staircase out of the line. */
function smooth(pts: Pt[], closed: boolean, k: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const r = closed ? k : Math.min(k, i, n - 1 - i);
    let sx = 0, sy = 0;
    for (let j = -r; j <= r; j++) {
      const p = pts[closed ? (i + j + n) % n : i + j];
      sx += p[0]; sy += p[1];
    }
    out.push([sx / (2 * r + 1), sy / (2 * r + 1)]);
  }
  return out;
}
