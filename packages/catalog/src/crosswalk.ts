import type { CrosswalkFile, ManifestPart } from "@brr/schema/bundle";
import type { CatalogCrosswalk } from "./part-bundle.ts";

const BRICKLINK_FROM_KEYWORD = "ldraw-keyword";

export function crosswalkMaps(
  file: CrosswalkFile,
  parts: ReadonlyArray<Pick<ManifestPart, "id" | "thirdParty">>,
): CatalogCrosswalk {
  return {
    thirdParty: new Map(
      parts.flatMap((part) => (part.thirdParty ? [[part.id, part.thirdParty.vendor]] : [])),
    ),
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
