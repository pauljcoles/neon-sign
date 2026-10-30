# Glowline — LED neon sign maker

A static web app that turns text or an SVG into a 3D-printable holder for LED neon flex strip. It splits the sign into pieces that fit your printer bed (defaults suit a Bambu Lab P2S, 256 mm bed) and exports one STL per piece, a 1:1 SVG template and an assembly guide.

Everything runs in the browser. There is no backend.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # geometry unit tests
npm run build      # static site in dist/
```

## Using it

The site has a **How to build one** guide (`guide.html`): order of work, choosing LED neon (sizes, bend direction, 12 V vs 24 V, cut marks, colour types), filament and print settings, power supplies and wiring, mounting, safety and troubleshooting.


1. **Content**: type your text (Enter starts a new line), pick a font or upload a TTF/OTF/WOFF file. Single-line fonts such as Relief SingleLine work too: their there-and-back strokes are used as centre lines. Or switch to **SVG** and upload a drawing. Filled shapes are traced; lines with a stroke and no fill are used as the neon path exactly as drawn.
   **Neon runs** picks the style:
   - *Around each letter (outline)*: the strip follows the letter outlines. Best with bold fonts.
   - *Down the middle of each stroke (single line)*: one strip down the centre of each stroke, like classic neon. Best with script and thin fonts. The printed body is just the channel around that line. Where strokes cross (an "x", a script loop) the strip runs straight through; where one stroke meets another side-on (a "T"), it becomes a separate run. Dots too small for a line (the dot on an "i") are left out, with a warning.
2. **Letter spacing**: negative values push letters into each other. **Where letters overlap** decides how the neon runs:
   - *Merge*: one outline around the fused letters.
   - *Right-hand / left-hand letter on top*: the top letter keeps its full outline, so a seam line runs across the overlap.
3. **Move things**: drag in the preview. The toolbar switch sets whether a drag moves a **Letter**, a **Word** or a **Line**. The neon channel re-renders live while you drag; pause for a moment (still holding) and the pieces and connectors are recut too. Drag empty space to pan; scroll to zoom. *Reset moved letters and words* undoes all moves.
   **Grouping** (Word mode): click a word to select it, Shift- or Ctrl-click more, then **Group**. A group moves as one and shows a dashed box; clicking any word in it selects the whole group. **Ungroup** splits it again. Dragging a selected word also moves everything else that is selected. Groups are kept until the text changes (SVG shapes group the same way).
4. **Size**: size the lettering by width or by height. Pick your **printer** (or enter the bed size) and a **margin**; pieces are kept to the bed minus twice the margin (240 mm on a 256 mm bed by default). **Cuts** are *smart* (where they cross the least material) or an *even grid*.
5. **Neon strip**: pick a **strip size** preset (3 × 8 up to 12 × 25 mm; it sets the strip width and a wall height 2 mm under the strip height) or enter your own. **Download fit test piece** gives a 60 mm U of channel with one bend at the min bend radius: print it first to check the strip presses in snugly.
6. **Printed body**: a **body style**:
   - *Back plate*: channel walls on a plate the shape of the letters.
   - *Solid letters*: the letters are solid up to the top of the walls, with the channel sunk in.
   - *Channel only*: just the channel and its walls (single-line mode always works like this).

   Then wall thickness and height, base thickness, bridges between loose letters (with a **bridge height**: taller bridges are stiffer), dovetail connectors and their clearance, plus:
   - **Cable hole** through the channel floor at the start of each run, for the feed wire (lower end of an open run, bottom of a loop, kept clear of cuts).
   - **Screw holes for mounting**: in solid back plate where there is room (inside letters, on bridges), otherwise on a small lug on the outer edge of the piece. Wide pieces get two.
   - **Engraved piece IDs** on the underside (0.6 mm deep, mirrored so they read correctly with the piece turned over), on plain floor with no wall above.
7. **Layers**: pieces, walls, bridges, neon path, cuts and tight-bend markers. **Glow** shows a lit-up preview in the chosen colour.
8. **Power & parts**: enter your strip's watts per metre, voltage and cut-mark spacing. You get the power draw, a supply size with 20% headroom, a wire size, a warning if a run is long enough to need feeding from both ends, a strip cut list (each run cut at the last mark that fits), how much strip to buy and a shopping list. The same build sheet goes into the assembly guide.
9. **Runs**: each run starts at its cable hole (numbered pink circle in the preview and on the template, with an arrow for direction). The assembly guide has a cut list: length per run, rounded up to 5 mm, and the pieces it passes through.
10. **Download ZIP**: `pieces/piece-A1.stl …`, `pieces/fit-test.stl`, `template.svg` (1:1, with a 100 mm scale bar), `assembly-guide.html` and `settings.json`.

Piece names are a column letter (from the left) plus a row number (from the top). `A1` is the top-left piece.

The stats bar shows lettering size, printed size, piece count, metres of neon (and how many separate runs) and a rough solid-filament weight. The **Check** list warns about bends tighter than the strip's minimum radius, joints too short for a connector, and parts that end up unconnected.

## How the geometry works

- Glyph outlines come from opentype.js, are flattened to polylines, scaled to the requested width, and unioned per letter. Polygon booleans and offsets use clipper-lib, working in micrometres.
- **Neon path**: the outline of the fused letters, or in the stacking modes each letter's outline minus whatever lies on top of it.
- **Single line**: the letter shape is rasterised at about 0.3 mm, thinned to a one-pixel skeleton (Zhang–Suen), and traced into chains. Short side spurs are pruned, two junctions closer than the mean stroke width are treated as one crossing, and at each junction the two straightest branches are joined so the strip runs through. The chains are then smoothed and simplified.
- **Body**: channel = band of half-width `(strip + clearance) / 2` around the neon path. Walls = band widened by the wall thickness, minus the channel. Base plate = letter fill ∪ wall band ∪ bridges. Bridges join separate islands along a minimum spanning tree of closest points, at base-plate height.
- **Splitting**: cuts are picked along x (and along y if the sign is too tall) so each cell is at most `maxPiece − connector depth`. Each cut goes where the line crosses the least material. Cuts avoid clipping just the end of a stroke, which would leave a sliver too short to join. Every joint gets a dovetail placed in solid material, away from the walls where possible. Narrow joints (single-line bodies are only about 10 mm wide) get a smaller dovetail, down to a 3.5 mm neck, and where the body crosses the cut at an angle the dovetail leans to follow it. The mating piece gets a socket grown by the connector clearance.
- **STL**: each piece is two closed prisms (base plate, and walls from z = 0), triangulated with earcut, written as binary STL and centred on a 256 mm bed. Slicers merge the overlapping shells.
- Geometry runs in a Web Worker with a latest-wins queue, so the page stays responsive.

## Checked so far

- Unit tests cover the build sheet (cut marks, supply sizing, 12 vs 24 V, long-run warning), run order and the cut list, engraved labels clear of walls, body styles and raised bridges, size by height, even-grid cuts, single-line font strokes, the fit-test piece for every strip preset, cable holes (one per run, in the channel, clear of cuts), screw holes and lugs, single-line centrelines (bars, rings, crosses, T junctions, stroked lines, dropped dots), offsets, channel width, neon length (merge and stacked), tight-bend detection, cut placement, row splitting, connectors, SVG path parsing (arcs, relative commands), word/line grouping, and watertight meshes for all three bundled fonts.
- A 700 mm "Neon Bar" export sliced without errors in the Bambu Studio CLI with the P2S 0.4 mm / 0.20 mm Standard / PLA Basic profiles.

## Fonts

Pacifico, Lobster and Righteous are bundled from Google Fonts under the SIL Open Font License. The licence files are in `public/fonts/`.
