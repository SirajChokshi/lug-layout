import type { BundleLod, BundleManifest, BundleModelEntry, BundleSource } from "@brr/schema/bundle";

export interface CreditedFile {
  readonly path: string;
  readonly title: string;
  readonly author: string;
}

export interface AuthorCredit {
  readonly name: string;
  readonly files: number;
}

export interface LicenseGroup {
  readonly license: string | null;
  readonly authors: ReadonlyArray<AuthorCredit>;
  readonly files: ReadonlyArray<CreditedFile>;
}

export interface BundleBuild {
  readonly lod: BundleLod;
  readonly bundleVersion: string;
  readonly modified: string;
}

export interface SetCredit {
  readonly name: string;
  readonly title: string | null;
  readonly year: number | null;
  readonly setSource: string | null;
  readonly authors: ReadonlyArray<string>;
  readonly licenses: ReadonlyArray<string>;
  readonly sections: number;
  readonly instances: number;
  readonly inlinePartsResolved: number;
  readonly source: string;
}

export interface GeneratedModelCredit {
  readonly name: string;
  readonly authors: ReadonlyArray<string>;
  readonly source: string;
}

export interface CustomPartCredit {
  readonly reference: string;
  readonly title: string;
  readonly author: string;
  readonly license: string | null;
}

export interface ImportedModelCredit {
  readonly name: string;
  readonly sha256: string;
  readonly authors: ReadonlyArray<string>;
  readonly licenses: ReadonlyArray<string>;
  readonly customParts: ReadonlyArray<CustomPartCredit>;
}

export interface DataSourceCredit {
  readonly source: string;
  readonly usedFor: ReadonlyArray<string>;
}

export interface DataPackageCredit {
  readonly name: string;
  readonly usedFor: string;
  readonly licenses: ReadonlyArray<string>;
  readonly attribution: ReadonlyArray<string>;
}

export interface CreditCounts {
  readonly bundlePartFiles: number;
  readonly creditedPartFiles: number;
  readonly creditedLdrawFiles: number;
  readonly bundledOmrModels: number;
  readonly creditedOmrModels: number;
}

export interface CreditsView {
  readonly builds: ReadonlyArray<BundleBuild>;
  readonly ldrawSource: BundleSource;
  readonly omrSource: BundleSource;
  readonly licenses: ReadonlyArray<LicenseGroup>;
  readonly sets: ReadonlyArray<SetCredit>;
  readonly generated: ReadonlyArray<GeneratedModelCredit>;
  readonly imported: ReadonlyArray<ImportedModelCredit>;
  readonly dataSources: ReadonlyArray<DataSourceCredit>;
  readonly dataPackages: ReadonlyArray<DataPackageCredit>;
  readonly counts: CreditCounts;
  readonly disclaimer: string;
}

export interface LodManifest {
  readonly lod: BundleLod;
  readonly manifest: BundleManifest;
}

function byCountThenName(a: AuthorCredit, b: AuthorCredit): number {
  return b.files - a.files || a.name.localeCompare(b.name);
}

interface LicensedFile extends CreditedFile {
  readonly license: string | null;
}

function licenseGroups(files: ReadonlyMap<string, LicensedFile>): LicenseGroup[] {
  const groups = new Map<string | null, CreditedFile[]>();
  for (const { license, ...file } of files.values()) {
    const group = groups.get(license) ?? [];
    group.push(file);
    groups.set(license, group);
  }
  return [...groups]
    .map(([license, group]): LicenseGroup => {
      const authors = new Map<string, number>();
      for (const file of group) authors.set(file.author, (authors.get(file.author) ?? 0) + 1);
      return {
        license,
        authors: [...authors]
          .map(([name, count]) => ({ name, files: count }))
          .toSorted(byCountThenName),
        files: group.toSorted((a, b) => a.path.localeCompare(b.path)),
      };
    })
    .toSorted((a, b) => b.files.length - a.files.length);
}

function addUse(sources: Map<string, string[]>, source: string, use: string): void {
  const uses = sources.get(source) ?? [];
  if (!uses.includes(use)) uses.push(use);
  sources.set(source, uses);
}

function firstManifest(manifests: ReadonlyArray<LodManifest>): BundleManifest {
  const first = manifests[0];
  if (!first) throw new Error("credits need at least one bundle manifest");
  return first.manifest;
}

