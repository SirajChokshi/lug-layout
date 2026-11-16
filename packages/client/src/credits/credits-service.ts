import { BUNDLE_LODS, PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import { inject, injectable } from "inversify";
import { buildCredits, creditsText, type CreditsView } from "./credits-view.ts";

export interface ICredits {
  load(): Promise<CreditsView>;
  exportText(view: CreditsView): string;
}

@injectable()
export class CreditsService implements ICredits {
  constructor(@inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader) {}

  async load(): Promise<CreditsView> {
    const manifests = await Promise.all(
      BUNDLE_LODS.map(async (lod) => ({ lod, manifest: await this.loader.loadManifest(lod) })),
    );
    return buildCredits(manifests);
  }

  exportText(view: CreditsView): string {
    return creditsText(view);
  }
}
