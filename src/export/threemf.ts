// 3MF export: every piece (and the fit test piece) in one file, arranged on the bed.
import JSZip from 'jszip';
import { bedRegion, type Design } from '../geom/design';
import { fitTestPiece } from '../geom/fittings';
import { pieceShells, type Tris } from './mesh';

export interface Placement { plate: number; /** centre of the item on its plate, mm */ x: number; y: number }

/**
 * Shelf-packs rectangles onto as many identical plates as needed, inside `region` (the usable part of each plate)
 * with `gap` between neighbours. Anything larger than the region goes on a plate of its own, centred on it.
 */
export function packPlates(sizes: { w: number; h: number }[], region: { x0: number; y0: number; w: number; h: number }, gap: number): Placement[] {
  const out: Placement[] = new Array(sizes.length);
  const plates: { rows: { y: number; h: number; x: number }[]; y: number }[] = [];
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w);
  for (const i of order) {
    const { w, h } = sizes[i];
    if (w > region.w || h > region.h) {
      plates.push({ rows: [], y: region.h });
      out[i] = { plate: plates.length - 1, x: region.x0 + region.w / 2, y: region.y0 + region.h / 2 };
      continue;
    }
    let done = false;
    for (let p = 0; p < plates.length && !done; p++) {
      const plate = plates[p];
      const row = plate.rows.find((r) => r.h >= h && r.x + w <= region.w);
      if (row) {
        out[i] = { plate: p, x: region.x0 + row.x + w / 2, y: region.y0 + row.y + h / 2 };
        row.x += w + gap;
        done = true;
      } else if (plate.y + h <= region.h) {
        plate.rows.push({ y: plate.y, h, x: w + gap });
        out[i] = { plate: p, x: region.x0 + w / 2, y: region.y0 + plate.y + h / 2 };
        plate.y += h + gap;
        done = true;
      }
    }
    if (!done) {
      plates.push({ rows: [{ y: 0, h, x: w + gap }], y: h + gap });
      out[i] = { plate: plates.length - 1, x: region.x0 + w / 2, y: region.y0 + h / 2 };
    }
  }
  return out;
}

const num = (n: number) => String(Math.round(n * 10000) / 10000);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * An indexed mesh from closed shells. Vertices are shared inside a shell but never between shells: base plate and
 * walls overlap, and merging their vertices would make edges that belong to four triangles.
 */
function indexed(shells: Tris[]): { vertices: string; triangles: string } {
  const v: string[] = [];
  const t: string[] = [];
  for (const tris of shells) {
    const ids = new Map<string, number>();
    const at = (k: number) => {
      const x = num(tris[k]), y = num(tris[k + 1]), z = num(tris[k + 2]);
      const key = `${x} ${y} ${z}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = v.length;
        ids.set(key, id);
        v.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
      }
      return id;
    };
    for (let k = 0; k < tris.length; k += 9) {
      const a = at(k), b = at(k + 3), c = at(k + 6);
      if (a !== b && b !== c && a !== c) t.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
  }
  return { vertices: v.join(''), triangles: t.join('') };
}

/** Distance between plate origins in Bambu Studio's plate grid, as a multiple of the bed size. */
const PLATE_PITCH = 1.2;

export async function build3mf(d: Design, title: string): Promise<Blob> {
  const p = d.params;
  const items = [...d.pieces.map((pc) => ({ name: pc.id, piece: pc })), { name: 'fit-test', piece: fitTestPiece(p) }];
  const region = bedRegion(p);
  const spots = packPlates(items.map(({ piece }) => ({ w: piece.bbox.maxX - piece.bbox.minX, h: piece.bbox.maxY - piece.bbox.minY })), region, 6);
  const objects: string[] = [];
  const build: string[] = [];
  items.forEach(({ name, piece }, i) => {
    const m = indexed(pieceShells(piece, p));
    const id = i + 1;
    objects.push(`<object id="${id}" name="${esc(name)}" type="model"><mesh><vertices>${m.vertices}</vertices><triangles>${m.triangles}</triangles></mesh></object>`);
    // Meshes are centred on the middle of the usable region, so the move is relative to that.
    const s = spots[i];
    const tx = s.x - (region.x0 + region.x1) / 2 + s.plate * PLATE_PITCH * p.bedSize, ty = s.y - (region.y0 + region.y1) / 2;
    build.push(`<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${num(tx)} ${num(ty)} 0" printable="1"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">Glowline</metadata>
<resources>${objects.join('')}</resources>
<build>${build.join('')}</build>
</model>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`);
  zip.file('3D/3dmodel.model', model);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
