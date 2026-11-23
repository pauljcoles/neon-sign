import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { bedRegion, buildDesign, defaultParams, type Params } from '../src/geom/design';
import { textSource } from '../src/geom/source';
import { buildZip } from '../src/export/files';
import { pieceMesh } from '../src/export/mesh';
import { build3mf, packPlates } from '../src/export/threemf';

const font = (name: string) => {
  const b = readFileSync(new URL(`../public/fonts/${name}`, import.meta.url));
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const src = textSource(font('Pacifico-Regular.ttf'), 'Good Vibes\nOnly', { letterSpacing: 0, lineHeight: 1.1, kerning: true });
/** Settings the sign maker applies for a P1S: 256 mm bed, 8 mm margin, front 28 mm unusable. */
const p1s: Partial<Params> = { width: 900, bedFrontExclude: 28, maxPiece: 220 };

const read3mf = async (d: NonNullable<ReturnType<typeof buildDesign>>) => {
  const zip = await JSZip.loadAsync(await (await build3mf(d, 'Test')).arrayBuffer());
  const xml = await zip.file('3D/3dmodel.model')!.async('string');
  const objects = [...xml.matchAll(/<object id="(\d+)" name="([^"]*)"[^>]*><mesh><vertices>(.*?)<\/vertices><triangles>(.*?)<\/triangles>/g)].map((m) => ({
    id: Number(m[1]), name: m[2],
    verts: [...m[3].matchAll(/x="([-\d.e]+)" y="([-\d.e]+)" z="([-\d.e]+)"/g)].map((v) => [Number(v[1]), Number(v[2]), Number(v[3])]),
    tris: [...m[4].matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map((t) => [Number(t[1]), Number(t[2]), Number(t[3])]),
  }));
  const items = [...xml.matchAll(/<item objectid="(\d+)" transform="([^"]*)"/g)].map((m) => ({ id: Number(m[1]), t: m[2].split(' ').map(Number) }));
  return { zip, xml, objects, items };
};

describe('bed region', () => {
  it('keeps clear of the margin and the front strip', () => {
    expect(bedRegion({ bedSize: 256, bedMargin: 8, bedFrontExclude: 0 })).toMatchObject({ x0: 8, y0: 8, x1: 248, y1: 248, w: 240, h: 240 });
    expect(bedRegion({ bedSize: 256, bedMargin: 8, bedFrontExclude: 28 })).toMatchObject({ x0: 8, y0: 28, x1: 248, y1: 248, w: 240, h: 220 });
  });
});

describe('plate packing', () => {
  const region = { x0: 8, y0: 28, w: 240, h: 220 };
  const sizes = [{ w: 219, h: 185 }, { w: 146, h: 205 }, { w: 110, h: 101 }, { w: 97, h: 50 }, { w: 60, h: 30 }, { w: 34, h: 8 }, { w: 220, h: 220 }];
  const spots = packPlates(sizes, region, 6);

  it('keeps every piece inside the region of its plate', () => {
    spots.forEach((s, i) => {
      expect(s.x - sizes[i].w / 2).toBeGreaterThanOrEqual(region.x0 - 1e-6);
      expect(s.x + sizes[i].w / 2).toBeLessThanOrEqual(region.x0 + region.w + 1e-6);
      expect(s.y - sizes[i].h / 2).toBeGreaterThanOrEqual(region.y0 - 1e-6);
      expect(s.y + sizes[i].h / 2).toBeLessThanOrEqual(region.y0 + region.h + 1e-6);
    });
  });

  it('never overlaps two pieces on one plate, and shares plates where it can', () => {
    for (let a = 0; a < sizes.length; a++) for (let b = a + 1; b < sizes.length; b++) {
      if (spots[a].plate !== spots[b].plate) continue;
      const apart = Math.abs(spots[a].x - spots[b].x) >= (sizes[a].w + sizes[b].w) / 2 || Math.abs(spots[a].y - spots[b].y) >= (sizes[a].h + sizes[b].h) / 2;
      expect(apart).toBe(true);
    }
    expect(new Set(spots.map((s) => s.plate)).size).toBeLessThan(sizes.length);
  });

  it('puts a piece bigger than the region on its own plate', () => {
    const [big] = packPlates([{ w: 300, h: 100 }, { w: 20, h: 20 }], region, 6);
    const all = packPlates([{ w: 300, h: 100 }, { w: 20, h: 20 }], region, 6);
    expect(big.plate).not.toBe(all[1].plate);
  });
});

describe('3MF export', () => {
  it('holds every piece and the fit test as valid meshes inside the usable bed on a P1S', async () => {
    const d = buildDesign(src, { ...defaultParams, ...p1s })!;
    const r = bedRegion(d.params);
    const { objects, items, xml } = await read3mf(d);
    expect(xml).toContain('unit="millimeter"');
    expect(objects.map((o) => o.name)).toEqual([...d.pieces.map((p) => p.id), 'fit-test']);
    expect(items).toHaveLength(objects.length);
    for (const o of objects) {
      expect(o.verts.length).toBeGreaterThan(0);
      expect(o.tris.length).toBeGreaterThan(0);
      for (const t of o.tris) for (const k of t) expect(k).toBeLessThan(o.verts.length);
      const it = items.find((i) => i.id === o.id)!;
      const plate = Math.round(it.t[9] / (1.2 * d.params.bedSize));
      const xs = o.verts.map((v) => v[0] + it.t[9] - plate * 1.2 * d.params.bedSize);
      const ys = o.verts.map((v) => v[1] + it.t[10]);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(r.y0 - 0.01);
      expect(Math.max(...ys)).toBeLessThanOrEqual(r.y1 + 0.01);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(r.x0 - 0.01);
      expect(Math.max(...xs)).toBeLessThanOrEqual(r.x1 + 0.01);
      expect(Math.min(...o.verts.map((v) => v[2]))).toBeCloseTo(0, 6);
    }
  });

  it('is in the ZIP too', async () => {
    const d = buildDesign(src, { ...defaultParams, ...p1s })!;
    const zip = await JSZip.loadAsync(await (await buildZip(d, 'Test', {})).arrayBuffer());
    expect(zip.file('project.3mf')).not.toBeNull();
  });
});

describe('P1S pieces', () => {
  it('fit in the 220 mm square the printer can use, with their lugs', () => {
    const d = buildDesign(src, { ...defaultParams, ...p1s })!;
    const r = bedRegion(d.params);
    expect(d.warnings.filter((w) => /printer can use/.test(w))).toEqual([]);
    for (const p of d.pieces) {
      expect(p.bbox.maxX - p.bbox.minX).toBeLessThanOrEqual(r.w + 0.01);
      expect(p.bbox.maxY - p.bbox.minY).toBeLessThanOrEqual(r.h + 0.01);
      // As exported, the piece sits clear of the unprintable front strip and the margin.
      const m = pieceMesh(p, d.params);
      const ys = m.filter((_, k) => k % 3 === 1), xs = m.filter((_, k) => k % 3 === 0);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(r.y0 - 0.01);
      expect(Math.max(...ys)).toBeLessThanOrEqual(r.y1 + 0.01);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(r.x0 - 0.01);
      expect(Math.max(...xs)).toBeLessThanOrEqual(r.x1 + 0.01);
    }
  });

  it('warns when the max piece size does not fit the usable area', () => {
    const d = buildDesign(src, { ...defaultParams, width: 900, bedFrontExclude: 28, maxPiece: 240 })!;
    expect(d.warnings.some((w) => /printer can use/.test(w))).toBe(true);
  });
});
