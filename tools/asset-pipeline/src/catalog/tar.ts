import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

const BLOCK = 512;
const NAME = [0, 100] as const;
const SIZE = [124, 136] as const;
const TYPE = 156;
const PREFIX = [345, 500] as const;
const PAX_HEADER = "x";
const PAX_GLOBAL_HEADER = "g";
const REGULAR_FILE_TYPES: ReadonlySet<string> = new Set(["0", "\0"]);

export type TarEntryFilter = (path: string) => boolean;
export type TarEntryHandler = (path: string, bytes: Buffer) => void;

function field(header: Buffer, [start, end]: readonly [number, number]): string {
  const raw = header.subarray(start, end);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul < 0 ? raw.length : nul).toString("utf8");
}

function paxPath(bytes: Buffer): string | undefined {
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number(bytes.subarray(offset, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") return record.slice(equals + 1);
    offset += length;
  }
  return undefined;
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

export async function readTarGz(
  path: string,
  accept: TarEntryFilter,
  onEntry: TarEntryHandler,
): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  let skip = 0;
  let collecting: { path: string; size: number; kind: "file" | "pax" } | null = null;
  let nextPath: string | undefined;
  let ended = false;
  for await (const chunk of createReadStream(path).pipe(createGunzip())) {
    if (ended) continue;
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
    for (;;) {
      if (skip > 0) {
        const dropped = Math.min(skip, pending.length);
        pending = pending.subarray(dropped);
        skip -= dropped;
        if (skip > 0) break;
      }
      if (collecting) {
        const total = padded(collecting.size);
        if (pending.length < total) break;
        const bytes = Buffer.from(pending.subarray(0, collecting.size));
        if (collecting.kind === "pax") nextPath = paxPath(bytes);
        else onEntry(collecting.path, bytes);
        pending = pending.subarray(total);
        collecting = null;
        continue;
      }
      if (pending.length < BLOCK) break;
      const header = pending.subarray(0, BLOCK);
      pending = pending.subarray(BLOCK);
      if (header.every((byte) => byte === 0)) {
        ended = true;
        break;
      }
      const size = parseInt(field(header, SIZE).trim() || "0", 8);
      const type = String.fromCharCode(header[TYPE] ?? 0);
      const prefix = field(header, PREFIX);
      const name = field(header, NAME);
      const entryPath = nextPath ?? (prefix === "" ? name : `${prefix}/${name}`);
      if (type === PAX_HEADER) {
        collecting = { path: entryPath, size, kind: "pax" };
        continue;
      }
      if (type !== PAX_GLOBAL_HEADER) nextPath = undefined;
      if (REGULAR_FILE_TYPES.has(type) && accept(entryPath)) {
        collecting = { path: entryPath, size, kind: "file" };
      } else {
        skip = padded(size);
      }
    }
  }
}
