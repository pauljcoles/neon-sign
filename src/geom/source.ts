// Turns text (via opentype.js) or SVG markup into flat outline items in "layout units" (y down).
import type { Font, PathCommand } from 'opentype.js';
import type { FillRule, Polyline, Pt, Ring } from './clip';

/** One draggable thing in the design: a glyph or an SVG shape. */
export interface SourceItem {
  label: string;
  rings: Ring[];
  fill: FillRule;
  /** Word and line the item belongs to, so whole words or lines can be dragged together. */
  word: number;
  line: number;
  /** Stroked (unfilled) SVG paths: already a centre line. `strokeWidth` is in layout units. */
  lines?: Polyline[];
  strokeWidth?: number;
}

export interface Source { items: SourceItem[] }

/** Layout font size; outlines are later scaled to the requested width, so this only affects curve resolution. */
export const LAYOUT_SIZE = 100;

export interface TextOptions {
  /** Extra space between letters as a fraction of the font size; negative values make letters overlap. */
  letterSpacing: number;
  /** Line pitch as a multiple of the font size. */
  lineHeight: number;
  kerning: boolean;
}

export function textSource(font: Font, text: string, opts: TextOptions): Source {
  const items: SourceItem[] = [];
  const lines = text.split(/\r?\n/);
  let word = 0;
  lines.forEach((line, li) => {
    const chars = [...line];
    let ci = 0;
    word++;
    font.forEachGlyph(line, 0, li * opts.lineHeight * LAYOUT_SIZE, LAYOUT_SIZE,
      { kerning: opts.kerning, letterSpacing: opts.letterSpacing },
      (glyph, x, y, size) => {
        const { rings, lines } = splitStrokes(flattenCommands(glyph.getPath(x, y, size).commands, 0.35));
        const label = glyph.unicode ? String.fromCodePoint(glyph.unicode) : chars[ci] ?? '?';
        ci++;
        if (lines.length) items.push({ label, rings, fill: 'nonzero', word, line: li, lines, strokeWidth: LAYOUT_SIZE * 0.06 });
        else if (rings.length) items.push({ label, rings, fill: 'nonzero', word, line: li });
        else if (/\s/.test(label)) word++;
      });
  });
  return { items };
}

/**
 * Single-line fonts (such as Relief SingleLine) can only store closed outlines, so each stroke is drawn out and
 * back along itself and encloses no area. Those outlines are turned back into open centre lines: the first half
 * of the way round is the stroke. Ordinary outlines are returned unchanged.
 */
export function splitStrokes(rings: Ring[]): { rings: Ring[]; lines: Polyline[] } {
  const out: { rings: Ring[]; lines: Polyline[] } = { rings: [], lines: [] };
  for (const r of rings) {
    let perim = 0, area2 = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
      area2 += a[0] * b[1] - b[0] * a[1];
    }
    // A real outline of a stroke w wide has area of about w × perimeter / 2.
    if (perim === 0 || Math.abs(area2 / 2) > 0.002 * perim * LAYOUT_SIZE) { out.rings.push(r); continue; }
    const pts: Pt[] = [r[0]];
    let walked = 0;
    for (let i = 1; i <= r.length; i++) {
      const a = r[i - 1], b = r[i % r.length];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (walked + seg >= perim / 2) {
        const t = seg > 0 ? (perim / 2 - walked) / seg : 0;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        break;
      }
      walked += seg;
      pts.push(b);
    }
    if (pts.length >= 2) out.lines.push({ pts, closed: false });
  }
  return out;
}

/** Converts path commands to closed polylines. `seg` is the target segment length in the commands' units. */
export function flattenCommands(cmds: PathCommand[], seg: number): Ring[] {
  return flattenSubpaths(cmds, seg).filter((l) => l.pts.length >= 3).map((l) => l.pts);
}

/** Like `flattenCommands`, but keeps track of which subpaths were closed with Z (for stroked lines). */
export function flattenSubpaths(cmds: PathCommand[], seg: number): Polyline[] {
  const out: Polyline[] = [];
  let cur: Pt[] = [];
  let px = 0, py = 0, sx = 0, sy = 0;
  const finish = (closed: boolean) => {
    if (cur.length > 1) {
      const a = cur[0], b = cur[cur.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) { cur.pop(); closed = true; }
    }
    if (cur.length >= 2) out.push({ pts: cur, closed });
    cur = [];
  };
  const close = () => finish(false);
  const steps = (len: number) => Math.max(2, Math.min(64, Math.ceil(len / seg)));
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        close();
        px = sx = c.x!; py = sy = c.y!;
        cur.push([px, py]);
        break;
      case 'L':
        px = c.x!; py = c.y!;
        cur.push([px, py]);
        break;
      case 'Q': {
        const n = steps(Math.hypot(c.x1! - px, c.y1! - py) + Math.hypot(c.x! - c.x1!, c.y! - c.y1!));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          cur.push([u * u * px + 2 * u * t * c.x1! + t * t * c.x!, u * u * py + 2 * u * t * c.y1! + t * t * c.y!]);
        }
        px = c.x!; py = c.y!;
        break;
      }
      case 'C': {
        const n = steps(Math.hypot(c.x1! - px, c.y1! - py) + Math.hypot(c.x2! - c.x1!, c.y2! - c.y1!) + Math.hypot(c.x! - c.x2!, c.y! - c.y2!));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
          cur.push([a * px + b * c.x1! + d * c.x2! + e * c.x!, a * py + b * c.y1! + d * c.y2! + e * c.y!]);
        }
        px = c.x!; py = c.y!;
        break;
      }
      case 'Z':
        finish(true);
        px = sx; py = sy;
        break;
    }
  }
  close();
  return out;
}

