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

1. **Content**: type your text (Enter starts a new line), pick a font or upload a TTF/OTF/WOFF file. Or switch to **SVG** and upload a drawing made of closed, filled shapes.
2. **Letter spacing**: negative values push letters into each other. **Where letters overlap** decides how the neon runs:
   - *Merge*: one outline around the fused letters.
   - *Right-hand / left-hand letter on top*: the top letter keeps its full outline, so a seam line runs across the overlap.
3. **Move things**: drag in the preview. The toolbar switch sets whether a drag moves a **Letter**, a **Word** or a **Line**. The neon channel re-renders live while you drag. The cut into pieces is redone when you let go. Drag empty space to pan; scroll to zoom. *Reset moved letters and words* undoes all moves.
4. **Size**: set the lettering width in mm, the max piece size (240 mm by default, leaving margin on a 256 mm bed) and the bed size.
5. **Neon strip / Printed body**: strip width, channel clearance, wall thickness and height, base thickness, bridges between loose letters, and dovetail connectors with their clearance.
6. **Layers**: pieces, walls, bridges, neon path, cuts and tight-bend markers. **Glow** shows a lit-up preview in the chosen colour.
7. **Download ZIP**: `pieces/piece-A1.stl …`, `template.svg` (1:1, with a 100 mm scale bar), `assembly-guide.html` and `settings.json`.

Piece names are a column letter (from the left) plus a row number (from the top). `A1` is the top-left piece.

The stats bar shows lettering size, printed size, piece count, metres of neon (and how many separate runs) and a rough solid-filament weight. The **Check** list warns about bends tighter than the strip's minimum radius, joints too short for a connector, and parts that end up unconnected.

## How the geometry works

- Glyph outlines come from opentype.js, are flattened to polylines, scaled to the requested width, and unioned per letter. Polygon booleans and offsets use clipper-lib, working in micrometres.
- **Neon path**: the outline of the fused letters, or in the stacking modes each letter's outline minus whatever lies on top of it.
- **Body**: channel = band of half-width `(strip + clearance) / 2` around the neon path. Walls = band widened by the wall thickness, minus the channel. Base plate = letter fill ∪ wall band ∪ bridges. Bridges join separate islands along a minimum spanning tree of closest points, at base-plate height.
- **Splitting**: cuts are picked along x (and along y if the sign is too tall) so each cell is at most `maxPiece − connector depth`. Each cut goes where the line crosses the least material. Every joint long enough gets a dovetail placed in solid material, away from the walls where possible. The mating piece gets a socket grown by the connector clearance.
- **STL**: each piece is two closed prisms (base plate, and walls from z = 0), triangulated with earcut, written as binary STL and centred on a 256 mm bed. Slicers merge the overlapping shells.
- Geometry runs in a Web Worker with a latest-wins queue, so the page stays responsive.

## Checked so far

- Unit tests cover offsets, channel width, neon length (merge and stacked), tight-bend detection, cut placement, row splitting, connectors, SVG path parsing (arcs, relative commands), word/line grouping, and watertight meshes for all three bundled fonts.
- A 700 mm "Neon Bar" export sliced without errors in the Bambu Studio CLI with the P2S 0.4 mm / 0.20 mm Standard / PLA Basic profiles.

## Fonts

Pacifico, Lobster and Righteous are bundled from Google Fonts under the SIL Open Font License. The licence files are in `public/fonts/`.
