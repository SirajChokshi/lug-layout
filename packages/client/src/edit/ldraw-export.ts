import { PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import {
  ldrawAffine,
  libraryReference,
  mpdText,
  type LdrawOriginal,
  type SubmodelLine,
} from "@brr/domain";
import type { BundleLod } from "@brr/schema/bundle";
import type { ImportedFile } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import type { IModelImporter } from "../import/worker-model-importer.ts";
import { LAYOUT_SUBMODELS, MODEL_IMPORTER, TRADEMARK_DISCLAIMER } from "../tokens.ts";
import { worldFileStem } from "./world-credits.ts";
import type { ExportedWorld } from "./world-session.ts";

export type LdrawSource =
  | { readonly kind: "library-part"; readonly path: string; readonly color: number }
  | { readonly kind: "bundle-model"; readonly lod: BundleLod; readonly name: string }
  | { readonly kind: "imported-model"; readonly sha256: string };

type ModelSource = Exclude<LdrawSource, { readonly kind: "library-part" }>;

export interface LdrawMember {
  readonly source: LdrawSource;
  readonly yUpAffine: Float64Array;
}

export interface LdrawLayout {
  readonly members: ReadonlyArray<LdrawMember>;
  readonly trainsOnRails: number;
}

export interface LayoutSubmodel {
  readonly name: string;
  readonly members: ReadonlyArray<LdrawMember>;
}

export interface ILayoutSubmodels {
  submodels(layout: LdrawLayout): ReadonlyArray<LayoutSubmodel>;
}

@injectable()
export class WholeLayoutSubmodel implements ILayoutSubmodels {
  submodels(layout: LdrawLayout): ReadonlyArray<LayoutSubmodel> {
    return [{ name: "Layout.ldr", members: layout.members }];
  }
}

export type ImportedFiles = (sha256: string) => ImportedFile | undefined;

export interface ILdrawExporter {
  exportMpd(
    worldName: string,
    layout: LdrawLayout,
    importedFile: ImportedFiles,
    credits: string,
  ): Promise<ExportedWorld>;
}

const TAG_DIGITS = 12;
const STUDIO_FILE = /\.io$/iu;

function sourceKey(source: ModelSource): string {
  return source.kind === "bundle-model"
    ? `bundle:${source.lod}:${source.name}`
    : `import:${source.sha256}`;
}

function memberLine({ source, yUpAffine }: LdrawMember): SubmodelLine {
  const affine = ldrawAffine(yUpAffine);
  if (source.kind === "library-part") {
    return { kind: "part", color: source.color, affine, reference: libraryReference(source.path) };
  }
  return { kind: "model", affine, original: sourceKey(source) };
}

function trainsNote(trains: number): ReadonlyArray<string> {
  if (trains === 0) return [];
  const left = trains === 1 ? "1 train on the rails isn't" : `${trains} trains on the rails aren't`;
  return [`${left} in this file: a train has no pose of its own, only where Play runs it.`];
}

@injectable()
export class LdrawExporter implements ILdrawExporter {
  constructor(
    @inject(LAYOUT_SUBMODELS) private readonly partition: ILayoutSubmodels,
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(MODEL_IMPORTER) private readonly importer: IModelImporter,
    @inject(TRADEMARK_DISCLAIMER) private readonly disclaimer: string,
  ) {}

  async exportMpd(
    worldName: string,
    layout: LdrawLayout,
    importedFile: ImportedFiles,
    credits: string,
  ): Promise<ExportedWorld> {
    const sources = new Map<string, ModelSource>();
    for (const { source } of layout.members) {
      if (source.kind !== "library-part") sources.set(sourceKey(source), source);
    }
    const originals: LdrawOriginal[] = [];
    for (const source of sources.values()) {
      originals.push(await this.original(source, importedFile));
    }
    const stem = worldFileStem(worldName);
    const text = mpdText({
      name: `${stem}.ldr`,
      title: worldName,
      notes: [
        "Exported from Brick Railroad.",
        this.disclaimer,
        ...trainsNote(layout.trainsOnRails),
        credits,
      ],
      submodels: this.partition.submodels(layout).map(({ name, members }) => ({
        name,
        lines: members.map(memberLine),
      })),
      originals,
    });
    return { fileName: `${stem}.mpd`, bytes: new TextEncoder().encode(text) };
  }

  private async original(source: ModelSource, importedFile: ImportedFiles): Promise<LdrawOriginal> {
    const key = sourceKey(source);
    if (source.kind === "bundle-model") {
      const [index, file] = await Promise.all([
        this.loader.loadIndex(source.lod),
        this.loader.loadModelLdraw(source.lod, source.name),
      ]);
      const sha256 = index.models.find((model) => model.name === source.name)?.sha256 ?? "";
      return { key, tag: sha256.slice(0, TAG_DIGITS), name: file.name, text: file.text };
    }
    const file = importedFile(source.sha256);
    if (!file) throw new Error(`the imported file with sha256 ${source.sha256} isn't loaded`);
    const tag = file.sha256.slice(0, TAG_DIGITS);
    if (!STUDIO_FILE.test(file.name)) {
      return { key, tag, name: file.name, text: new TextDecoder().decode(file.bytes) };
    }
    const studio = await this.importer.studioLdraw(file.name, file.bytes);
    const custom = studio.customFiles.flatMap(({ name, text }) => [`0 FILE ${name}`, text]);
    const name = file.name.replace(STUDIO_FILE, ".ldr");
    return { key, tag, name, text: [studio.text, ...custom].join("\n") };
  }
}
