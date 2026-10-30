import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { pointInPaths, polyPaths } from '../src/geom/clip';
import { buildDesign, defaultParams } from '../src/geom/design';
import { fitTestPiece, STRIP_PRESETS } from '../src/geom/fittings';
import { textSource } from '../src/geom/source';
import { prism, type Tris } from '../src/export/mesh';

const font = (name: string) => {
  const b = readFileSync(new URL(`../public/fonts/${name}`, import.meta.url));
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

function isWatertight(tris: Tris): boolean {
  const edges = new Map<string, number>();
  const key = (t: number) => `${Math.fround(tris[t])},${Math.fround(tris[t + 1])},${Math.fround(tris[t + 2])}`;
  for (let t = 0; t < tris.length; t += 9) {
    const v = [key(t), key(t + 3), key(t + 6)];
    for (let k = 0; k < 3; k++) {
      const e = `${v[k]}|${v[(k + 1) % 3]}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  for (const [e, n] of edges) {
    const [a, b] = e.split('|');
    if (n !== 1 || edges.get(`${b}|${a}`) !== 1) return false;
  }
  return true;
}

const design = (text: string, fontName: string, neonStyle: 'outline' | 'single') =>
  buildDesign(textSource(font(fontName), text, { letterSpacing: 0, lineHeight: 1.1, kerning: true }), { ...defaultParams, neonStyle })!;

describe('fit test piece', () => {
  it.each(STRIP_PRESETS)('is a small closed U for $name strip', (p) => {
    const piece = fitTestPiece({ ...defaultParams, stripWidth: p.width });
    expect(piece.bbox.maxX - piece.bbox.minX).toBeLessThan(100);
    expect(piece.walls.length).toBeGreaterThan(0);
    for (const shell of [piece.base, ...piece.walls]) expect(isWatertight(prism(shell, 0, 5))).toBe(true);
  });
});

describe('cable and mounting holes', () => {
  it.each(['outline', 'single'] as const)('puts one cable hole per run, clear of cuts, in %s mode', (style) => {
    const d = design('Glow', 'Pacifico-Regular.ttf', style);
    expect(d.cableHoles).toHaveLength(d.neon.length);
    for (const [x, y] of d.cableHoles) {
      expect(pointInPaths(d.channel, x, y)).toBe(true);
      for (const c of d.split.xCuts) expect(Math.abs(x - c)).toBeGreaterThan(3);
      // The hole really is cut through the plate.
      expect(d.pieces.some((p) => pointInPaths(polyPaths(p.base), x, y))).toBe(false);
    }
  });

  it('puts screw holes inside the letters when there is back plate, and lugs when there is not', () => {
    const outline = design('Glow', 'Pacifico-Regular.ttf', 'outline');
    expect(outline.mounts.length).toBeGreaterThanOrEqual(outline.pieces.length);
    expect(outline.mounts.every((m) => !m.lug)).toBe(true);
    for (const { c } of outline.mounts) expect(pointInPaths(outline.walls, c[0], c[1])).toBe(false);

    const single = design('Glow', 'Pacifico-Regular.ttf', 'single');
    expect(single.mounts.length).toBeGreaterThanOrEqual(single.pieces.length);
    expect(single.mounts.some((m) => m.lug)).toBe(true);
    for (const d of [outline, single]) {
      for (const p of d.pieces) {
        expect(p.bbox.maxX - p.bbox.minX).toBeLessThanOrEqual(d.params.bedSize);
        for (const shell of [p.base, ...p.walls]) expect(isWatertight(prism(shell, 0, 5))).toBe(true);
      }
    }
  });

  it('can be switched off', () => {
    const d = buildDesign(textSource(font('Righteous-Regular.ttf'), 'Hi', { letterSpacing: 0, lineHeight: 1.1, kerning: true }),
      { ...defaultParams, cableHoles: false, mountHoles: false })!;
    expect(d.cableHoles).toHaveLength(0);
    expect(d.mounts).toHaveLength(0);
  });
});
