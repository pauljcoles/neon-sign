// The practical numbers for building a design: strip to buy and cut, power, filament and a parts list.
// Everything here is an estimate from typical values; the strip's own spec sheet always wins.
import type { Design } from '../geom/design';

export interface StripSpec {
  /** Power draw of the strip, watts per metre (from its spec sheet). */
  wattsPerMetre: number;
  voltage: 12 | 24;
  /** Distance between the strip's cut marks, mm. */
  cutInterval: number;
}

export const defaultStrip: StripSpec = { wattsPerMetre: 10, voltage: 12, cutInterval: 25 };

/** Common sizes for plug-in and enclosed LED power supplies, in watts. */
const PSU_SIZES = [12, 18, 24, 36, 48, 60, 75, 100, 150, 200, 300, 400];

/** Rough copper size for short low-voltage DC leads (a few metres), by current. */
const WIRE = [
  { amps: 2, label: '0.35 mm² (22 AWG)' },
  { amps: 4, label: '0.5 mm² (20 AWG)' },
  { amps: 7, label: '0.75 mm² (18 AWG)' },
  { amps: 10, label: '1.5 mm² (16 AWG)' },
  { amps: 15, label: '2.5 mm² (14 AWG)' },
  { amps: Infinity, label: '4 mm² (12 AWG) or split the load across several feeds' },
];

export interface CutRun {
  /** Channel length of the run, mm. */
  channel: number;
  /** Strip to cut: the channel length rounded down to the last cut mark that fits, mm. */
  cut: number;
  /** Unlit gap left at the end of the run, mm. */
  gap: number;
  closed: boolean;
  pieces: string[];
}

export interface BuildSheet {
  runs: CutRun[];
  /** Total strip that gets cut and fitted, m. */
  stripMetres: number;
  /** What to buy: the fitted length plus 10% spare, rounded up to the next half metre. */
  buyMetres: number;
  watts: number;
  amps: number;
  /** Suggested supply size, with about 20% headroom. */
  psuWatts: number;
  psuAmps: number;
  /** Longest single run, m, and whether it is long enough that it should be fed from both ends. */
  longestRun: number;
  feedBothEnds: boolean;
  wire: string;
  filamentGrams: number;
  /** Rough print time range, hours (assumes 20–35 g of filament an hour). */
  printHours: [number, number];
  parts: { item: string; qty: string; note: string }[];
}

/** Beyond about this length on a single feed, voltage drop makes the far end visibly dimmer (typical figures). */
const SINGLE_FEED_LIMIT = { 12: 5, 24: 10 } as const;

export function buildSheet(d: Design, s: StripSpec): BuildSheet {
  const interval = Math.max(1, s.cutInterval);
  const runs: CutRun[] = d.runs.map((r, i) => {
    const cut = Math.floor(r.length / interval) * interval;
    return { channel: r.length, cut, gap: r.length - cut, closed: d.neon[i].closed, pieces: r.pieces };
  });
  const stripMetres = runs.reduce((t, r) => t + r.cut, 0) / 1000;
  const buyMetres = Math.ceil(stripMetres * 1.1 * 2) / 2;
  const watts = stripMetres * s.wattsPerMetre;
  const amps = watts / s.voltage;
  const psuWatts = PSU_SIZES.find((w) => w >= watts * 1.2) ?? Math.ceil((watts * 1.2) / 50) * 50;
  const longestRun = Math.max(0, ...runs.map((r) => r.cut)) / 1000;
  const grams = d.stats.filamentGrams;
  const openRuns = runs.filter((r) => !r.closed).length;
  const parts = [
    { item: `LED neon flex, ${d.params.stripWidth} mm wide, ${s.voltage} V`, qty: `${buyMetres.toFixed(1)} m`, note: `${stripMetres.toFixed(2)} m fitted plus spare. It must curve flat round the letters with its lit face pointing straight out of the sign.` },
    { item: `${s.voltage} V DC power supply`, qty: `1 × ${psuWatts} W`, note: `At least ${(psuWatts / s.voltage).toFixed(1)} A. A certified plug-in or enclosed supply.` },
    { item: 'Feed leads or clip-on connectors for the strip', qty: String(runs.length), note: 'One per run, at the cable hole.' },
    { item: 'End caps (silicone, matching the strip)', qty: String(runs.length), note: openRuns < runs.length ? 'Loops still need a cap where the strip ends.' : 'One for the far end of each run.' },
    { item: 'Two-core wire', qty: `${Math.max(1, Math.ceil(runs.length * 0.5 + 1))} m`, note: `${wireFor(amps)}, red/black, to join the runs to the supply.` },
    { item: 'Filament (PETG or ASA recommended)', qty: `${Math.ceil(grams / 1000) || 1} × 1 kg`, note: `About ${Math.round(grams)} g if printed solid; a slicer will usually show less.` },
    { item: 'Glue', qty: '1', note: 'CA (superglue) or 2-part epoxy for the joints; silicone sealant for the end caps.' },
  ];
  if (d.mounts.length) parts.push({ item: `Screws and wall plugs (to suit ${d.params.screwHoleDiameter} mm holes)`, qty: String(d.mounts.length), note: 'Pan head or round head.' });
  parts.push({ item: 'Optional: inline switch, dimmer or controller', qty: '1', note: `Rated for ${s.voltage} V and at least ${Math.ceil(amps * 1.2 * 10) / 10} A.` });
  return {
    runs, stripMetres, buyMetres, watts, amps, psuWatts, psuAmps: psuWatts / s.voltage, longestRun,
    feedBothEnds: longestRun > SINGLE_FEED_LIMIT[s.voltage], wire: wireFor(amps), filamentGrams: grams,
    printHours: [grams / 35, grams / 20], parts,
  };
}