// ---------------------------------------------------------------------------
// SVG import

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Parses SVG markup into source items. Filled shapes become outlines; shapes with `fill="none"` and a stroke
 * become centre lines (best with single-line mode). Transforms are honoured.
 */
export function svgSource(markup: string): Source {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') throw new Error('Not an SVG file');
  const shapes: { label: string; cmds: PathCommand[]; fill: FillRule; stroke?: number }[] = [];
  const visit = (el: Element, m: Matrix, inheritedRule: FillRule, inheritedPaint: Paint) => {
    const tag = el.localName;
    if (['defs', 'clipPath', 'mask', 'symbol', 'style', 'title', 'metadata'].includes(tag)) return;
    const mm = mul(m, parseTransform(el.getAttribute('transform') ?? ''));
    const ruleAttr = el.getAttribute('fill-rule') ?? styleProp(el, 'fill-rule');
    const rule: FillRule = ruleAttr === 'evenodd' ? 'evenodd' : ruleAttr === 'nonzero' ? 'nonzero' : inheritedRule;
    const paint = paintOf(el, inheritedPaint);
    const d = shapeToPath(el);
    // Affine transforms map Bézier curves to Bézier curves, so transform the control points before flattening.
    if (d && (paint.fill || paint.stroke)) {
      shapes.push({
        label: el.getAttribute('id') ?? tag,
        cmds: parsePathData(d).map((c) => transformCommand(c, mm)),
        fill: rule,
        stroke: paint.fill ? undefined : paint.strokeWidth * Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])),
      });
    }
    for (const child of Array.from(el.children)) visit(child, mm, rule, paint);
  };
  visit(root, IDENTITY, 'nonzero', { fill: true, stroke: false, strokeWidth: 1 });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) for (const c of s.cmds) if (c.x !== undefined) {
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y!); maxY = Math.max(maxY, c.y!);
  }
  const seg = Math.max(Math.hypot(maxX - minX, maxY - minY) / 1500, 1e-6);
  const items: SourceItem[] = shapes
    .map((s, i): SourceItem => s.stroke === undefined
      ? { label: s.label, rings: flattenCommands(s.cmds, seg), fill: s.fill, word: i, line: 0 }
      : { label: s.label, rings: [], fill: 'nonzero', word: i, line: 0, lines: flattenSubpaths(s.cmds, seg), strokeWidth: s.stroke })
    .filter((s) => s.rings.length || s.lines?.length);
  if (!items.length) throw new Error('No shapes found in the SVG');
  return { items };
}

interface Paint { fill: boolean; stroke: boolean; strokeWidth: number }

/** Whether a shape is filled or only stroked, following SVG inheritance (fill defaults to black, stroke to none). */
function paintOf(el: Element, parent: Paint): Paint {
  const fill = el.getAttribute('fill') ?? styleProp(el, 'fill');
  const stroke = el.getAttribute('stroke') ?? styleProp(el, 'stroke');
  const sw = el.getAttribute('stroke-width') ?? styleProp(el, 'stroke-width');
  const w = sw === null ? NaN : parseFloat(sw);
  return {
    fill: fill === null ? parent.fill : fill !== 'none' && fill !== 'transparent',
    stroke: stroke === null ? parent.stroke : stroke !== 'none' && stroke !== 'transparent',
    strokeWidth: w > 0 ? w : parent.strokeWidth,
  };
}