export function buildCredits(
  manifests: ReadonlyArray<LodManifest>,
  dataPackages: ReadonlyArray<DataPackageCredit>,
): CreditsView {
  const reference = firstManifest(manifests);
  const credited = new Map<string, LicensedFile>();
  const partPaths = new Set<string>();
  const models = new Map<string, BundleModelEntry>();
  const dataSources = new Map<string, string[]>();
  for (const { manifest } of manifests) {
    for (const credit of manifest.credits) {
      if (!credited.has(credit.path)) credited.set(credit.path, credit);
    }
    for (const part of [...manifest.parts, ...manifest.studPrimitives]) partPaths.add(part.path);
    for (const part of manifest.parts) {
      if (part.displayColor)
        addUse(dataSources, part.displayColor.source, `display colour of ${part.id}`);
    }
    for (const model of manifest.models) if (!models.has(model.name)) models.set(model.name, model);
  }
  const sets: SetCredit[] = [];
  const generated: GeneratedModelCredit[] = [];
  for (const model of models.values()) {
    if (model.set) addUse(dataSources, model.set.source, `name and year of set ${model.name}`);
    switch (model.origin) {
      case "omr":
        sets.push({
          name: model.name,
          title: model.set?.name ?? null,
          year: model.set?.year ?? null,
          setSource: model.set?.source ?? null,
          authors: model.authors,
          licenses: model.licenses,
          sections: model.sections.length,
          instances: model.instances,
          inlinePartsResolved: model.inlinePartsResolvedToOfficial.length,
          source: model.source,
        });
        break;
      case "generated":
        generated.push({ name: model.name, authors: model.authors, source: model.source });
        break;
      default: {
        const unhandled: never = model.origin;
        throw new Error(`unhandled model origin ${String(unhandled)}`);
      }
    }
  }
  const creditedPartFiles = [...partPaths].filter((path) => credited.has(path)).length;
  return {
    builds: manifests.map(({ lod, manifest }) => ({
      lod,
      bundleVersion: manifest.bundleVersion,
      modified: manifest.modified,
    })),
    ldrawSource: reference.inputs.ldraw,
    omrSource: reference.inputs.omr,
    licenses: licenseGroups(credited),
    sets,
    generated,
    imported: [],
    dataSources: [...dataSources].map(([source, usedFor]) => ({ source, usedFor })),
    dataPackages,
    counts: {
      bundlePartFiles: partPaths.size,
      creditedPartFiles,
      creditedLdrawFiles: credited.size,
      bundledOmrModels: sets.length,
      creditedOmrModels: sets.filter((set) => set.authors.length > 0).length,
    },
    disclaimer: reference.disclaimer,
  };
}

export function sourceText(source: BundleSource): string {
  return `github.com/${source.repo} at commit ${source.commit} (${source.root}/)`;
}

export function licenseText(license: string | null): string {
  return license ?? "No !LICENSE line in the file";
}

export function setTitle(set: SetCredit): string {
  const year = set.year === null ? "" : ` (${set.year})`;
  return set.title === null ? set.name : `${set.name} ${set.title}${year}`;
}

function filesText(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

function importedLines(models: ReadonlyArray<ImportedModelCredit>): string[] {
  return models.flatMap((model) => [
    `  ${model.name} (sha256 ${model.sha256})`,
    `    Authors: ${model.authors.join("; ") || "none given"}`,
    `    License: ${model.licenses.join("; ") || "none given"}`,
    ...(model.customParts.length === 0
      ? []
      : [
          "    Custom parts, compiled from this file and drawn only on the device that opens it:",
          ...model.customParts.map(
            (part) =>
              `      ${part.reference}: ${part.title}, by ${part.author || "no author given"}, ${licenseText(part.license)}`,
          ),
        ]),
  ]);
}

export function creditsText(view: CreditsView): string {
  const lines: string[] = [
    "Brick Railroad credits",
    "",
    view.disclaimer,
    "",
    "Asset bundle versions:",
    ...view.builds.map((build) => `  ${build.lod}: ${build.bundleVersion}`),
    "",
    "LDraw parts library",
    `Source: ${sourceText(view.ldrawSource)}`,
    "LDraw parts are copyright their authors and are redistributed under the license named in each file's !LICENSE header.",
    "Modified from LDraw, per bundle level of detail:",
    ...view.builds.map((build) => `  ${build.lod}: ${build.modified}`),
    `${view.counts.creditedLdrawFiles} LDraw files credited.`,
  ];
  for (const group of view.licenses) {
    lines.push("", `License: ${licenseText(group.license)} (${filesText(group.files.length)})`);
    lines.push("  Authors:");
    for (const author of group.authors)
      lines.push(`    ${author.name} (${filesText(author.files)})`);
    lines.push("  Files:");
    for (const file of group.files)
      lines.push(`    ${file.path}: ${file.title}, by ${file.author}`);
  }
  lines.push("", "LDraw Official Model Repository models", `Source: ${sourceText(view.omrSource)}`);
  for (const set of view.sets) {
    lines.push(
      "",
      setTitle(set),
      `  Authors: ${set.authors.join("; ")}`,
      `  License: ${set.licenses.join("; ")}`,
      `  ${set.sections} submodel sections, ${set.instances} part instances, ${set.inlinePartsResolved} inline part copies replaced by the official part`,
      `  File: ${set.source}`,
    );
    if (set.setSource !== null) lines.push(`  Set name and year: ${set.setSource}`);
  }
  if (view.generated.length > 0) {
    lines.push("", "Generated scenes");
    for (const scene of view.generated) {
      lines.push(`  ${scene.name}: ${scene.authors.join("; ")}. ${scene.source}`);
    }
  }
  if (view.imported.length > 0) lines.push("", "Imported models", ...importedLines(view.imported));
  lines.push("", "Connector data");
  for (const data of view.dataPackages) {
    lines.push(
      `  ${data.name}: ${data.usedFor}`,
      `    License: ${data.licenses.join("; ")}`,
      ...data.attribution.map((line) => `    ${line}`),
    );
  }
  lines.push("", "Set and colour data");
  for (const data of view.dataSources) {
    lines.push(`  ${data.source}`, `    used for: ${data.usedFor.join(", ")}`);
  }
  lines.push("", view.disclaimer, "");
  return lines.join("\n");
}
