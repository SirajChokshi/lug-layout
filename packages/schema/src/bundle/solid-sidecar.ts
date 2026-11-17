import type { SolidSidecar } from "./index.ts";

const INT32_BYTES = 4;

export interface SolidSampleArrays {
  readonly lists: Int32Array;
  readonly patterns: Int32Array;
}

export function decodeSolidSidecar(
  bytes: ArrayBuffer,
  header: SolidSidecar,
  patternCount: number,
  samplesPerCell: number,
): SolidSampleArrays {
  const expected = (header.lists + header.patterns) * INT32_BYTES;
  if (bytes.byteLength !== expected) {
    throw new Error(`${header.file}: ${bytes.byteLength} bytes, expected ${expected}`);
  }
  if (header.patterns !== patternCount * samplesPerCell) {
    throw new Error(
      `${header.file}: ${header.patterns} sample pattern entries for ${patternCount} patterns`,
    );
  }
  const view = new DataView(bytes);
  const lists = new Int32Array(header.lists);
  for (let i = 0; i < header.lists; i++) lists[i] = view.getInt32(i * INT32_BYTES, true);
  const patterns = new Int32Array(header.patterns);
  const base = header.lists * INT32_BYTES;
  for (let i = 0; i < header.patterns; i++) {
    const offset = view.getInt32(base + i * INT32_BYTES, true);
    const count = lists[offset] ?? -1;
    if (offset < 0 || count < 0 || offset + 1 + 2 * count > header.lists) {
      throw new Error(`${header.file}: sample pattern entry ${i} points outside the span lists`);
    }
    patterns[i] = offset;
  }
  return { lists, patterns };
}
