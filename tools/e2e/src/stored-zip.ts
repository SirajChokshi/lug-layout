const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const VERSION = 20;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;

export function storedZip(files: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const utf8 = new TextEncoder();
  const encoded = files.map(([name, text]) => [utf8.encode(name), utf8.encode(text)] as const);
  const localBytes = encoded.reduce(
    (sum, [name, data]) => sum + LOCAL_HEADER_BYTES + name.length + data.length,
    0,
  );
  const centralBytes = encoded.reduce((sum, [name]) => sum + CENTRAL_HEADER_BYTES + name.length, 0);
  const out = new Uint8Array(localBytes + centralBytes + END_BYTES);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const [name, data] of encoded) {
    offsets.push(at);
    view.setUint32(at, LOCAL_HEADER, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint32(at + 18, data.length, true);
    view.setUint32(at + 22, data.length, true);
    view.setUint16(at + 26, name.length, true);
    out.set(name, at + LOCAL_HEADER_BYTES);
    out.set(data, at + LOCAL_HEADER_BYTES + name.length);
    at += LOCAL_HEADER_BYTES + name.length + data.length;
  }
  for (const [index, [name, data]] of encoded.entries()) {
    view.setUint32(at, CENTRAL_HEADER, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, VERSION, true);
    view.setUint32(at + 20, data.length, true);
    view.setUint32(at + 24, data.length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, offsets[index] ?? 0, true);
    out.set(name, at + CENTRAL_HEADER_BYTES);
    at += CENTRAL_HEADER_BYTES + name.length;
  }
  view.setUint32(at, END_OF_DIRECTORY, true);
  view.setUint16(at + 8, files.length, true);
  view.setUint16(at + 10, files.length, true);
  view.setUint32(at + 12, centralBytes, true);
  view.setUint32(at + 16, localBytes, true);
  return out;
}
