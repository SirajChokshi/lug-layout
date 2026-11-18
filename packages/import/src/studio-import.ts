import type { StudioRejection } from "@brr/schema/bundle";
import type { BrickCompiler } from "./brick-compiler.ts";
import type { StudioFileInput } from "./worker-protocol.ts";
import type { LdrawMirror } from "./ldraw-mirror.ts";
import {
  bundlePartId,
  ModelImportEngine,
  type ImportResult,
  type PartConnectorSource,
} from "./model-import.ts";
import {
  BricklinkPartsCrosswalk,
  mapStudioParts,
  type BricklinkToLdraw,
  type LdrawPartExists,
  type StudioColor,
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
  constructor(
    private readonly mirror: LdrawMirror,
    private readonly bundlePartIds: ReadonlySet<string>,
  ) {}

  async isLdrawPart(reference: string): Promise<boolean> {
    if (this.bundlePartIds.has(bundlePartId(reference))) return true;
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
  const archive = compiler.readStudio(bytes);
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
    },
  };
}

export async function importStudioFile(
  compiler: BrickCompiler,
  mirror: LdrawMirror,
  connectors: PartConnectorSource,
  now: () => number,
  input: StudioFileInput,
): Promise<ImportResult> {
  const prepared = await prepareStudioImport(
    compiler,
    input.job.fileName,
    input.bytes,
    new BricklinkPartsCrosswalk(input.bricklinkParts),
    new MirrorPartExists(mirror, new Set(input.job.bundlePartIds)),
    new Set(input.job.ldconfigCodes),
  );
  if (prepared.kind === "rejected") throw new Error(prepared.rejection.message);
  const result = await new ModelImportEngine(compiler, mirror, connectors, now).importText({
    ...input.job,
    fileName: prepared.fileName,
    text: prepared.ldraw,
  });
  return { ...result, studio: prepared.report };
}
