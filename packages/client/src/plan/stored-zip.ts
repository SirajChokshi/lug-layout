export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const STORED = 0;
const DOS_DATE_1980_01_01 = 0x0021;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;
const CRC_POLYNOMIAL = 0xedb88320;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? CRC_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function storedZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  const encoder = new TextEncoder();
  const names = entries.map((entry) => encoder.encode(entry.name));
  const localSize = entries.reduce(
    (sum, entry, i) => sum + LOCAL_HEADER_BYTES + (names[i]?.length ?? 0) + entry.bytes.length,
    0,
  );
  const centralSize = names.reduce((sum, name) => sum + CENTRAL_HEADER_BYTES + name.length, 0);
  const out = new Uint8Array(localSize + centralSize + END_BYTES);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  const crcs = entries.map((entry) => crc32(entry.bytes));
  let at = 0;
  entries.forEach((entry, i) => {
    const name = names[i] ?? new Uint8Array();
    offsets.push(at);
    view.setUint32(at, LOCAL_HEADER, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, UTF8_FLAG, true);
    view.setUint16(at + 8, STORED, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_DATE_1980_01_01, true);
    view.setUint32(at + 14, crcs[i] ?? 0, true);
    view.setUint32(at + 18, entry.bytes.length, true);
    view.setUint32(at + 22, entry.bytes.length, true);
    view.setUint16(at + 26, name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(name, at + LOCAL_HEADER_BYTES);
    out.set(entry.bytes, at + LOCAL_HEADER_BYTES + name.length);
    at += LOCAL_HEADER_BYTES + name.length + entry.bytes.length;
  });
  const centralStart = at;
  entries.forEach((entry, i) => {
    const name = names[i] ?? new Uint8Array();
    view.setUint32(at, CENTRAL_HEADER, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, VERSION, true);
    view.setUint16(at + 8, UTF8_FLAG, true);
    view.setUint16(at + 10, STORED, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, DOS_DATE_1980_01_01, true);
    view.setUint32(at + 16, crcs[i] ?? 0, true);
    view.setUint32(at + 20, entry.bytes.length, true);
    view.setUint32(at + 24, entry.bytes.length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, offsets[i] ?? 0, true);
    out.set(name, at + CENTRAL_HEADER_BYTES);
    at += CENTRAL_HEADER_BYTES + name.length;
  });
  view.setUint32(at, END_OF_CENTRAL, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

export function readStoredZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - END_BYTES;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_CENTRAL) end--;
  if (end < 0) throw new Error("not a zip archive: no end-of-central-directory record");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL_HEADER)
      throw new Error("zip central directory is damaged");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(
      bytes.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength),
    );
    if (method !== STORED)
      throw new Error(`${name} is compressed; a .brrplan.zip stores its files uncompressed`);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + LOCAL_HEADER_BYTES + localName + localExtra;
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error(`${name} fails its CRC-32 check`);
    entries.push({ name, bytes: data });
    at += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
  }
  return entries;
}
