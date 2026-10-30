import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { type Pt, pointInPaths, polyPaths, rect, totalArea } from '../src/geom/clip';
import { buildDesign, defaultParams, type Params } from '../src/geom/design';
import { splitStrokes, textSource } from '../src/geom/source';
import { assemblyGuide, templateSvg } from '../src/export/files';
import { pieceMesh, prism, type Tris } from '../src/export/mesh';

const font = (name: string) => {
  const b = readFileSync(new URL(`../public/fonts/${name}`, import.meta.url));
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const glow = textSource(font('Pacifico-Regular.ttf'), 'Glow', { letterSpacing: 0, lineHeight: 1.1, kerning: true });
const build = (p: Partial<Params> = {}) => buildDesign(glow, { ...defaultParams, ...p })!;

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

describe('runs', () => {
  const d = build();
  it('start at the lower end and come with a cut list', () => {
    expect(d.runs).toHaveLength(d.neon.length);
    for (const [i, l] of d.neon.entries()) {
      if (!l.closed) expect(l.pts[0][1]).toBeLessThanOrEqual(l.pts[l.pts.length - 1][1]);
      else expect(Math.min(...l.pts.map((p) => p[1]))).toBeCloseTo(l.pts[0][1], 5);
      expect(d.runs[i].pieces.length).toBeGreaterThan(0);
    }
    const total = d.runs.reduce((t, r) => t + r.length, 0) / 1000;
    expect(total).toBeCloseTo(d.stats.neonMetres, 3);
    expect(templateSvg(d)).toContain('>1</text>');
    expect(assemblyGuide(d, 'Glow')).toContain('cut list');
  });
});

describe('engraved labels', () => {
  it.each(['outline', 'single'] as const)('go on every piece, clear of the walls, in %s mode', (neonStyle) => {
    const d = build({ neonStyle });
    for (const p of d.pieces) {
      expect(p.label?.length).toBeGreaterThan(0);
      const walls = p.walls.flatMap(polyPaths);
      for (const r of p.label!) for (const [x, y] of r) {
        expect(pointInPaths(polyPaths(p.base), x, y)).toBe(true);
        expect(pointInPaths(walls, x, y)).toBe(false);
      }
      expect(pieceMesh(p, d.params).length).toBeGreaterThan(0);
    }
  });
});

describe('body styles', () => {
  it('solid letters fill to the top, channel-only drops the plate, raised bridges stand up', () => {
    const plate = build(), solid = build({ bodyStyle: 'solid' }), channel = build({ bodyStyle: 'channel' });
    expect(totalArea(solid.walls)).toBeGreaterThan(totalArea(plate.walls) * 1.5);
    expect(totalArea(channel.base)).toBeLessThan(totalArea(plate.base) * 0.8);
    const twoIslands = buildDesign({ items: [
      { label: 'a', rings: [rect(0, 0, 40, 40)], fill: 'nonzero', word: 0, line: 0 },
      { label: 'b', rings: [rect(80, 0, 120, 40)], fill: 'nonzero', word: 1, line: 0 },
    ] }, { ...defaultParams, width: 120, bridgeHeight: 8 })!;
    const raised = twoIslands.pieces.flatMap((p) => p.raised ?? []);
    expect(raised.length).toBeGreaterThan(0);
    for (const p of twoIslands.pieces) for (const shell of [p.base, ...p.walls, ...(p.raised ?? [])]) expect(isWatertight(prism(shell, 0, 5))).toBe(true);
  });
});

describe('size and cuts', () => {
  it('sizes by height', () => {
    expect(build({ sizeBy: 'height', height: 180 }).stats.letterHeight).toBeCloseTo(180, 0);
  });
  it('cuts an even grid when asked', () => {
    const d = build({ width: 700, cutMode: 'grid' });
    const b = d.split.xCuts;
    expect(b.length).toBeGreaterThanOrEqual(2);
    const gaps = b.slice(1).map((x, i) => x - b[i]);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 6);
  });
});

describe('single-line fonts', () => {
  it('turns an out-and-back outline into one open stroke', () => {
    const there: Pt[] = Array.from({ length: 21 }, (_, i) => [i * 2, 10 * Math.sin(i / 4)]);
    const ring = [...there, ...there.slice(1, -1).reverse()];
    const { rings, lines } = splitStrokes([ring, rect(0, 0, 30, 30)]);
    expect(rings).toHaveLength(1);
    expect(lines).toHaveLength(1);
    const len = lines[0].pts.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - lines[0].pts[i][0], p[1] - lines[0].pts[i][1]), 0);
    const want = there.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - there[i][0], p[1] - there[i][1]), 0);
    expect(len).toBeCloseTo(want, 3);
  });
});
