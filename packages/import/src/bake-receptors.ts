import type { PartConnectors } from "@brr/catalog";
import { AXIS_FREE, GENDER_FEMALE } from "@brr/domain";

export interface BakeReceptors {
  readonly instanceParts: Uint32Array;
  readonly partStarts: Uint32Array;
  readonly sixteenths: Int32Array;
  readonly directions: Uint8Array;
}

const COORDINATES = 3;

function isAxialReceptor(part: PartConnectors, connector: number): boolean {
  return (
    part.gender[connector] === GENDER_FEMALE && (part.axis[connector] ?? AXIS_FREE) !== AXIS_FREE
  );
}

function receptorCount(part: PartConnectors | null): number {
  if (part === null) return 0;
  let count = 0;
  for (let k = 0; k < part.count; k++) {
    if (isAxialReceptor(part, k)) count++;
  }
  return count;
}

export function bakeReceptors(
  instanceParts: Uint32Array,
  parts: ReadonlyArray<PartConnectors | null>,
): BakeReceptors {
  const partStarts = new Uint32Array(parts.length + 1);
  for (let p = 0; p < parts.length; p++) {
    partStarts[p + 1] = (partStarts[p] ?? 0) + receptorCount(parts[p] ?? null);
  }
  const receptors = partStarts[parts.length] ?? 0;
  const sixteenths = new Int32Array(receptors * COORDINATES);
  const directions = new Uint8Array(receptors);
  let receptor = 0;
  for (const part of parts) {
    if (part === null) continue;
    for (let k = 0; k < part.count; k++) {
      if (!isAxialReceptor(part, k)) continue;
      sixteenths.set(
        part.origin.subarray(k * COORDINATES, (k + 1) * COORDINATES),
        receptor * COORDINATES,
      );
      directions[receptor] = part.axis[k] ?? AXIS_FREE;
      receptor++;
    }
  }
  return { instanceParts, partStarts, sixteenths, directions };
}
