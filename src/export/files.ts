// 1:1 SVG template, assembly guide and the ZIP bundle.
import JSZip from 'jszip';
import type { Paths, Polyline, Ring } from '../geom/clip';
import type { Design } from '../geom/design';
import { fitTestPiece } from '../geom/fittings';
import { pieceMesh, toBinaryStl } from './mesh';

export const pieceHue = (i: number) => (i * 137.508) % 360;

const fmt = (n: number) => n.toFixed(2).replace(/\.?0+$/, '');

/** SVG at real size (mm). Model y points up, SVG y points down, so y is flipped around the design bounds. */
export function templateSvg(d: Design, opts: { labels?: boolean } = {}): string {
  const pad = 5;
  const b = d.bounds;
  const W = b.maxX - b.minX + 2 * pad, H = b.maxY - b.minY + 2 * pad;
  const tx = (x: number) => fmt(x - b.minX + pad);
  const ty = (y: number) => fmt(b.maxY - y + pad);
  const ring = (r: Ring) => `M${r.map(([x, y]) => `${tx(x)} ${ty(y)}`).join('L')}Z`;
  const paths = (p: Paths) => p.map(ring).join('');
  const line = (l: Polyline) => `M${l.pts.map(([x, y]) => `${tx(x)} ${ty(y)}`).join('L')}${l.closed ? 'Z' : ''}`;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W)}mm" height="${fmt(H)}mm" viewBox="0 0 ${fmt(W)} ${fmt(H)}">`);
  parts.push(`<title>Neon sign template, 1:1 scale</title>`);
  d.pieces.forEach((p, i) => {
    parts.push(`<path d="${paths([p.base.outer, ...p.base.holes])}" fill="hsl(${pieceHue(i)} 70% 85%)" fill-rule="evenodd" stroke="hsl(${pieceHue(i)} 60% 35%)" stroke-width="0.3"/>`);
  });
  parts.push(`<path d="${paths(d.walls)}" fill="#0003" fill-rule="nonzero" stroke="none"/>`);
  parts.push(`<path d="${d.neon.map(line).join('')}" fill="none" stroke="#e0218a" stroke-width="0.6" stroke-dasharray="3 1.5"/>`);
  for (const x of d.split.xCuts) parts.push(`<line x1="${tx(x)}" y1="0" x2="${tx(x)}" y2="${fmt(H)}" stroke="#d00" stroke-width="0.3" stroke-dasharray="2 2"/>`);
  for (const y of d.split.yCuts) parts.push(`<line x1="0" y1="${ty(y)}" x2="${fmt(W)}" y2="${ty(y)}" stroke="#d00" stroke-width="0.3" stroke-dasharray="2 2"/>`);
  if (opts.labels !== false) {
    for (const p of d.pieces) {
      const cx = (p.bbox.minX + p.bbox.maxX) / 2, cy = (p.bbox.minY + p.bbox.maxY) / 2;
      parts.push(`<text x="${tx(cx)}" y="${ty(cy)}" font-family="sans-serif" font-size="8" text-anchor="middle" dominant-baseline="middle" fill="#222">${p.id}</text>`);
    }
    parts.push(`<path d="M${fmt(pad)} ${fmt(H - 1.5)}h100" stroke="#000" stroke-width="0.5"/><text x="${fmt(pad)}" y="${fmt(H - 2.5)}" font-family="sans-serif" font-size="3">100 mm — check this measures 100 mm when printed</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function assemblyGuide(d: Design, title: string): string {
  const s = d.stats, p = d.params;
  const rows = d.pieces.map((pc) => `<tr><td>${pc.id}</td><td>${(pc.bbox.maxX - pc.bbox.minX).toFixed(0)} × ${(pc.bbox.maxY - pc.bbox.minY).toFixed(0)} mm</td><td>piece-${pc.id}.stl</td></tr>`).join('');
  const runs = d.neon.map((l, i) => {
    let len = 0;
    for (let k = 1; k < l.pts.length; k++) len += Math.hypot(l.pts[k][0] - l.pts[k - 1][0], l.pts[k][1] - l.pts[k - 1][1]);
    if (l.closed) len += Math.hypot(l.pts[0][0] - l.pts[l.pts.length - 1][0], l.pts[0][1] - l.pts[l.pts.length - 1][1]);
    return `<li>Run ${i + 1}: ${(len / 10).toFixed(1)} cm${l.closed ? ' (loop)' : ''}</li>`;
  }).join('');
  const warn = d.warnings.length ? `<h2>Check before printing</h2><ul>${d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — assembly guide</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px;text-align:left}svg{width:100%;height:auto;border:1px solid #ddd}</style>
</head><body>
<h1>${esc(title)}</h1>
<p>Lettering ${s.letterWidth.toFixed(0)} × ${s.letterHeight.toFixed(0)} mm · printed body ${s.printedWidth.toFixed(0)} × ${s.printedHeight.toFixed(0)} mm ·
${s.pieces} piece${s.pieces === 1 ? '' : 's'} · ${s.neonMetres.toFixed(2)} m of ${p.stripWidth} mm LED neon strip in ${s.neonRuns} run${s.neonRuns === 1 ? '' : 's'} · about ${s.filamentGrams.toFixed(0)} g of filament (solid).</p>
${templateSvg(d)}
${warn}
<h2>Print</h2>
<p>Print each STL flat side down. Settings that work well: 0.2 mm layers, 3 walls, 15% infill, no supports.
Channel width ${(p.stripWidth + p.channelClearance).toFixed(1)} mm, walls ${p.wallThickness} mm thick and ${p.wallHeight} mm tall on a ${p.baseThickness} mm base.</p>
<p>Print <b>pieces/fit-test.stl</b> first (about 10 minutes) and press a length of strip into it. It should go in with a firm push and stay put. If it is loose, lower the channel clearance; if it will not go in, raise it.</p>
<table><tr><th>Piece</th><th>Size</th><th>File</th></tr>${rows}</table>
<h2>Assemble</h2>
<ol>
<li>Lay the pieces out on the printed template (template.svg, print at 100% — the scale bar should measure 100 mm). Letters are columns A, B, C… from the left and rows 1, 2… from the top.</li>
<li>Slide the dovetail connectors together from above. They are sized with ${p.connectorClearance} mm clearance; sand lightly if tight.</li>
<li>Glue each joint (CA glue or a 2-part epoxy). Joints listed above as having no connector need extra glue or a strip glued across the back.</li>
<li>${d.cableHoles.length ? 'Feed the wire of each strip through the hole in the channel floor at the start of its run' : 'Drill a small hole for the feed wire at the start of each run'}, then press the neon strip into the channel. Neon strip bends best with a radius of ${p.minBendRadius} mm or more; at the red-marked spots, warm the strip gently or cut and rejoin it.</li>
<li>${d.mounts.length ? `Screw the sign to the wall or a backing board through the ${d.mounts.length} mounting holes (${p.screwHoleDiameter} mm, for ${Math.max(2, Math.floor(p.screwHoleDiameter - 0.5))} mm screws).` : 'Mount on a backing board or hang with wire through the bridges.'}</li>
</ol>
<h2>Neon runs</h2><ul>${runs}</ul>
</body></html>`;
}

export async function buildZip(d: Design, title: string, settings: unknown): Promise<Blob> {
  const zip = new JSZip();
  const folder = zip.folder('pieces')!;
  for (const p of d.pieces) folder.file(`piece-${p.id}.stl`, toBinaryStl(pieceMesh(p, d.params), `piece ${p.id}`));
  folder.file('fit-test.stl', toBinaryStl(pieceMesh(fitTestPiece(d.params), d.params), 'fit test'));
  zip.file('template.svg', templateSvg(d));
  zip.file('assembly-guide.html', assemblyGuide(d, title));
  zip.file('settings.json', JSON.stringify(settings, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