function transformCommand(c: PathCommand, m: Matrix): PathCommand {
  const t = (x?: number, y?: number) =>
    x === undefined || y === undefined ? [undefined, undefined] : [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const [x, y] = t(c.x, c.y), [x1, y1] = t(c.x1, c.y1), [x2, y2] = t(c.x2, c.y2);
  return { type: c.type, x, y, x1, y1, x2, y2 };
}

function styleProp(el: Element, name: string): string | null {
  const style = el.getAttribute('style');
  if (!style) return null;
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
  return m ? m[1].trim() : null;
}

function num(el: Element, name: string): number {
  return parseFloat(el.getAttribute(name) ?? '0') || 0;
}

function shapeToPath(el: Element): string | null {
  switch (el.localName) {
    case 'path': return el.getAttribute('d');
    case 'rect': {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      return w > 0 && h > 0 ? `M${x} ${y}H${x + w}V${y + h}H${x}Z` : null;
    }
    case 'circle': case 'ellipse': {
      const cx = num(el, 'cx'), cy = num(el, 'cy');
      const rx = el.localName === 'circle' ? num(el, 'r') : num(el, 'rx');
      const ry = el.localName === 'circle' ? rx : num(el, 'ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'polygon': case 'polyline': {
      const pts = el.getAttribute('points')?.trim();
      return pts ? `M${pts}${el.localName === 'polygon' ? 'Z' : ''}` : null;
    }
    case 'line':
      return `M${num(el, 'x1')} ${num(el, 'y1')}L${num(el, 'x2')} ${num(el, 'y2')}`;
    default: return null;
  }
}

function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function parseTransform(t: string): Matrix {
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(t))) {
    const v = (r[2].match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    let n: Matrix = IDENTITY;
    switch (r[1]) {
      case 'matrix': if (v.length === 6) n = v as Matrix; break;
      case 'translate': n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
      case 'scale': n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const cx = v[1] ?? 0, cy = v[2] ?? 0;
        n = mul(mul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX': n = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

/** Parses SVG path data into absolute M/L/C/Q/Z commands (arcs become cubics). */
export function parsePathData(d: string): PathCommand[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: PathCommand[] = [];
  let i = 0, cmd = '';
  let x = 0, y = 0, sx = 0, sy = 0;
  let lcx = 0, lcy = 0, lastType = '';
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);
  const n = () => parseFloat(tokens[i++]);
  const flag = () => {
    // Arc flags may be written without separators ("a10 10 0 01 5 5").
    const t = tokens[i];
    if (t.length > 1 && (t[0] === '0' || t[0] === '1')) { tokens[i] = t.slice(1); return t[0] === '1'; }
    i++;
    return t === '1';
  };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + n(); y = oy + n(); sx = x; sy = y;
        out.push({ type: 'M', x, y });
        cmd = rel ? 'l' : 'L';
        lastType = 'M';
        break;
      case 'L': x = ox + n(); y = oy + n(); out.push({ type: 'L', x, y }); lastType = 'L'; break;
      case 'H': x = ox + n(); out.push({ type: 'L', x, y }); lastType = 'L'; break;
      case 'V': y = oy + n(); out.push({ type: 'L', x, y }); lastType = 'L'; break;
      case 'C': {
        const x1 = ox + n(), y1 = oy + n(), x2 = ox + n(), y2 = oy + n();
        x = ox + n(); y = oy + n();
        out.push({ type: 'C', x1, y1, x2, y2, x, y });
        lcx = x2; lcy = y2; lastType = 'C';
        break;
      }
      case 'S': {
        const x1 = lastType === 'C' ? 2 * x - lcx : x, y1 = lastType === 'C' ? 2 * y - lcy : y;
        const x2 = ox + n(), y2 = oy + n();
        x = ox + n(); y = oy + n();
        out.push({ type: 'C', x1, y1, x2, y2, x, y });
        lcx = x2; lcy = y2; lastType = 'C';
        break;
      }
      case 'Q': {
        const x1 = ox + n(), y1 = oy + n();
        x = ox + n(); y = oy + n();
        out.push({ type: 'Q', x1, y1, x, y });
        lcx = x1; lcy = y1; lastType = 'Q';
        break;
      }
      case 'T': {
        const x1 = lastType === 'Q' ? 2 * x - lcx : x, y1 = lastType === 'Q' ? 2 * y - lcy : y;
        x = ox + n(); y = oy + n();
        out.push({ type: 'Q', x1, y1, x, y });
        lcx = x1; lcy = y1; lastType = 'Q';
        break;
      }
      case 'A': {
        const rx = n(), ry = n(), rot = n(), large = flag(), sweep = flag();
        const ex = ox + n(), ey = oy + n();
        out.push(...arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey));
        x = ex; y = ey; lastType = 'A';
        break;
      }
      case 'Z':
        out.push({ type: 'Z' });
        x = sx; y = sy; lastType = 'Z';
        break;
      default:
        i++;
    }
  }
  return out;
}

function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): PathCommand[] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ type: 'L', x: x2, y: y2 }];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cxp = (k * rx * yp) / ry, cyp = (-k * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const out: PathCommand[] = [];
  const delta = dt / segs;
  const kk = (4 / 3) * Math.tan(delta / 4);
  const pt = (t: number): Pt => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const dpt = (t: number): Pt => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  for (let s = 0; s < segs; s++) {
    const a = t1 + s * delta, b = a + delta;
    const p0 = pt(a), p3 = pt(b), d0 = dpt(a), d3 = dpt(b);
    out.push({ type: 'C', x1: p0[0] + kk * d0[0], y1: p0[1] + kk * d0[1], x2: p3[0] - kk * d3[0], y2: p3[1] - kk * d3[1], x: p3[0], y: p3[1] });
  }
  return out;
}
