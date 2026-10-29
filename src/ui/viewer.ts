// Canvas preview: pan/zoom, layers, glow mode and letter dragging.
import { type Paths, type Polyline, pointInPaths } from '../geom/clip';
import type { Design } from '../geom/design';
import { pieceHue } from '../export/files';

export type Layer = 'pieces' | 'walls' | 'bridges' | 'neon' | 'cuts' | 'tight';
export type Mode = 'layout' | 'glow';

interface Cache {
  pieces: Path2D[];
  walls: Path2D;
  bridges: Path2D;
  neon: Path2D;
  base: Path2D;
  tabs: Path2D;
  items: Path2D[];
}

const pathOf = (p: Paths) => {
  const path = new Path2D();
  for (const r of p) {
    if (!r.length) continue;
    path.moveTo(r[0][0], r[0][1]);
    for (let i = 1; i < r.length; i++) path.lineTo(r[i][0], r[i][1]);
    path.closePath();
  }
  return path;
};

const linesOf = (lines: Polyline[]) => {
  const path = new Path2D();
  for (const l of lines) {
    if (l.pts.length < 2) continue;
    path.moveTo(l.pts[0][0], l.pts[0][1]);
    for (let i = 1; i < l.pts.length; i++) path.lineTo(l.pts[i][0], l.pts[i][1]);
    if (l.closed) path.closePath();
  }
  return path;
};

