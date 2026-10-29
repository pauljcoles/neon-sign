// Runs the geometry pipeline off the main thread so the page stays responsive while dragging.
import { buildDesign, type Nudge, type Params } from './design';
import type { Source } from './source';

export interface BuildRequest {
  id: number;
  src: Source;
  params: Params;
  nudges: Record<number, Nudge>;
  split: boolean;
}

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const { id, src, params, nudges, split } = e.data;
  try {
    const t0 = performance.now();
    const design = buildDesign(src, params, nudges, { split });
    self.postMessage({ id, design, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
