import { PART_BUNDLE_LOADER, type BundleLod, type IPartBundleLoader } from "@brr/catalog";
import {
  brickLinkWantedListXml,
  plainBomCsv,
  rebrickableCsv,
  toCatalog,
  type BomCounter,
  type BomLine,
  type CatalogBom,
  type PlacementRegion,
} from "@brr/domain";
import { inject, injectable } from "inversify";

export type BomScope =
  | { readonly kind: "world" }
  | { readonly kind: "region"; readonly region: PlacementRegion };

export interface BomInput {
  readonly name: string;
  readonly lod: BundleLod;
  readonly placements: number;
  readonly counter: BomCounter;
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
    const crosswalk = await this.loader.loadCrosswalk(input.lod);
    const ldraw = input.counter.lines();
    const rebrickable = toCatalog(ldraw, crosswalk, "rebrickable");
    const bricklink = toCatalog(ldraw, crosswalk, "bricklink");
    return {
      name: input.name,
      scope,
      placements: input.placements,
      parts: input.counter.total(),
      ldraw,
      rebrickable,
      bricklink,
      files: {
        rebrickableCsv: rebrickableCsv(rebrickable.lines),
        brickLinkXml: brickLinkWantedListXml(bricklink.lines),
        plainCsv: plainBomCsv(ldraw, crosswalk),
      },
    };
  }
}
