import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { lineIntervals, offset, polylineLength, rect, totalArea, tube, union } from '../src/geom/clip';
import { buildDesign, defaultParams, tightSpots } from '../src/geom/design';
import { flattenCommands, parsePathData, textSource } from '../src/geom/source';
import { splitBody } from '../src/geom/split';
import { pieceMesh, prism, toBinaryStl, type Tris } from '../src/export/mesh';

const font = (name: string) => {
  const b = readFileSync(new URL(`../public/fonts/${name}`, import.meta.url));
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/** Every edge must be used exactly once in each direction for a closed, consistently oriented shell. */
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

const meshVolume = (tris: Tris) => {
  let v = 0;
  for (let t = 0; t < tris.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.slice(t, t + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
};

describe('offset', () => {
  it('grows a square by a rounded margin', () => {
    const grown = offset([rect(0, 0, 10, 10)], 1);
    // 12×12 square minus the four corners that become quarter circles of radius 1.
    expect(totalArea(grown)).toBeCloseTo(144 - (4 - Math.PI), 0);
  });

  it('shrinks and can make a shape vanish', () => {
    expect(totalArea(offset([rect(0, 0, 10, 10)], -2))).toBeCloseTo(36, 3);
    expect(offset([rect(0, 0, 10, 10)], -6)).toHaveLength(0);
  });

  it('makes a channel band of the requested width around a closed path', () => {
    const band = tube([{ pts: rect(0, 0, 100, 50), closed: true }], 3);
    // Band of width 6 along a 300 mm perimeter: inner 94×44 hole, outer 106×56 with rounded corners.
    expect(totalArea(band) / (106 * 56 - (4 - Math.PI) * 9 - 94 * 44)).toBeCloseTo(1, 2);
  });
});

describe('neon length', () => {
  it('equals the outline perimeter in merge mode', () => {
    const src = { items: [{ label: 'box', rings: [rect(0, 0, 100, -40)], fill: 'nonzero' as const, word: 0, line: 0 }] };
    const d = buildDesign(src, { ...defaultParams, width: 100 })!;
    expect(d.neon).toHaveLength(1);
    expect(d.stats.neonMetres).toBeCloseTo(0.28, 4);
  });

  it('keeps the top letter outline through an overlap when stacking', () => {
    const a = { label: 'a', rings: [rect(0, 0, 60, -40)], fill: 'nonzero' as const, word: 0, line: 0 };
    const b = { label: 'b', rings: [rect(40, 0, 100, -40)], fill: 'nonzero' as const, word: 0, line: 0 };
    const merged = buildDesign({ items: [a, b] }, { ...defaultParams, width: 100 })!;
    const stacked = buildDesign({ items: [a, b] }, { ...defaultParams, width: 100, overlap: 'later-on-top' })!;
    expect(merged.stats.neonMetres).toBeCloseTo(0.28, 3);
    // Upper box keeps its full 240 mm outline; the lower one loses the 40 mm edge hidden under it and the
    // 2 × 20 mm of top/bottom edge that is covered.
    expect(stacked.stats.neonMetres).toBeCloseTo(0.36, 3);
    expect(polylineLength(stacked.neon[0]) + polylineLength(stacked.neon[1])).toBeCloseTo(360, 0);
  });

  it('flags tight bends but not gentle ones', () => {
    expect(tightSpots([{ pts: rect(0, 0, 100, 100), closed: true }], 10)).toHaveLength(4);
    const circle = Array.from({ length: 200 }, (_, i) => [50 * Math.cos(i * Math.PI / 100), 50 * Math.sin(i * Math.PI / 100)] as [number, number]);
    expect(tightSpots([{ pts: circle, closed: true }], 10)).toHaveLength(0);
  });
});

describe('split', () => {
  const params = { maxPiece: 240, connectors: true, connectorClearance: 0.2, tabNeck: 7, tabHead: 10, tabDepth: 6 };

  it('cuts a long bar into pieces that fit and adds connectors', () => {
    const base = [rect(0, 0, 700, 60)];
    const r = splitBody(base, [], params);
    expect(r.xCuts).toHaveLength(2);
    expect(r.yCuts).toHaveLength(0);
    expect(r.pieces).toHaveLength(3);
    for (const p of r.pieces) {
      expect(p.bbox.maxX - p.bbox.minX).toBeLessThanOrEqual(240);
      expect(p.bbox.maxY - p.bbox.minY).toBeLessThanOrEqual(240);
    }
    expect(r.tabs.length).toBeGreaterThanOrEqual(2);
    expect(r.joints.every((j) => j.tabs > 0)).toBe(true);
    // Pieces add up to the bar minus only the connector clearance.
    const sum = r.pieces.reduce((s, p) => s + totalArea([p.base.outer, ...p.base.holes]), 0);
    expect(sum).toBeLessThan(700 * 60);
    expect(sum).toBeGreaterThan(700 * 60 - 60);
  });

  it('prefers cutting through gaps', () => {
    // Two blocks joined by a thin bridge at 200-220: one cut, and it should land on the bridge.
    const base = union([rect(0, 0, 200, 50), rect(220, 0, 400, 50), rect(190, 20, 230, 30)]);
    const r = splitBody(base, [], params);
    expect(r.xCuts).toHaveLength(1);
    expect(lineIntervals(base, 0, r.xCuts[0]).reduce((s, [a, b]) => s + b - a, 0)).toBeLessThanOrEqual(10);
  });

  it('cuts rows when the sign is taller than the bed', () => {
    const r = splitBody([rect(0, 0, 200, 500)], [], params);
    expect(r.yCuts).toHaveLength(2);
    expect(r.pieces.map((p) => p.id).sort()).toEqual(['A1', 'A2', 'A3']);
  });
});

describe('svg paths', () => {
  it('parses arcs into a circle', () => {
    const rings = flattenCommands(parsePathData('M0 10 A10 10 0 1 0 20 10 A10 10 0 1 0 0 10 Z'), 0.2);
    expect(Math.abs(totalArea(rings))).toBeCloseTo(Math.PI * 100, 0);
  });

  it('handles relative commands', () => {
    const rings = flattenCommands(parsePathData('m10 10 h20 v10 h-20 z'), 1);
    expect(Math.abs(totalArea(rings))).toBeCloseTo(200, 5);
  });
});

describe('text layout', () => {
  it('groups glyphs into words and lines', () => {
    const src = textSource(font('Righteous-Regular.ttf'), 'ab cd\nef', { letterSpacing: 0, lineHeight: 1.2, kerning: true });
    expect(src.items.map((i) => i.label).join('')).toBe('abcdef');
    const words = src.items.map((i) => i.word);
    expect(words[0]).toBe(words[1]);
    expect(words[2]).toBe(words[3]);
    expect(new Set(words).size).toBe(3);
    expect(src.items.map((i) => i.line)).toEqual([0, 0, 0, 0, 1, 1]);
  });
});

describe('full pipeline', () => {
  it.each(['Pacifico-Regular.ttf', 'Righteous-Regular.ttf', 'Lobster-Regular.ttf'])('builds printable pieces for %s', (name) => {
    const src = textSource(font(name), 'Neon Bar', { letterSpacing: -0.02, lineHeight: 1.2, kerning: true });
    const d = buildDesign(src, { ...defaultParams, width: 620 })!;
    expect(d.stats.letterWidth).toBeCloseTo(620, 0);
    expect(d.stats.pieces).toBeGreaterThanOrEqual(3);
    expect(d.stats.neonMetres).toBeGreaterThan(1);
    for (const p of d.pieces) {
      expect(p.bbox.maxX - p.bbox.minX).toBeLessThanOrEqual(240);
      expect(p.bbox.maxY - p.bbox.minY).toBeLessThanOrEqual(240);
      // Each shell (base plate, each wall) must be closed on its own.
      for (const shell of [p.base, ...p.walls]) {
        const t = prism(shell, 0, 5);
        expect(isWatertight(t)).toBe(true);
        expect(meshVolume(t)).toBeGreaterThan(0);
      }
      const tris = pieceMesh(p, d.params);
      expect(toBinaryStl(tris).byteLength).toBe(84 + (tris.length / 9) * 50);
    }
  });
});
