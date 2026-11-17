import type { Decoded, Issue } from "@brr/schema/decode";

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_DIRECTORY_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;
const ZIP_VERSION_2_0 = 20;
const UTF8_NAMES_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const DOS_TIME_MIDNIGHT = 0;
const DOS_DATE_1980_01_01 = (1 << 5) | 1;
const CRC32_POLYNOMIAL = 0xedb88320;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
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

const utf8 = new TextEncoder();

export function writeStoredZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new RangeError(`${entries.length} entries need ZIP64`);
  const names = entries.map((entry) => utf8.encode(entry.name));
  const crcs = entries.map((entry) => crc32(entry.bytes));
  const localBytes = entries.reduce(
    (sum, entry, i) => sum + LOCAL_HEADER_BYTES + (names[i]?.length ?? 0) + entry.bytes.length,
    0,
  );
  const centralBytes = names.reduce((sum, name) => sum + CENTRAL_HEADER_BYTES + name.length, 0);
  const total = localBytes + centralBytes + END_OF_DIRECTORY_BYTES;
  if (total > MAX_OFFSET) throw new RangeError(`a ${total}-byte archive needs ZIP64`);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;
  entries.forEach((entry, i) => {
    const name = names[i] ?? new Uint8Array();
    offsets.push(at);
    view.setUint32(at, LOCAL_HEADER_SIGNATURE, true);
    view.setUint16(at + 4, ZIP_VERSION_2_0, true);
    view.setUint16(at + 6, UTF8_NAMES_FLAG, true);
    view.setUint16(at + 8, METHOD_STORED, true);
    view.setUint16(at + 10, DOS_TIME_MIDNIGHT, true);
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
    view.setUint32(at, CENTRAL_HEADER_SIGNATURE, true);
    view.setUint16(at + 4, ZIP_VERSION_2_0, true);
    view.setUint16(at + 6, ZIP_VERSION_2_0, true);
    view.setUint16(at + 8, UTF8_NAMES_FLAG, true);
    view.setUint16(at + 10, METHOD_STORED, true);
    view.setUint16(at + 12, DOS_TIME_MIDNIGHT, true);
    view.setUint16(at + 14, DOS_DATE_1980_01_01, true);
    view.setUint32(at + 16, crcs[i] ?? 0, true);
    view.setUint32(at + 20, entry.bytes.length, true);
    view.setUint32(at + 24, entry.bytes.length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, offsets[i] ?? 0, true);
    out.set(name, at + CENTRAL_HEADER_BYTES);
    at += CENTRAL_HEADER_BYTES + name.length;
  });
  view.setUint32(at, END_OF_DIRECTORY_SIGNATURE, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

function findEndOfDirectory(view: DataView): number {
  const last = view.byteLength - END_OF_DIRECTORY_BYTES;
  const first = Math.max(0, last - MAX_COMMENT_BYTES);
  for (let at = last; at >= first; at--) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY_SIGNATURE) return at;
  }
  return -1;
}

async function inflateRaw(bytes: Uint8Array, declaredSize: number): Promise<Uint8Array | null> {
  const reader = new Blob([bytes.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > declaredSize) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (length !== declaredSize) return null;
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

interface CentralEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

function readCentralDirectory(bytes: Uint8Array, issues: Issue[]): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength >= END_OF_DIRECTORY_BYTES ? findEndOfDirectory(view) : -1;
  if (end < 0) {
    issues.push({ path: "archive", message: "is not a ZIP file (no end-of-directory record)" });
    return [];
  }
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder("utf-8", { fatal: true });
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER_BYTES > end || view.getUint32(at, true) !== CENTRAL_HEADER_SIGNATURE) {
      issues.push({ path: "archive", message: `central directory entry ${i} is damaged` });
      return [];
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      name: names.decode(
        bytes.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength),
      ),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function entryBytes(
  bytes: Uint8Array,
  entry: CentralEntry,
  issues: Issue[],
): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localOffset;
  if (
    local + LOCAL_HEADER_BYTES > bytes.byteLength ||
    view.getUint32(local, true) !== LOCAL_HEADER_SIGNATURE
  ) {
    issues.push({ path: entry.name, message: "has a damaged local header" });
    return null;
  }
  const start =
    local +
    LOCAL_HEADER_BYTES +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  const stored = bytes.subarray(start, start + entry.compressedSize);
  if (stored.length !== entry.compressedSize) {
    issues.push({ path: entry.name, message: "is truncated" });
    return null;
  }
  let data: Uint8Array;
  if (entry.method === METHOD_STORED) {
    data = stored;
  } else if (entry.method === METHOD_DEFLATED) {
    const inflated = await inflateRaw(stored, entry.size);
    if (!inflated) {
      issues.push({ path: entry.name, message: "inflates to a different size than it declares" });
      return null;
    }
    data = inflated;
  } else {
    issues.push({
      path: entry.name,
      message: `uses ZIP method ${entry.method}; only stored and deflated entries are read`,
    });
    return null;
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) {
    issues.push({ path: entry.name, message: "fails its CRC-32 or size check" });
    return null;
  }
  return data;
}

export async function readZip(
  bytes: Uint8Array,
): Promise<Decoded<ReadonlyMap<string, Uint8Array>>> {
  const issues: Issue[] = [];
  let entries: CentralEntry[];
  try {
    entries = readCentralDirectory(bytes, issues);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: "archive", message: `has unreadable entry names (${String(error)})` }],
    };
  }
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    if ((entry.flags & ENCRYPTED_FLAG) !== 0) {
      issues.push({ path: entry.name, message: "is encrypted; encrypted archives are refused" });
      continue;
    }
    if (files.has(entry.name)) {
      issues.push({ path: entry.name, message: "appears twice" });
      continue;
    }
    try {
      const data = await entryBytes(bytes, entry, issues);
      if (data) files.set(entry.name, data);
    } catch (error) {
      issues.push({ path: entry.name, message: `can't be inflated (${String(error)})` });
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: files };
}
