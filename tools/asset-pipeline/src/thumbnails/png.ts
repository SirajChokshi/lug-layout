import { crc32, deflateSync, constants } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RGBA_CHANNELS = 4;
const BIT_DEPTH = 8;
const COLOR_TYPE_RGBA = 6;
const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
const FILTERS = [FILTER_NONE, FILTER_SUB, FILTER_UP, FILTER_AVERAGE, FILTER_PAETH] as const;
const IHDR_BYTES = 13;
const CHUNK_OVERHEAD_BYTES = 12;
const BYTE = 256;
const SIGNED_BYTE_LIMIT = 128;

export interface PngImage {
  readonly width: number;
  readonly height: number;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + CHUNK_OVERHEAD_BYTES);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function filtered(filter: number, raw: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case FILTER_SUB:
      return (raw - left + BYTE) % BYTE;
    case FILTER_UP:
      return (raw - up + BYTE) % BYTE;
    case FILTER_AVERAGE:
      return (raw - Math.floor((left + up) / 2) + BYTE) % BYTE;
    case FILTER_PAETH:
      return (raw - paeth(left, up, upLeft) + BYTE) % BYTE;
    default:
      return raw;
  }
}

function filterRow(rgba: Uint8Array, width: number, y: number, filter: number, out: Buffer): void {
  const stride = width * RGBA_CHANNELS;
  const row = y * stride;
  const above = row - stride;
  for (let i = 0; i < stride; i++) {
    const left = i >= RGBA_CHANNELS ? (rgba[row + i - RGBA_CHANNELS] ?? 0) : 0;
    const up = y > 0 ? (rgba[above + i] ?? 0) : 0;
    const upLeft = y > 0 && i >= RGBA_CHANNELS ? (rgba[above + i - RGBA_CHANNELS] ?? 0) : 0;
    out[i] = filtered(filter, rgba[row + i] ?? 0, left, up, upLeft);
  }
}

function rowCost(row: Buffer): number {
  let cost = 0;
  for (const value of row) cost += value < SIGNED_BYTE_LIMIT ? value : BYTE - value;
  return cost;
}

function filteredScanlines(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * RGBA_CHANNELS;
  const out = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    let bestFilter: number = FILTER_NONE;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const filter of FILTERS) {
      filterRow(rgba, width, y, filter, candidate);
      const cost = rowCost(candidate);
      if (cost < bestCost) {
        bestCost = cost;
        bestFilter = filter;
        candidate.copy(best);
      }
    }
    out[y * (stride + 1)] = bestFilter;
    best.copy(out, y * (stride + 1) + 1);
  }
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * RGBA_CHANNELS) {
    throw new Error(
      `a ${width}×${height} RGBA image needs ${width * height * RGBA_CHANNELS} bytes`,
    );
  }
  const header = Buffer.alloc(IHDR_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGBA;
  const data = deflateSync(filteredScanlines(rgba, width, height), {
    level: constants.Z_BEST_COMPRESSION,
  });
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", data),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function readPngHeader(bytes: Buffer, label: string): PngImage {
  if (bytes.length < SIGNATURE.length + CHUNK_OVERHEAD_BYTES + IHDR_BYTES) {
    throw new Error(`${label} is too short to be a PNG file`);
  }
  if (!bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new Error(`${label} is not a PNG file`);
  }
  const ihdr = SIGNATURE.length;
  if (
    bytes.readUInt32BE(ihdr) !== IHDR_BYTES ||
    bytes.toString("ascii", ihdr + 4, ihdr + 8) !== "IHDR"
  ) {
    throw new Error(`${label} does not start with an IHDR chunk`);
  }
  const crcAt = ihdr + 8 + IHDR_BYTES;
  if (bytes.readUInt32BE(crcAt) !== crc32(bytes.subarray(ihdr + 4, crcAt))) {
    throw new Error(`${label} has a corrupt IHDR chunk`);
  }
  if (bytes[ihdr + 16] !== BIT_DEPTH || bytes[ihdr + 17] !== COLOR_TYPE_RGBA) {
    throw new Error(`${label} is not an 8-bit RGBA PNG`);
  }
  return { width: bytes.readUInt32BE(ihdr + 8), height: bytes.readUInt32BE(ihdr + 12) };
}