function wireFor(amps: number): string {
  return WIRE.find((w) => amps <= w.amps)!.label;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cm = (mm: number) => `${(mm / 10).toFixed(1)} cm`;
const hours = ([a, b]: [number, number]) => (b < 1 ? 'under an hour' : `about ${Math.max(1, Math.round(a))}–${Math.max(1, Math.round(b))} h`);

/** The build sheet as HTML, shared by the app panel and the assembly guide. */
export function buildSheetHtml(b: BuildSheet, s: StripSpec): string {
  const runs = b.runs.map((r, i) => `<tr><td>${i + 1}</td><td>${cm(r.cut)}</td><td>${r.gap > 0.5 ? `${(r.gap).toFixed(0)} mm` : '—'}</td><td>${r.closed ? 'loop' : 'line'}</td><td>${esc(r.pieces.join(' → ') || '—')}</td></tr>`).join('');
  const parts = b.parts.map((p) => `<tr><td>${esc(p.item)}</td><td>${esc(p.qty)}</td><td>${esc(p.note)}</td></tr>`).join('');
  return `
<h3>Power</h3>
<p><b>${b.watts.toFixed(1)} W</b> (${b.amps.toFixed(2)} A at ${s.voltage} V) for ${b.stripMetres.toFixed(2)} m at ${s.wattsPerMetre} W/m.
Use a <b>${b.psuWatts} W</b> supply (${b.psuAmps.toFixed(1)} A) or bigger: about 20% headroom keeps it cool.
Wire to the runs: ${esc(b.wire)}.</p>
${b.feedBothEnds ? `<p class="warn">The longest run is ${b.longestRun.toFixed(1)} m. At ${s.voltage} V that is long enough for the far end to look dimmer: feed it from both ends, or split it.</p>` : ''}
<h3>Strip cut list</h3>
<p>Cut each run at the last cut mark that fits (marks every ${s.cutInterval} mm). The strip cannot stretch, so a run may end up to one interval short; the gap column shows how much channel stays unlit.</p>
<table><tr><th>Run</th><th>Cut</th><th>Gap</th><th>Shape</th><th>Pieces</th></tr>${runs}</table>
<p>Buy <b>${b.buyMetres.toFixed(1)} m</b> (${b.stripMetres.toFixed(2)} m fitted plus about 10% spare).</p>
<h3>Printing</h3>
<p>About ${Math.round(b.filamentGrams)} g of filament if printed solid; your slicer will give the real figure and time (roughly ${hours(b.printHours)} in total).</p>
<h3>Shopping list</h3>
<table><tr><th>Item</th><th>Qty</th><th>Notes</th></tr>${parts}</table>
<p class="small">Typical figures only. Check your strip's spec sheet for watts per metre, cut interval, bend direction and maximum run length.</p>`;
}
