import type { PartAsset } from "@brr/catalog";
import {
  modelSpec,
  plateSpec,
  roadwaysOf,
  type ItemSpec,
  type LduRect,
  type ModuleStandards,
} from "@brr/domain";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { Placeable } from "./placeable.ts";

function plateRect(placeable: Placeable): LduRect {
  const { min, max } = placeable.box;
  return { minX: min[0], minZ: min[2], maxX: max[0], maxZ: max[2] };
}

function studPositions(placeable: Placeable): Array<readonly [number, number]> {
  const { matrices, count } = placeable.studs;
  const positions: Array<readonly [number, number]> = [];
  for (let i = 0; i < count; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    positions.push([matrices[o + 3] ?? 0, matrices[o + 11] ?? 0]);
  }
  return positions;
}

export function itemSpecOf(
  placeable: Placeable,
  parts: ReadonlyArray<PartAsset>,
  standards: ModuleStandards,
): ItemSpec {
  switch (placeable.kind) {
    case "model":
      return modelSpec(
        placeable.id,
        placeable.label,
        {
          count: placeable.parts.count,
          partIds: parts.map((part) => part.id),
          partIndex: placeable.parts.partIndex,
          colors: placeable.ldrawColors,
          boxes: placeable.partBoxes,
        },
        standards,
      );
    case "baseplate":
    case "road": {
      const rect = plateRect(placeable);
      return plateSpec(
        placeable.id,
        placeable.label,
        placeable.id,
        placeable.worldColor,
        rect,
        placeable.kind === "road" ? roadwaysOf(rect, studPositions(placeable)) : [],
        standards,
      );
    }
    default: {
      const unhandled: never = placeable.kind;
      throw new Error(`unhandled placeable kind ${String(unhandled)}`);
    }
  }
}
