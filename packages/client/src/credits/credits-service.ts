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
const CONNECTIVITY_USE =
  "tier 1 connectors, where parts snap together, from LDCad shadow files and their patches, precomputed for library parts and fetched file by file from the same pinned set when a custom part from your own imported file has its connectors read";
const SECTION_VOCABULARY = "Section vocabulary";
const SECTION_VOCABULARY_USE =
  "the connector section sizes and lengths that connectors inferred from part geometry are identified against";

function distinctCredits(
  name: string,
  usedFor: string,
  packages: ReadonlyArray<PackageAttribution | null>,
): ReadonlyArray<DataPackageCredit> {
  const distinct = new Map<string, PackageAttribution>();
  for (const attributed of packages) {
    if (attributed === null) continue;
    distinct.set(JSON.stringify([attributed.licenses, attributed.attribution]), attributed);
  }
  return [...distinct.values()].map(({ licenses, attribution }) => ({
    name,
    usedFor,
    licenses,
    attribution,
  }));
}

@injectable()
export class CreditsService implements ICredits {
  constructor(@inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader) {}

  async load(): Promise<CreditsView> {
    const [manifests, connectivity, vocabularies] = await Promise.all([
      Promise.all(
        BUNDLE_LODS.map(async (lod) => ({ lod, manifest: await this.loader.loadManifest(lod) })),
      ),
      Promise.all(BUNDLE_LODS.map((lod) => this.loader.loadConnectivityAttribution(lod))),
      Promise.all(BUNDLE_LODS.map((lod) => this.loader.loadSectionVocabularyAttribution(lod))),
    ]);
    return buildCredits(manifests, [
      ...distinctCredits(CONNECTIVITY_PACKAGE, CONNECTIVITY_USE, connectivity),
      ...distinctCredits(SECTION_VOCABULARY, SECTION_VOCABULARY_USE, vocabularies),
    ]);
  }

  exportText(view: CreditsView): string {
    return creditsText(view);
  }
}
