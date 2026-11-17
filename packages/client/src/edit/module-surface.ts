import type { PartAsset } from "@brr/catalog";
import { NO_TOP } from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { ChunkPartInstances } from "../scene/placements.ts";
import { BOX_FLOATS } from "./local-box.ts";

export interface ModuleSurface {
  readonly studs: number;
  readonly minX: number;
  readonly minZ: number;
  readonly plates: Int16Array;
  readonly colors: Int32Array;
}

function groundFootprint(
  instances: ChunkPartInstances,
  partBoxes: Float32Array,
  parts: ReadonlyArray<PartAsset>,
  label: string,
) {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < instances.count; i++) {
    if (parts[instances.partIndex[i] ?? 0]?.role !== "ground") continue;
    const b = i * BOX_FLOATS;
    minX = Math.min(minX, partBoxes[b] ?? 0);
    minZ = Math.min(minZ, partBoxes[b + 2] ?? 0);
    maxX = Math.max(maxX, partBoxes[b + 3] ?? 0);
    maxZ = Math.max(maxZ, partBoxes[b + 5] ?? 0);
  }
  const studsX = (maxX - minX) / STUD_LDU;
  const studsZ = (maxZ - minZ) / STUD_LDU;
  if (!Number.isInteger(studsX) || studsX !== studsZ) {
    throw new Error(
      `${label}: its baseplates span ${maxX - minX}×${maxZ - minZ} LDU, not a square of whole studs`,
    );
  }
  return { minX, minZ, studs: studsX };
}

export function moduleSurface(
  instances: ChunkPartInstances,
  partBoxes: Float32Array,
  ldrawColor: Uint16Array,
  parts: ReadonlyArray<PartAsset>,
  label: string,
): ModuleSurface {
  const { minX, minZ, studs } = groundFootprint(instances, partBoxes, parts, label);
  const topLdu = new Float64Array(studs * studs).fill(Number.NEGATIVE_INFINITY);
  const colors = new Int32Array(studs * studs);
  for (let i = 0; i < instances.count; i++) {
    const b = i * BOX_FLOATS;
    const top = partBoxes[b + 4] ?? 0;
    const fromColumn = Math.ceil(((partBoxes[b] ?? 0) - minX) / STUD_LDU - 0.5);
    const toColumn = Math.floor(((partBoxes[b + 3] ?? 0) - minX) / STUD_LDU - 0.5);
    const fromRow = Math.ceil(((partBoxes[b + 2] ?? 0) - minZ) / STUD_LDU - 0.5);
    const toRow = Math.floor(((partBoxes[b + 5] ?? 0) - minZ) / STUD_LDU - 0.5);
    for (let row = Math.max(0, fromRow); row <= Math.min(studs - 1, toRow); row++) {
      for (
        let column = Math.max(0, fromColumn);
        column <= Math.min(studs - 1, toColumn);
        column++
      ) {
        const cell = row * studs + column;
        if (top <= (topLdu[cell] ?? 0)) continue;
        topLdu[cell] = top;
        colors[cell] = ldrawColor[i] ?? 0;
      }
    }
  }
  const plates = Int16Array.from(topLdu, (top) =>
    Number.isInteger(top / PLATE_LDU) ? top / PLATE_LDU : NO_TOP,
  );
  return { studs, minX, minZ, plates, colors };
}
