import type { BrickCompiler, StudioRejection } from "./brick-compiler.ts";
import type { LdrawMirror } from "./ldraw-mirror.ts";
import {
  mapStudioParts,
  type BricklinkToLdraw,
  type LdrawPartExists,
  type StudioColor,
  type StudioFlexibleSection,
  type StudioPart,
} from "./studio-mapping.ts";

export interface StudioReport {
  readonly file: string;
  readonly entry: string;
  readonly studioVersion: string | null;
  readonly convertedLines: number;
  readonly unconvertedLines: ReadonlyArray<number>;
  readonly parts: ReadonlyArray<StudioPart>;
  readonly unknownColors: ReadonlyArray<StudioColor>;
  readonly flexibleSections: ReadonlyArray<StudioFlexibleSection>;
}

export type StudioPrepared =
  | { readonly kind: "rejected"; readonly file: string; readonly rejection: StudioRejection }
  | {
      readonly kind: "ready";
      readonly fileName: string;
      readonly ldraw: string;
      readonly report: StudioReport;
    };

const LIBRARY_PART_DIRECTORY = "parts/";

export class MirrorPartExists implements LdrawPartExists {
  constructor(private readonly mirror: LdrawMirror) {}

  async isLdrawPart(reference: string): Promise<boolean> {
    return (await this.mirror.file(`${LIBRARY_PART_DIRECTORY}${reference}`)) !== undefined;
  }
}

export async function prepareStudioImport(
  compiler: BrickCompiler,
  file: string,
  bytes: Uint8Array,
  crosswalk: BricklinkToLdraw,
  exists: LdrawPartExists,
  knownColors: ReadonlySet<number>,
): Promise<StudioPrepared> {
  const archive = await compiler.readStudio(bytes);
  if (archive.status === "rejected") return { kind: "rejected", file, rejection: archive };
  const mapping = await mapStudioParts(archive, crosswalk, exists, knownColors);
  return {
    kind: "ready",
    fileName: `${file}!${archive.entry}`,
    ldraw: mapping.ldraw,
    report: {
      file,
      entry: archive.entry,
      studioVersion: archive.studioVersion,
      convertedLines: archive.convertedLines,
      unconvertedLines: archive.unconvertedLines,
      parts: mapping.parts,
      unknownColors: mapping.unknownColors,
      flexibleSections: mapping.flexibleSections,
    },
  };
}
