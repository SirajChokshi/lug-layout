import type { Placeable } from "../edit/placeable.ts";
import type { IPlaceableCatalog } from "./placeable-catalog.ts";

export async function loadCatalogItem(
  catalog: Pick<IPlaceableCatalog, "itemRefId" | "load">,
  itemId: string,
): Promise<Placeable> {
  const refId = catalog.itemRefId(itemId);
  if (refId === null) throw new Error(`${itemId} isn't in the catalog`);
  return catalog.load(refId);
}
