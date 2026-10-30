// A tiny single-stroke font for engraving piece IDs. Glyphs sit on a 4 × 6 grid, y up.
import { type Paths, type Polyline, type Pt, tube } from './clip';

type Glyph = Pt[][];
const O: Pt[] = [[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]];
const P: Pt[] = [[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]];

const GLYPHS: Record<string, Glyph> = {
  A: [[[0, 0], [2, 6], [4, 0]], [[0.7, 2], [3.3, 2]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]],
  J: [[[0, 1], [1, 0], [2, 0], [3, 1], [3, 6]]],
  K: [[[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1.3, 3.3], [4, 0]]],
  L: [[[0, 6], [0, 0], [4, 0]]],
  M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
  N: [[[0, 0], [0, 6], [4, 0], [4, 6]]],
  O: [O],
  P: [P],
  Q: [O, [[2.5, 1.5], [4, 0]]],
  R: [P, [[2, 3], [4, 0]]],
  S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  T: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
  U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
  V: [[[0, 6], [2, 0], [4, 6]]],
  W: [[[0, 6], [1, 0], [2, 3], [3, 0], [4, 6]]],
  X: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
  Y: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
  Z: [[[0, 6], [4, 6], [0, 0], [4, 0]]],
  0: [O, [[0.6, 0.6], [3.4, 5.4]]],
  1: [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
  2: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
  3: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [2, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  4: [[[3, 0], [3, 6], [0, 2], [4, 2]]],
  5: [[[4, 6], [0, 6], [0, 3], [3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  6: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  7: [[[0, 6], [4, 6], [1, 0]]],
  8: [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  9: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [4, 3]]],
  '-': [[[0.5, 3], [3.5, 3]]],
};

/** Centre lines of `text`, `height` mm tall, centred on the origin. Lower-case letters come out as small capitals. */
export function textStrokes(text: string, height: number): Polyline[] {
  const u = height / 6;
  const out: Polyline[] = [];
  let x = 0;
  for (const ch of text) {
    const small = ch !== ch.toUpperCase();
    const g = GLYPHS[ch.toUpperCase()];
    const k = small ? 0.7 : 1;
    if (g) for (const s of g) out.push({ pts: s.map(([gx, gy]) => [x + gx * u * k, gy * u * k] as Pt), closed: false });
    x += 5.5 * u * k;
  }
  const w = x - 1.5 * u;
  return out.map((l) => ({ pts: l.pts.map(([px, py]) => [px - w / 2, py - height / 2] as Pt), closed: false }));
}

/**
 * The engraved area for `text`: strokes `stroke` mm wide, rotated by `angle` and moved to `at`. With `mirror`
 * the text reads correctly when the piece is turned over, which is how the underside is seen.
 */
export function textArea(text: string, height: number, stroke: number, at: Pt, angle: number, mirror: boolean): Paths {
  const c = Math.cos(angle), s = Math.sin(angle);
  const lines = textStrokes(text, height).map((l) => ({
    closed: false,
    pts: l.pts.map(([x0, y]) => {
      const x = mirror ? -x0 : x0;
      return [at[0] + x * c - y * s, at[1] + x * s + y * c] as Pt;
    }),
  }));
  return tube(lines, stroke / 2);
}
