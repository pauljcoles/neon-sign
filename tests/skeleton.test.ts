import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { type Polyline, polylineLength, rect, tube, union } from '../src/geom/clip';
import { buildDesign, defaultParams } from '../src/geom/design';
import { centrelines } from '../src/geom/skeleton';
import { textSource } from '../src/geom/source';

const font = (name: string) => {
  const b = readFileSync(new URL(`../public/fonts/${name}`, import.meta.url));
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const total = (ls: Polyline[]) => ls.reduce((s, l) => s + polylineLength(l), 0);
const maxDev = (ls: Polyline[], f: (x: number, y: number) => number) => Math.max(...ls.flatMap((l) => l.pts.map(([x, y]) => f(x, y))));

describe('centrelines', () => {
  it('turns a bar into one line down its middle', () => {
    const ls = centrelines([rect(0, 0, 100, 10)]);
    expect(ls).toHaveLength(1);
    expect(ls[0].closed).toBe(false);
    // The skeleton stops about half a stroke width short of each end.
    expect(total(ls)).toBeGreaterThan(85);
    expect(total(ls)).toBeLessThan(101);
    expect(maxDev(ls, (_, y) => Math.abs(y - 5))).toBeLessThan(0.5);
  });

  it('turns a ring into one closed loop', () => {
    const ring = tube([{ pts: Array.from({ length: 90 }, (_, i) => [50 * Math.cos(i / 90 * 2 * Math.PI), 50 * Math.sin(i / 90 * 2 * Math.PI)]), closed: true }], 5);
    const ls = centrelines(ring);
    expect(ls).toHaveLength(1);
    expect(ls[0].closed).toBe(true);
    expect(total(ls)).toBeCloseTo(2 * Math.PI * 50, -1);
    expect(maxDev(ls, (x, y) => Math.abs(Math.hypot(x, y) - 50))).toBeLessThan(0.6);
  });

  it('runs straight through an x where thinning splits the crossing in two', () => {
    const x = union([...tube([{ pts: [[-50, -50], [50, 50]], closed: false }], 6), ...tube([{ pts: [[-50, 50], [50, -50]], closed: false }], 6)]);
    const ls = centrelines(x);
    expect(ls).toHaveLength(2);
  });

  it('runs straight through a cross instead of stopping at the junction', () => {
    const plus = union([rect(-50, -4, 50, 4), rect(-4, -50, 4, 50)]);
    const ls = centrelines(plus);
    expect(ls).toHaveLength(2);
    for (const l of ls) expect(polylineLength(l)).toBeGreaterThan(85);
  });

  it('keeps the side branch of a T as its own run', () => {
    const t = union([rect(-50, 40, 50, 48), rect(-4, -50, 4, 48)]);
    const ls = centrelines(t);
    expect(ls.length).toBe(2);
    expect(total(ls)).toBeGreaterThan(170);
  });
});

describe('single-line designs', () => {
  it('uses much less neon than outlines and builds a body around the line only', () => {
    const src = textSource(font('Pacifico-Regular.ttf'), 'Glow', { letterSpacing: 0, lineHeight: 1.1, kerning: true });
    const outline = buildDesign(src, defaultParams)!;
    const single = buildDesign(src, { ...defaultParams, neonStyle: 'single' })!;
    expect(single.stats.neonMetres).toBeGreaterThan(0.3);
    expect(single.stats.neonMetres).toBeLessThan(outline.stats.neonMetres * 0.65);
    // Script joins make T junctions, so a word is a handful of runs rather than one.
    expect(single.stats.neonRuns).toBeLessThanOrEqual(12);
    expect(single.pieces.length).toBeGreaterThan(0);
  });

  it('uses stroked lines as they are', () => {
    const src = { items: [{ label: 'path', rings: [], fill: 'nonzero' as const, word: 0, line: 0, strokeWidth: 4, lines: [{ pts: [[0, 0], [100, 0], [100, 50]] as [number, number][], closed: false }] }] };
    const d = buildDesign(src, { ...defaultParams, width: 200, neonStyle: 'single' })!;
    expect(d.neon).toHaveLength(1);
    expect(d.stats.neonMetres).toBeCloseTo(0.3, 2);
    expect(d.warnings.filter((w) => w.includes('too small'))).toHaveLength(0);
  });

  it('gives narrow single-line seams a smaller connector instead of none', () => {
    // A wavy 600 mm line: the body is about 11 mm wide wherever it is cut.
    const pts = Array.from({ length: 121 }, (_, i): [number, number] => [i * 5, 30 * Math.sin(i / 8)]);
    const src = { items: [{ label: 'wave', rings: [], fill: 'nonzero' as const, word: 0, line: 0, strokeWidth: 1, lines: [{ pts, closed: false }] }] };
    const d = buildDesign(src, { ...defaultParams, width: 600, neonStyle: 'single' })!;
    expect(d.split.joints.length).toBeGreaterThanOrEqual(2);
    for (const j of d.split.joints) expect(j.tabs).toBeGreaterThan(0);
    expect(d.split.joints.some((j) => j.small > 0)).toBe(true);
    expect(d.warnings.some((w) => w.includes('got no connector'))).toBe(false);
  });

  it('warns when a dot is too small for a line', () => {
    const d = buildDesign({ items: [{ label: 'i', rings: [rect(0, 0, 8, 80), rect(0, -20, 8, -12)], fill: 'nonzero', word: 0, line: 0 }] },
      { ...defaultParams, width: 8, neonStyle: 'single' })!;
    expect(d.neon).toHaveLength(1);
    expect(d.warnings.some((w) => w.includes('too small'))).toBe(true);
  });
});
