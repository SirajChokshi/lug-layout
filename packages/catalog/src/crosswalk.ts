import type { CrosswalkFile } from "@brr/schema/bundle";
import type { CatalogCrosswalk } from "./part-bundle.ts";

const BRICKLINK_FROM_KEYWORD = "ldraw-keyword";

export function crosswalkMaps(file: CrosswalkFile): CatalogCrosswalk {
  return {
    parts: new Map(
      Object.entries(file.parts).map(([id, ids]) => [
        id,
        {
          rebrickable: ids.rebrickable,
          bricklink: ids.bricklink,
          ...(ids.via.bricklink === BRICKLINK_FROM_KEYWORD
            ? { bricklinkFromKeywordOnly: true }
            : {}),
          ...(ids.components ? { components: ids.components } : {}),
        },
      ]),
    ),
    colors: new Map(
      Object.entries(file.colors).map(([code, ids]) => [
        Number(code),
        { rebrickable: ids.rebrickable, bricklink: ids.bricklink },
      ]),
    ),
  };
}