export class Viewer {
  design: Design | null = null;
  layers = new Set<Layer>(['pieces', 'walls', 'bridges', 'neon', 'cuts', 'tight']);
  mode: Mode = 'layout';
  glow = '#ff3d9a';
  /** Which items move together when `index` is grabbed (a letter, its word or its line). */
  groupOf: (index: number) => number[] = (i) => [i];
  /** Called while dragging and once at the end, with the total offset in mm (y up). */
  onDragMove: (items: number[], dx: number, dy: number) => void = () => {};
  onNudge: (items: number[], dx: number, dy: number) => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private cache: Cache | null = null;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private fitted = false;
  private fitBounds: Design['bounds'] | null = null;
  private drag: { kind: 'pan' | 'item'; x: number; y: number; group: number[]; dx: number; dy: number } | null = null;
  /** Drag offset already baked into the current design (from a live rebuild), so the overlay shows only the rest. */
  private liveDelta = { dx: 0, dy: 0 };
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', () => { this.drag = null; this.draw(); });
  }

  setDesign(d: Design | null, liveDelta = { dx: 0, dy: 0 }, keepView = false) {
    this.design = d;
    this.liveDelta = liveDelta;
    this.cache = d ? {
      pieces: d.pieces.map((p) => pathOf([p.base.outer, ...p.base.holes])),
      walls: pathOf(d.walls),
      bridges: pathOf(d.bridges),
      neon: linesOf(d.neon),
      base: pathOf(d.base),
      tabs: pathOf(d.split.tabs),
      items: d.items.map((i) => pathOf(i.fill)),
    } : null;
    if (this.drag || keepView) { this.draw(); return; }
    // Refit when the design changes size a lot (new text, new width), but not for small edits like nudges.
    const fb = this.fitBounds;
    const b = d?.bounds;
    const moved = !!b && !!fb && Math.abs((b.maxX - b.minX) - (fb.maxX - fb.minX)) + Math.abs((b.maxY - b.minY) - (fb.maxY - fb.minY)) > 0.15 * (fb.maxX - fb.minX);
    if (d && (!this.fitted || moved)) this.fit();
    this.draw();
  }

  fit() {
    const d = this.design;
    if (!d) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const b = d.bounds;
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    this.scale = Math.min((w - 60) / bw, (h - 90) / bh);
    this.ox = w / 2 - ((b.minX + b.maxX) / 2) * this.scale;
    this.oy = h / 2 + ((b.minY + b.maxY) / 2) * this.scale;
    this.fitted = true;
    this.fitBounds = b;
    this.draw();
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * this.dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * this.dpr);
    if (!this.fitted) this.fit();
    this.draw();
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.ox) / this.scale, (this.oy - sy) / this.scale];
  }

  private local(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const [sx, sy] = this.local(e);
    const f = Math.exp(-e.deltaY * 0.0015);
    this.ox = sx - (sx - this.ox) * f;
    this.oy = sy - (sy - this.oy) * f;
    this.scale *= f;
    this.draw();
  }

  private down(e: PointerEvent) {
    const [sx, sy] = this.local(e);
    const [wx, wy] = this.toWorld(sx, sy);
    let index = -1;
    if (e.button === 0 && this.design) {
      for (let i = this.design.items.length - 1; i >= 0; i--) {
        if (pointInPaths(this.design.items[i].fill, wx, wy)) { index = i; break; }
      }
    }
    this.drag = { kind: index >= 0 ? 'item' : 'pan', x: sx, y: sy, group: index >= 0 ? this.groupOf(index) : [], dx: 0, dy: 0 };
    this.liveDelta = { dx: 0, dy: 0 };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = index >= 0 ? 'move' : 'grabbing';
  }

  private move(e: PointerEvent) {
    const [sx, sy] = this.local(e);
    if (!this.drag) {
      if (this.design) {
        const [wx, wy] = this.toWorld(sx, sy);
        const over = this.design.items.some((i) => pointInPaths(i.fill, wx, wy));
        this.canvas.style.cursor = over ? 'move' : 'grab';
      }
      return;
    }
    const ddx = sx - this.drag.x, ddy = sy - this.drag.y;
    this.drag.x = sx;
    this.drag.y = sy;
    if (this.drag.kind === 'pan') {
      this.ox += ddx;
      this.oy += ddy;
    } else {
      this.drag.dx += ddx / this.scale;
      this.drag.dy -= ddy / this.scale;
      this.onDragMove(this.drag.group, this.drag.dx, this.drag.dy);
    }
    this.draw();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    this.canvas.releasePointerCapture(e.pointerId);
    this.canvas.style.cursor = 'grab';
    if (d?.kind === 'item' && (Math.abs(d.dx) > 0.2 || Math.abs(d.dy) > 0.2)) this.onNudge(d.group, d.dx, d.dy);
    this.draw();
  }

  draw() {
    const { ctx, canvas, dpr } = this;
    const glow = this.mode === 'glow';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = glow ? '#06060b' : getComputedStyle(canvas).getPropertyValue('--canvas-bg') || '#f4f4f7';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const d = this.design, c = this.cache;
    if (!d || !c) return;
    const s = this.scale;
    const world = () => ctx.setTransform(s * dpr, 0, 0, -s * dpr, this.ox * dpr, this.oy * dpr);
    world();
    const px = 1 / s;

    if (glow) {
      ctx.fillStyle = '#16161e';
      ctx.fill(c.base, 'nonzero');
      ctx.fillStyle = '#23232d';
      ctx.fill(c.walls, 'nonzero');
      const w = d.params.stripWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const [blur, alpha, width] of [[40, 0.55, w * 1.6], [16, 0.8, w], [4, 1, w * 0.7]] as const) {
        ctx.save();
        ctx.shadowColor = this.glow;
        ctx.shadowBlur = blur * dpr * Math.min(2, Math.max(0.4, s));
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = this.glow;
        ctx.lineWidth = width;
        ctx.stroke(c.neon);
        ctx.restore();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = w * 0.25;
      ctx.stroke(c.neon);
      return;
    }

    if (this.layers.has('pieces') && !c.pieces.length) {
      // Live preview while dragging: not split into pieces yet.
      ctx.fillStyle = '#d9dbe6';
      ctx.fill(c.base, 'nonzero');
      ctx.strokeStyle = '#8a8fa8';
      ctx.lineWidth = px;
      ctx.stroke(c.base);
    } else if (this.layers.has('pieces')) {
      c.pieces.forEach((p, i) => {
        ctx.fillStyle = `hsl(${pieceHue(i)} 70% 82%)`;
        ctx.fill(p, 'evenodd');
        ctx.strokeStyle = `hsl(${pieceHue(i)} 55% 38%)`;
        ctx.lineWidth = 1 * px;
        ctx.stroke(p);
      });
    } else {
      ctx.strokeStyle = '#8888';
      ctx.lineWidth = px;
      ctx.stroke(c.base);
    }
    if (this.layers.has('bridges') && d.bridges.length) {
      ctx.fillStyle = 'rgba(255,150,30,0.45)';
      ctx.fill(c.bridges, 'nonzero');
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.strokeStyle = '#d9730d';
      ctx.lineWidth = 1.2 * px;
      ctx.stroke(c.bridges);
      ctx.setLineDash([]);
    }
    if (this.layers.has('walls')) {
      ctx.fillStyle = 'rgba(30,30,50,0.55)';
      ctx.fill(c.walls, 'nonzero');
    }
    if (this.layers.has('neon')) {
      ctx.strokeStyle = this.glow;
      ctx.lineWidth = Math.max(1.5 * px, d.params.stripWidth * 0.35);
      ctx.lineJoin = 'round';
      ctx.stroke(c.neon);
    }
    if (this.layers.has('cuts')) {
      const b = d.bounds;
      ctx.strokeStyle = '#e02424';
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.beginPath();
      for (const x of d.split.xCuts) { ctx.moveTo(x, b.minY - 15); ctx.lineTo(x, b.maxY + 15); }
      for (const y of d.split.yCuts) { ctx.moveTo(b.minX - 15, y); ctx.lineTo(b.maxX + 15, y); }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#a00';
      ctx.lineWidth = 1.2 * px;
      ctx.stroke(c.tabs);
    }
    if (this.layers.has('tight')) {
      ctx.strokeStyle = '#ff1f1f';
      ctx.lineWidth = 2 * px;
      for (const [x, y] of d.tight) {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(4, 8 * px), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (this.drag?.kind === 'item') {
      ctx.save();
      ctx.translate(this.drag.dx - this.liveDelta.dx, this.drag.dy - this.liveDelta.dy);
      ctx.fillStyle = 'rgba(80,90,255,0.3)';
      ctx.strokeStyle = '#3b48ff';
      ctx.lineWidth = 1.5 * px;
      for (const i of this.drag.group) {
        if (!c.items[i]) continue;
        ctx.fill(c.items[i], 'nonzero');
        ctx.stroke(c.items[i]);
      }
      ctx.restore();
    }

    // Labels in screen space.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.layers.has('pieces')) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of d.pieces) {
        const x = this.ox + ((p.bbox.minX + p.bbox.maxX) / 2) * s;
        const y = this.oy - p.bbox.maxY * s - 12;
        ctx.fillStyle = '#222';
        ctx.fillText(p.id, x, y);
      }
    }
    this.scaleBar();
  }

  private scaleBar() {
    const { ctx } = this;
    const h = this.canvas.clientHeight;
    const target = 120 / this.scale;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].find((n) => n >= target) ?? 5000;
    const len = nice * this.scale;
    ctx.strokeStyle = '#555';
    ctx.fillStyle = '#555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, h - 16);
    ctx.lineTo(16 + len, h - 16);
    ctx.stroke();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} m` : `${nice} mm`, 16, h - 20);
  }
}
