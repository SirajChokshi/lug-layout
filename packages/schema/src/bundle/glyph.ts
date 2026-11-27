import type { Decoded } from "../decode/index.ts";

export const PLAN_GLYPH_MAGIC = "BRRGLYF1";

export interface PlanGlyph {
  readonly pixelsPerStud: number;
  readonly samplesPerPixelSide: number;
  readonly originX: number;
  readonly originZ: number;
  readonly width: number;
  readonly depth: number;
  readonly colors: Uint32Array;
  readonly coverage: Uint8Array;
  readonly colorIndex: Uint16Array;
  readonly loopStarts: Uint32Array;
  readonly vertices: Uint16Array;
}

const MAX_SIDE_PIXELS = 16_383;
const MAX_PIXELS = 1 << 24;
const MAX_COLORS = 1 << 16;
const NARROW_PALETTE = 1 << 8;
const MIN_LOOP_VERTICES = 4;
const VARINT_MAX_BYTES = 5;
const VARINT_PAYLOAD = 0x7f;
const VARINT_MORE = 0x80;
const VARINT_PAYLOAD_BITS = 7;
const U32_LIMIT = 2 ** 32;

class GlyphFormatError extends Error {}

class GlyphReader {
  private at = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.at;
  }

  private advance(count: number): number {
    if (count > this.remaining) throw new GlyphFormatError("the plan glyph ends early");
    const start = this.at;
    this.at += count;
    return start;
  }

  fits(count: number, bytesEach: number): void {
    if (count * bytesEach > this.remaining) throw new GlyphFormatError("the plan glyph ends early");
  }

  text(count: number): string {
    const start = this.advance(count);
    return String.fromCharCode(...this.bytes.subarray(start, start + count));
  }

  u8(): number {
    return this.view.getUint8(this.advance(1));
  }

  u16(): number {
    return this.view.getUint16(this.advance(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.advance(4), true);
  }

  i32(): number {
    return this.view.getInt32(this.advance(4), true);
  }

  varint(): number {
    let value = 0;
    for (let k = 0; k < VARINT_MAX_BYTES; k++) {
      const byte = this.u8();
      value += (byte & VARINT_PAYLOAD) * 2 ** (VARINT_PAYLOAD_BITS * k);
      if ((byte & VARINT_MORE) === 0) {
        if ((k > 0 && byte === 0) || value >= U32_LIMIT) {
          throw new GlyphFormatError("the plan glyph has an overlong count");
        }
        return value;
      }
    }
    throw new GlyphFormatError("the plan glyph has an overlong count");
  }

  signedVarint(): number {
    const value = this.varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }
}

function header(reader: GlyphReader) {
  if (reader.text(PLAN_GLYPH_MAGIC.length) !== PLAN_GLYPH_MAGIC) {
    throw new GlyphFormatError("not a plan glyph");
  }
  const pixelsPerStud = reader.u8();
  const samplesPerPixelSide = reader.u8();
  if (pixelsPerStud === 0 || samplesPerPixelSide === 0) {
    throw new GlyphFormatError("the plan glyph has no pixels or samples per stud");
  }
  const originX = reader.i32();
  const originZ = reader.i32();
  const width = reader.u32();
  const depth = reader.u32();
  if (
    (width === 0) !== (depth === 0) ||
    width > MAX_SIDE_PIXELS ||
    depth > MAX_SIDE_PIXELS ||
    width * depth > MAX_PIXELS
  ) {
    throw new GlyphFormatError(`the plan glyph can't be ${width} × ${depth} pixels`);
  }
  return { pixelsPerStud, samplesPerPixelSide, originX, originZ, width, depth };
}

function palette(reader: GlyphReader): Uint32Array {
  const count = reader.u32();
  if (count > MAX_COLORS) throw new GlyphFormatError(`the plan glyph has ${count} colours`);
  reader.fits(count, 4);
  const colors = new Uint32Array(count);
  for (let k = 0; k < count; k++) {
    colors[k] = reader.u32();
    if (k > 0 && (colors[k] ?? 0) <= (colors[k - 1] ?? 0)) {
      throw new GlyphFormatError("the plan glyph palette is not strictly ascending");
    }
  }
  return colors;
}

