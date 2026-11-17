import type { PartAsset } from "@brr/catalog";
import {
  modelSpec,
  plateSpec,
  roadwaysOf,
  type ItemSpec,
  type LduRect,
  type ModuleStandards,
} from "@brr/domain";
import type { Placeable } from "./placeable.ts";

function plateRect(placeable: Placeable): LduRect {
  const { min, max } = placeable.box;
  return { minX: min[0], minZ: min[2], maxX: max[0], maxZ: max[2] };
}

export function itemSpecOf(
  placeable: Placeable,
  parts: ReadonlyArray<PartAsset>,
  standards: ModuleStandards,
): ItemSpec {
  switch (placeable.kind) {
    case "model":
    case "road-module": {
      const spec = modelSpec(
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
      return placeable.road
        ? { ...spec, roadways: roadwaysOf(plateRect(placeable), placeable.road) }
        : spec;
    }
    case "baseplate":
    case "road-plate": {
      const rect = plateRect(placeable);
      return plateSpec(
        placeable.id,
        placeable.label,
        placeable.id,
        placeable.worldColor,
        rect,
        placeable.road ? roadwaysOf(rect, placeable.road) : [],
        standards,
      );
    }
    default: {
      const unhandled: never = placeable.kind;
      throw new Error(`unhandled placeable kind ${String(unhandled)}`);
    }
  }
}
