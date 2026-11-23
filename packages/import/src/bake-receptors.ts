import type { PartConnectors } from "@brr/catalog";
import { AXIS_FREE, GENDER_FEMALE } from "@brr/domain";

export interface BakeReceptors {
  readonly instanceParts: Uint32Array;
  readonly partStarts: Uint32Array;
  readonly sixteenths: Int32Array;
  readonly directions: Uint8Array;
  readonly caps: Uint8Array;
  readonly slides: Uint8Array;
  readonly groups: ReadonlyArray<string>;
  readonly sectionStarts: Uint32Array;
  readonly sectionCodes: Uint8Array;
  readonly sectionSizes: Float64Array;
  readonly sectionLengths: Float64Array;
}

const COORDINATES = 3;

function isAxialReceptor(part: PartConnectors, connector: number): boolean {
  return (
    part.gender[connector] === GENDER_FEMALE && (part.axis[connector] ?? AXIS_FREE) !== AXIS_FREE
  );
}

interface ReceptorCounts {
  readonly receptors: number;
  readonly sections: number;
}

function receptorCounts(part: PartConnectors | null): ReceptorCounts {
  let receptors = 0;
  let sections = 0;
  if (part === null) return { receptors, sections };
  for (let k = 0; k < part.count; k++) {
    if (!isAxialReceptor(part, k)) continue;
    receptors++;
    sections += part.sectionCount[k] ?? 0;
  }
  return { receptors, sections };
}

export function bakeReceptors(
  instanceParts: Uint32Array,
  parts: ReadonlyArray<PartConnectors | null>,
): BakeReceptors {
  const partStarts = new Uint32Array(parts.length + 1);
  let sectionTotal = 0;
  for (let p = 0; p < parts.length; p++) {
    const counts = receptorCounts(parts[p] ?? null);
    partStarts[p + 1] = (partStarts[p] ?? 0) + counts.receptors;
    sectionTotal += counts.sections;
  }
  const receptors = partStarts[parts.length] ?? 0;
  const sixteenths = new Int32Array(receptors * COORDINATES);
  const directions = new Uint8Array(receptors);
  const caps = new Uint8Array(receptors);
  const slides = new Uint8Array(receptors);
  const groups: string[] = [];
  const sectionStarts = new Uint32Array(receptors + 1);
  const sectionCodes = new Uint8Array(sectionTotal);
  const sectionSizes = new Float64Array(sectionTotal);
  const sectionLengths = new Float64Array(sectionTotal);
  let receptor = 0;
  let section = 0;
  for (const part of parts) {
    if (part === null) continue;
    for (let k = 0; k < part.count; k++) {
      if (!isAxialReceptor(part, k)) continue;
      sixteenths.set(
        part.origin.subarray(k * COORDINATES, (k + 1) * COORDINATES),
        receptor * COORDINATES,
      );
      directions[receptor] = part.axis[k] ?? AXIS_FREE;
      caps[receptor] = part.caps[k] ?? 0;
      slides[receptor] = part.slide[k] ?? 0;
      groups.push(part.group[k] ?? "");
      const from = part.sectionStart[k] ?? 0;
      const to = from + (part.sectionCount[k] ?? 0);
      sectionCodes.set(part.sectionCode.subarray(from, to), section);
      sectionSizes.set(part.sectionSize.subarray(from, to), section);
      sectionLengths.set(part.sectionLength.subarray(from, to), section);
      section += to - from;
      receptor++;
      sectionStarts[receptor] = section;
    }
  }
  return {
    instanceParts,
    partStarts,
    sixteenths,
    directions,
    caps,
    slides,
    groups,
    sectionStarts,
    sectionCodes,
    sectionSizes,
    sectionLengths,
  };
}
