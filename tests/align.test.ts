import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { type BBox } from '../src/geom/clip';
import { textSource } from '../src/geom/source';
import { snapOffset } from '../src/ui/snap';

const font = (name: string) => {
  const b = readFileSync(new URL(`../public/fonts/${name}`, import.meta.url));
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const text = (align: 'left' | 'center' | 'right', name = 'Pacifico-Regular.ttf') =>
  textSource(font(name), 'Come and\nget it', { letterSpacing: 0, lineHeight: 1.1, kerning: true, align });
/** Ink extent of each line, along x. */
const extents = (s: ReturnType<typeof text>) => {
  const e = new Map<number, [number, number]>();
  for (const it of s.items) for (const r of it.rings) for (const [x] of r) {
    const v = e.get(it.line) ?? [Infinity, -Infinity];
    e.set(it.line, [Math.min(v[0], x), Math.max(v[1], x)]);
  }
  return [...e.values()];
};

describe('line alignment', () => {
  it.each(['Pacifico-Regular.ttf', 'Righteous-Regular.ttf'])('lines up the left edges, centres or right edges (%s)', (f) => {
    const l = extents(text('left', f)), c = extents(text('center', f)), r = extents(text('right', f));
    expect(l[0][0]).toBeCloseTo(l[1][0], 6);
    expect(c[0][0] + c[0][1]).toBeCloseTo(c[1][0] + c[1][1], 6);
    expect(r[0][1]).toBeCloseTo(r[1][1], 6);
    // Only sideways: the two lines keep their widths.
    const plain = extents(textSource(font(f), 'Come and' + String.fromCharCode(10) + 'get it', { letterSpacing: 0, lineHeight: 1.1, kerning: true }));
    expect(c[0][1] - c[0][0]).toBeCloseTo(plain[0][1] - plain[0][0], 6);
    expect(c[1][1] - c[1][0]).toBeCloseTo(plain[1][1] - plain[1][0], 6);
  });

  it('keeps words and lines as they were', () => {
    const s = text('center');
    expect(new Set(s.items.map((i) => i.line))).toEqual(new Set([0, 1]));
    expect(new Set(s.items.map((i) => i.word)).size).toBe(4);
  });
});

describe('snapping', () => {
  const box = (minX: number, minY: number, maxX: number, maxY: number): BBox => ({ minX, minY, maxX, maxY });
  const start = box(0, 0, 100, 20);

  it('locks the centre onto another line\'s centre', () => {
    const s = snapOffset(start, [box(-10, 40, 110, 60)], 4, 30, 5);
    expect(s.dx).toBeCloseTo(0 + 0, 6); // centres: start 50+4=54, target 50 -> back by 4
    expect(s.guides.x).toEqual([50]);
  });

  it('locks a left edge onto a left edge, and a bottom onto a top', () => {
    const s = snapOffset(start, [box(12, 40, 60, 80)], 11, 19.5, 3);
    expect(s.dx).toBeCloseTo(12, 6);
    expect(s.guides.x).toEqual([12]);
    expect(s.dy).toBeCloseTo(20, 6);
    expect(s.guides.y).toEqual([40]);
  });

  it('does nothing when nothing is near enough', () => {
    const s = snapOffset(start, [box(0, 200, 100, 220)], 33, 40, 5);
    expect(s).toEqual({ dx: 33, dy: 40, guides: { x: [], y: [] } });
  });

  it('picks the nearest of several matches on each axis', () => {
    const s = snapOffset(start, [box(0, 0, 30, 10), box(22, 0, 80, 10)], 21, 0, 5);
    expect(s.dx).toBeCloseTo(22, 6);
  });
});
