import { STUD_LDU } from "@brr/math";
import {
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
} from "three/webgpu";
import { uniform } from "three/tsl";
import type { PlanSprite } from "../plan-scene.ts";
import type { LdrawColor } from "../scene-backend.ts";

const PAGE_TEXELS = 4096;
const FIRST_PAGE_ROWS = 256;
const GUTTER_TEXELS = 4;
const CHANNELS = 4;
const BYTE_MAX = 255;
const OPAQUE_ALPHA = 255;
const INHERIT_COLOR = 16;
const ROOM_TEXELS = PAGE_TEXELS - 2 * GUTTER_TEXELS;

export interface AtlasSlot {
  readonly page: number;
  readonly texelX: number;
  readonly texelY: number;
  readonly width: number;
  readonly depth: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export type LdrawColorOf = (code: number) => LdrawColor;

function pageTexture(rows: number): DataTexture {
  const result = new DataTexture(
    new Uint8Array(PAGE_TEXELS * rows * CHANNELS),
    PAGE_TEXELS,
    rows,
    RGBAFormat,
    UnsignedByteType,
  );
  result.colorSpace = NoColorSpace;
  result.flipY = false;
  result.unpackAlignment = 1;
  result.generateMipmaps = true;
  result.minFilter = LinearMipmapLinearFilter;
  result.magFilter = LinearFilter;
  result.needsUpdate = true;
  return result;
}

export class AtlasPage {
  readonly texture = pageTexture(FIRST_PAGE_ROWS);
  readonly size = uniform(new Vector2(PAGE_TEXELS, FIRST_PAGE_ROWS));
  private rows = FIRST_PAGE_ROWS;
  private cursorX = 0;
  private shelfY = 0;
  private shelfRows = 0;

  get data(): Uint8Array {
    const { data } = this.texture.image as { data: Uint8Array };
    return data;
  }

  reserve(width: number, depth: number): readonly [number, number] | null {
    const paddedWidth = width + 2 * GUTTER_TEXELS;
    const paddedDepth = depth + 2 * GUTTER_TEXELS;
    if (this.cursorX + paddedWidth > PAGE_TEXELS) {
      this.shelfY += this.shelfRows;
      this.cursorX = 0;
      this.shelfRows = 0;
    }
    if (this.shelfY + paddedDepth > PAGE_TEXELS) return null;
    const at = [this.cursorX + GUTTER_TEXELS, this.shelfY + GUTTER_TEXELS] as const;
    this.cursorX += paddedWidth;
    this.shelfRows = Math.max(this.shelfRows, paddedDepth);
    this.growTo(this.shelfY + this.shelfRows);
    return at;
  }

  private growTo(rows: number): void {
    if (rows <= this.rows) return;
    let grown = this.rows;
    while (grown < rows) grown *= 2;
    const data = new Uint8Array(PAGE_TEXELS * grown * CHANNELS);
    data.set(this.data);
    this.texture.dispose();
    this.texture.image = { data, width: PAGE_TEXELS, height: grown };
    this.texture.needsUpdate = true;
    this.rows = grown;
    this.size.value.set(PAGE_TEXELS, grown);
  }

  changed(): void {
    this.texture.needsUpdate = true;
  }
}

export class GlyphAtlas {
  readonly pages: AtlasPage[] = [];
  private readonly scratchColor = new Color();
  private paletteRgba = new Float32Array(0);

  add(sprite: PlanSprite, colorOf: LdrawColorOf): AtlasSlot | null {
    const { glyph } = sprite;
    if (glyph.width === 0) return null;
    const step = Math.ceil(Math.max(glyph.width, glyph.depth) / ROOM_TEXELS);
    const width = Math.ceil(glyph.width / step);
    const depth = Math.ceil(glyph.depth / step);
    const [page, texelX, texelY] = this.reserve(width, depth);
    this.resolvePalette(sprite, colorOf);
    this.write(sprite, step, page, texelX, texelY, width, depth);
    const pixelLdu = STUD_LDU / glyph.pixelsPerStud;
    const minX = glyph.originX * pixelLdu + sprite.shiftX;
    const minZ = glyph.originZ * pixelLdu + sprite.shiftZ;
    return {
      page: this.pages.indexOf(page),
      texelX,
      texelY,
      width,
      depth,
      minX,
      minZ,
      maxX: minX + width * step * pixelLdu,
      maxZ: minZ + depth * step * pixelLdu,
    };
  }

  dispose(): void {
    for (const page of this.pages) page.texture.dispose();
  }

  private reserve(width: number, depth: number): readonly [AtlasPage, number, number] {
    const last = this.pages.at(-1);
    const atLast = last?.reserve(width, depth) ?? null;
    if (last && atLast) return [last, atLast[0], atLast[1]];
    const page = new AtlasPage();
    this.pages.push(page);
    const at = page.reserve(width, depth);
    if (!at) throw new Error(`a ${width} × ${depth} texel glyph doesn't fit an empty atlas page`);
    return [page, at[0], at[1]];
  }

  private resolvePalette(sprite: PlanSprite, colorOf: LdrawColorOf): void {
    const { colors } = sprite.glyph;
    if (this.paletteRgba.length < colors.length * CHANNELS) {
      this.paletteRgba = new Float32Array(colors.length * CHANNELS);
    }
    for (let k = 0; k < colors.length; k++) {
      const code = colors[k] ?? 0;
      const color = colorOf(code === INHERIT_COLOR ? sprite.inheritedColor : code);
      this.scratchColor.setHex(color.srgb, SRGBColorSpace);
      this.paletteRgba[k * CHANNELS] = this.scratchColor.r;
      this.paletteRgba[k * CHANNELS + 1] = this.scratchColor.g;
      this.paletteRgba[k * CHANNELS + 2] = this.scratchColor.b;
      this.paletteRgba[k * CHANNELS + 3] = color.alpha / OPAQUE_ALPHA;
    }
  }

  private write(
    sprite: PlanSprite,
    step: number,
    page: AtlasPage,
    texelX: number,
    texelY: number,
    width: number,
    depth: number,
  ): void {
    const { glyph } = sprite;
    const samples = glyph.samplesPerPixelSide * glyph.samplesPerPixelSide * step * step;
    const palette = this.paletteRgba;
    const data = page.data;
    for (let row = 0; row < depth; row++) {
      for (let column = 0; column < width; column++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let z = row * step; z < Math.min((row + 1) * step, glyph.depth); z++) {
          for (let x = column * step; x < Math.min((column + 1) * step, glyph.width); x++) {
            const pixel = z * glyph.width + x;
            const covered = glyph.coverage[pixel] ?? 0;
            if (covered === 0) continue;
            const p = (glyph.colorIndex[pixel] ?? 0) * CHANNELS;
            const weight = covered * (palette[p + 3] ?? 0);
            r += (palette[p] ?? 0) * weight;
            g += (palette[p + 1] ?? 0) * weight;
            b += (palette[p + 2] ?? 0) * weight;
            a += weight;
          }
        }
        const o = ((texelY + row) * PAGE_TEXELS + texelX + column) * CHANNELS;
        data[o] = Math.round((r / samples) * BYTE_MAX);
        data[o + 1] = Math.round((g / samples) * BYTE_MAX);
        data[o + 2] = Math.round((b / samples) * BYTE_MAX);
        data[o + 3] = Math.round((a / samples) * BYTE_MAX);
      }
    }
    page.changed();
  }
}
