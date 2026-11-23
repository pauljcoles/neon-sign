// Snapping a dragged group to other words and lines, so lines can be lined up by dragging.
import type { BBox } from '../geom/clip';

export interface Snap {
  dx: number;
  dy: number;
  /** Positions (mm) of the guide lines to draw: vertical ones at these x, horizontal ones at these y. */
  guides: { x: number[]; y: number[] };
}

const refsX = (b: BBox) => [b.minX, (b.minX + b.maxX) / 2, b.maxX];
const refsY = (b: BBox) => [b.minY, (b.minY + b.maxY) / 2, b.maxY];

/**
 * Moves the offset (dx, dy) of the box `start` so that its left, centre or right edge lands on the left, centre or
 * right edge of a target box when within `threshold` mm, and the same for bottom, middle and top. Each axis snaps
 * on its own, to the nearest match.
 */
export function snapOffset(start: BBox, targets: BBox[], dx: number, dy: number, threshold: number): Snap {
  const out: Snap = { dx, dy, guides: { x: [], y: [] } };
  const best = (own: number[], refs: number[][], d: number) => {
    let delta = Infinity, at = NaN;
    for (const o of own) for (const rs of refs) for (const r of rs) {
      const diff = r - (o + d);
      if (Math.abs(diff) < Math.abs(delta)) { delta = diff; at = r; }
    }
    return Math.abs(delta) <= threshold ? { delta, at } : null;
  };
  const sx = best(refsX(start), targets.map(refsX), dx);
  if (sx) { out.dx = dx + sx.delta; out.guides.x.push(sx.at); }
  const sy = best(refsY(start), targets.map(refsY), dy);
  if (sy) { out.dy = dy + sy.delta; out.guides.y.push(sy.at); }
  return out;
}
