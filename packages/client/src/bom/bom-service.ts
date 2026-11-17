import { PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import type { BundleLod, NotDrawnSection } from "@brr/schema/bundle";
import {
  brickLinkWantedListXml,
  plainBomCsv,
  rebrickableCsv,
  toCatalog,
  type BomCounter,
  type BomLine,
  type CatalogBom,
  type PlacementRegion,
  type UncountedItem,
} from "@brr/domain";
import { inject, injectable } from "inversify";

export type BomScope =
  | { readonly kind: "world" }
  | { readonly kind: "region"; readonly region: PlacementRegion }
  | { readonly kind: "selection" };

export function sceneRegion(scope: BomScope): PlacementRegion | null {
  switch (scope.kind) {
    case "world":
      return null;
    case "region":
      return scope.region;
    case "selection":
      throw new Error("this scene has no selection; choose World or Region");
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled scope ${String(unhandled)}`);
    }
  }
}

export interface BomInput {
  readonly name: string;
  readonly lod: BundleLod;
  readonly placements: number;
  readonly counter: BomCounter;
  readonly uncounted: ReadonlyArray<UncountedItem>;
}

function countedColors(
  section: NotDrawnSection,
): ReadonlyArray<{ readonly color: number; readonly instances: number }> {
  switch (section.kind) {
    case "customPart":
      return section.colors ?? [];
    case "looseGeometry":
      return [];
    default: {
      const unhandled: never = section;
      throw new Error(`unhandled not-drawn section ${JSON.stringify(unhandled)}`);
    }
  }
}

export function notDrawnItems(
  source: string,
  sections: ReadonlyArray<NotDrawnSection>,
  placements: number,
): UncountedItem[] {
  if (placements === 0) return [];
  return sections.flatMap((section): UncountedItem[] => {
    const reason = `${section.kind}: ${section.reason}`;
    const colors = countedColors(section);
    if (colors.length === 0) {
      return [{ source, item: section.section, ldrawColor: null, quantity: null, reason }];
    }
    return colors.map(({ color, instances }) => ({
      source,
      item: section.section,
      ldrawColor: color,
      quantity: instances * placements,
      reason,
    }));
  });
}

export interface IBomSource {
  bomInput(scope: BomScope): BomInput;
}

export interface BomFiles {
  readonly rebrickableCsv: string;
  readonly brickLinkXml: string;
  readonly plainCsv: string;
}

export interface BillOfMaterials {
  readonly name: string;
  readonly scope: BomScope;
  readonly placements: number;
  readonly parts: number;
  readonly ldraw: ReadonlyArray<BomLine>;
  readonly uncounted: ReadonlyArray<UncountedItem>;
  readonly rebrickable: CatalogBom;
  readonly bricklink: CatalogBom;
  readonly files: BomFiles;
}

export interface IBomService {
  billOfMaterials(source: IBomSource, scope: BomScope): Promise<BillOfMaterials>;
}

@injectable()
export class BomService implements IBomService {
  constructor(@inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader) {}

  async billOfMaterials(source: IBomSource, scope: BomScope): Promise<BillOfMaterials> {
    const input = source.bomInput(scope);
    const [crosswalk, { disclaimer }] = await Promise.all([
      this.loader.loadCrosswalk(input.lod),
      this.loader.loadManifest(input.lod),
    ]);
    const ldraw = input.counter.lines();
    const rebrickable = toCatalog(ldraw, crosswalk, "rebrickable");
    const bricklink = toCatalog(ldraw, crosswalk, "bricklink");
    return {
      name: input.name,
      scope,
      placements: input.placements,
      parts: input.counter.total(),
      ldraw,
      uncounted: input.uncounted,
      rebrickable,
      bricklink,
      files: {
        rebrickableCsv: rebrickableCsv(rebrickable.lines),
        brickLinkXml: brickLinkWantedListXml(bricklink.lines, disclaimer),
        plainCsv: plainBomCsv(ldraw, crosswalk, input.uncounted, disclaimer),
      },
    };
  }
}
