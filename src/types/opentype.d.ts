// Minimal typings for the parts of opentype.js 2.x this app uses.
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z';
    x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  }
  export interface Path { commands: PathCommand[] }
  export interface Glyph {
    index: number;
    unicode?: number;
    advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number): Path;
  }
  export interface RenderOptions { kerning?: boolean; letterSpacing?: number; features?: Record<string, boolean> }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    names: { fontFamily?: Record<string, string>; [k: string]: unknown };
    forEachGlyph(text: string, x: number, y: number, fontSize: number, options: RenderOptions,
      cb: (glyph: Glyph, x: number, y: number, fontSize: number) => void): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
