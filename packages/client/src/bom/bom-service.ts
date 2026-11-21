import { PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import type { BundleLod, NotDrawnSection } from "@brr/schema/bundle";
import {
  brickLinkWantedListXml,
  catalogOf,
  ownVsBuy,
  plainBomCsv,
  rebrickableCsv,
  resolveLines,
  type BomCounter,
  type BomLine,
  type CatalogBom,
  type Crosswalk,
  type OwnBuyLine,
  type OwnedParts,
  type PlacementRegion,
  type ResolvedLine,
  type UncountedItem,
  type UnknownOwnedPart,
} from "@brr/domain";
import { inject, injectable } from "inversify";

export type BomScope =
  | { readonly kind: "world" }
  | { readonly kind: "region"; readonly region: PlacementRegion }
  | { readonly kind: "selection" }
  | { readonly kind: "plan"; readonly planId: string };

export function sceneRegion(scope: BomScope): PlacementRegion | null {
  switch (scope.kind) {
    case "world":
      return null;
    case "region":
      return scope.region;
    case "selection":
      throw new Error("this scene has no selection; choose World or Region");
    case "plan":
      throw new Error("this scene has no plans; choose World or Region");
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
  readonly lod: BundleLod;
  readonly placements: number;
  readonly parts: number;
  readonly ldraw: ReadonlyArray<BomLine>;
  readonly uncounted: ReadonlyArray<UncountedItem>;
  readonly rebrickable: CatalogBom;
  readonly bricklink: CatalogBom;
  readonly files: BomFiles;
}

export interface OwnVsBuyReport {
  readonly lines: ReadonlyArray<OwnBuyLine>;
  readonly own: number;
  readonly buy: number;
  readonly unmatched: number;
  readonly custom: number;
  readonly unknown: ReadonlyArray<UnknownOwnedPart>;
  readonly shortfall: BomFiles;
}

export interface IBomService {
  billOfMaterials(source: IBomSource, scope: BomScope): Promise<BillOfMaterials>;
  ownVsBuy(bom: BillOfMaterials, owned: OwnedParts): Promise<OwnVsBuyReport>;
}

const NOTHING_UNCOUNTED: ReadonlyArray<UncountedItem> = [];

function catalogViews(
  resolved: ReadonlyArray<ResolvedLine>,
  uncounted: ReadonlyArray<UncountedItem>,
  crosswalk: Crosswalk,
  disclaimer: string,
): Pick<BillOfMaterials, "rebrickable" | "bricklink" | "files"> {
  const rebrickable = catalogOf(resolved, crosswalk, "rebrickable");
  const bricklink = catalogOf(resolved, crosswalk, "bricklink");
  return {
    rebrickable,
    bricklink,
    files: {
      rebrickableCsv: rebrickableCsv(rebrickable.lines),
      brickLinkXml: brickLinkWantedListXml(bricklink.lines, disclaimer),
      plainCsv: plainBomCsv(resolved, crosswalk, uncounted, disclaimer),
    },
  };
}

@injectable()
export class BomService implements IBomService {
  constructor(@inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader) {}

  private async crosswalkOf(
    lod: BundleLod,
  ): Promise<{ readonly crosswalk: Crosswalk; readonly disclaimer: string }> {
    const [crosswalk, { disclaimer }] = await Promise.all([
      this.loader.loadCrosswalk(lod),
      this.loader.loadManifest(lod),
    ]);
    return { crosswalk, disclaimer };
  }

  async billOfMaterials(source: IBomSource, scope: BomScope): Promise<BillOfMaterials> {
    const input = source.bomInput(scope);
    const { crosswalk, disclaimer } = await this.crosswalkOf(input.lod);
    const ldraw = input.counter.lines();
    return {
      name: input.name,
      scope,
      lod: input.lod,
      placements: input.placements,
      parts: input.counter.total(),
      ldraw,
      uncounted: input.uncounted,
      ...catalogViews(resolveLines(ldraw, crosswalk), input.uncounted, crosswalk, disclaimer),
    };
  }

  async ownVsBuy(bom: BillOfMaterials, owned: OwnedParts): Promise<OwnVsBuyReport> {
    const { crosswalk, disclaimer } = await this.crosswalkOf(bom.lod);
    const compared = ownVsBuy(resolveLines(bom.ldraw, crosswalk), crosswalk, owned);
    return {
      lines: compared.lines,
      own: compared.own,
      buy: compared.buy,
      unmatched: compared.unmatched,
      custom: compared.custom,
      unknown: compared.unknown,
      shortfall: catalogViews(compared.shortfall, NOTHING_UNCOUNTED, crosswalk, disclaimer).files,
    };
  }
}
