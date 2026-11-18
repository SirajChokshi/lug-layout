import {
  BUNDLE_LODS,
  PART_BUNDLE_LOADER,
  type IPartBundleLoader,
  type PackageAttribution,
} from "@brr/catalog";
import { inject, injectable } from "inversify";
import {
  buildCredits,
  creditsText,
  type CreditsView,
  type DataPackageCredit,
} from "./credits-view.ts";

export interface ICredits {
  load(): Promise<CreditsView>;
  exportText(view: CreditsView): string;
}

const CONNECTIVITY_PACKAGE = "Connectivity package";
const CONNECTIVITY_USE = "tier 1 connectors, where parts snap together, from LDCad shadow files";

function connectivityCredits(
  packages: ReadonlyArray<PackageAttribution>,
): ReadonlyArray<DataPackageCredit> {
  const distinct = new Map<string, PackageAttribution>();
  for (const attributed of packages) {
    distinct.set(JSON.stringify([attributed.licenses, attributed.attribution]), attributed);
  }
  return [...distinct.values()].map(({ licenses, attribution }) => ({
    name: CONNECTIVITY_PACKAGE,
    usedFor: CONNECTIVITY_USE,
    licenses,
    attribution,
  }));
}

@injectable()
export class CreditsService implements ICredits {
  constructor(@inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader) {}

  async load(): Promise<CreditsView> {
    const [manifests, connectivity] = await Promise.all([
      Promise.all(
        BUNDLE_LODS.map(async (lod) => ({ lod, manifest: await this.loader.loadManifest(lod) })),
      ),
      Promise.all(BUNDLE_LODS.map((lod) => this.loader.loadConnectivityAttribution(lod))),
    ]);
    return buildCredits(manifests, connectivityCredits(connectivity));
  }

  exportText(view: CreditsView): string {
    return creditsText(view);
  }
}
