import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { buildDesign, defaultParams } from '../src/geom/design';
import { textSource } from '../src/geom/source';
import { buildSheet, buildSheetHtml, defaultStrip } from '../src/export/buildsheet';
import { assemblyGuide } from '../src/export/files';

const font = (name: string) => {
  const b = readFileSync(new URL(`../public/fonts/${name}`, import.meta.url));
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const d = buildDesign(textSource(font('Pacifico-Regular.ttf'), 'Glow', { letterSpacing: 0, lineHeight: 1.1, kerning: true }), defaultParams)!;

describe('build sheet', () => {
  it('cuts each run at the last mark that fits', () => {
    const b = buildSheet(d, { ...defaultStrip, cutInterval: 25 });
    for (const r of b.runs) {
      expect(r.cut).toBeLessThanOrEqual(r.channel);
      expect(r.gap).toBeLessThan(25);
      expect(r.cut % 25).toBe(0);
    }
    expect(b.buyMetres).toBeGreaterThanOrEqual(b.stripMetres * 1.1 - 1e-9);
    expect(b.buyMetres * 2).toBe(Math.round(b.buyMetres * 2));
  });

  it('sizes the supply with headroom and halves the current at 24 V', () => {
    const b12 = buildSheet(d, { ...defaultStrip, voltage: 12, wattsPerMetre: 10 });
    const b24 = buildSheet(d, { ...defaultStrip, voltage: 24, wattsPerMetre: 10 });
    expect(b12.watts).toBeCloseTo(b12.stripMetres * 10, 6);
    expect(b12.psuWatts).toBeGreaterThanOrEqual(b12.watts * 1.2);
    expect(b24.amps).toBeCloseTo(b12.amps / 2, 6);
  });

  it('asks for feeding both ends on a very long run', () => {
    const big = buildDesign(textSource(font('Righteous-Regular.ttf'), 'O', { letterSpacing: 0, lineHeight: 1.1, kerning: true }), { ...defaultParams, width: 2500 }, {}, { split: false })!;
    expect(buildSheet(big, { ...defaultStrip, voltage: 12 }).feedBothEnds).toBe(true);
    expect(buildSheet(d, { ...defaultStrip, voltage: 12 }).feedBothEnds).toBe(false);
  });

  it('shows up in the app panel html and the assembly guide', () => {
    const html = buildSheetHtml(buildSheet(d, defaultStrip), defaultStrip);
    expect(html).toContain('Shopping list');
    expect(assemblyGuide(d, 'Glow')).toContain('Build sheet');
  });
});