function pixels(
  reader: GlyphReader,
  pixelCount: number,
  colorCount: number,
  samplesPerPixel: number,
): { readonly coverage: Uint8Array; readonly colorIndex: Uint16Array } {
  const narrow = colorCount <= NARROW_PALETTE;
  const runs = reader.u32();
  reader.fits(runs, narrow ? 3 : 4);
  const coverage = new Uint8Array(pixelCount);
  const colorIndex = new Uint16Array(pixelCount);
  let filled = 0;
  let previous = -1;
  for (let run = 0; run < runs; run++) {
    const length = reader.varint() + 1;
    const covered = reader.u8();
    const index = narrow ? reader.u8() : reader.u16();
    const key = covered * MAX_COLORS + index;
    if (key === previous) throw new GlyphFormatError("the plan glyph repeats a pixel run");
    if (filled + length > pixelCount) {
      throw new GlyphFormatError(`the plan glyph's pixel runs overrun its ${pixelCount} pixels`);
    }
    if (covered > samplesPerPixel) {
      throw new GlyphFormatError(`a plan glyph pixel covers ${covered} samples`);
    }
    if ((covered === 0 && index !== 0) || (covered > 0 && index >= colorCount)) {
      throw new GlyphFormatError(`a plan glyph pixel names colour ${index}`);
    }
    previous = key;
    coverage.fill(covered, filled, filled + length);
    colorIndex.fill(index, filled, filled + length);
    filled += length;
  }
  if (filled !== pixelCount) {
    throw new GlyphFormatError(`the plan glyph's runs fill ${filled} of ${pixelCount} pixels`);
  }
  return { coverage, colorIndex };
}

function outline(
  reader: GlyphReader,
  limitX: number,
  limitZ: number,
): { readonly loopStarts: Uint32Array; readonly vertices: Uint16Array } {
  const loops = reader.u32();
  reader.fits(loops, 8);
  const loopStarts = new Uint32Array(loops + 1);
  const coordinates: number[] = [];
  for (let loop = 0; loop < loops; loop++) {
    const startX = reader.u16();
    const startZ = reader.u16();
    const count = reader.u32();
    if (count < MIN_LOOP_VERTICES || count % 2 !== 0) {
      throw new GlyphFormatError(`a plan glyph outline loop has ${count} vertices`);
    }
    reader.fits(count, 1);
    let x = startX;
    let z = startZ;
    for (let k = 0; k < count; k++) {
      if (x < 0 || z < 0 || x > limitX || z > limitZ) {
        throw new GlyphFormatError("a plan glyph outline leaves the glyph");
      }
      coordinates.push(x, z);
      const step = reader.signedVarint();
      if (step === 0) throw new GlyphFormatError("a plan glyph outline repeats a vertex");
      if (k % 2 === 0) x += step;
      else z += step;
    }
    if (x !== startX || z !== startZ) {
      throw new GlyphFormatError("a plan glyph outline loop doesn't close");
    }
    loopStarts[loop + 1] = coordinates.length / 2;
  }
  return { loopStarts, vertices: Uint16Array.from(coordinates) };
}

export function decodePlanGlyph(bytes: Uint8Array): Decoded<PlanGlyph> {
  try {
    const reader = new GlyphReader(bytes);
    const head = header(reader);
    const colors = palette(reader);
    const samplesPerPixel = head.samplesPerPixelSide * head.samplesPerPixelSide;
    const raster = pixels(reader, head.width * head.depth, colors.length, samplesPerPixel);
    const lines = outline(
      reader,
      head.width * head.samplesPerPixelSide,
      head.depth * head.samplesPerPixelSide,
    );
    if (reader.remaining !== 0) {
      throw new GlyphFormatError(`the plan glyph has ${reader.remaining} bytes after its end`);
    }
    return { ok: true, value: { ...head, colors, ...raster, ...lines } };
  } catch (error) {
    if (!(error instanceof GlyphFormatError)) throw error;
    return { ok: false, issues: [{ path: "$", message: error.message }] };
  }
}
