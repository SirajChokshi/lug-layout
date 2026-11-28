import type { StudioRejection } from "@brr/schema/bundle";
import type { BrickCompiler } from "./brick-compiler.ts";
import type { CustomSource } from "./custom-parts.ts";
import type { StudioFileInput } from "./worker-protocol.ts";
import type { LdrawMirror } from "./ldraw-mirror.ts";
import {
  bundlePartId,
  IGNORE_PLACEMENT,
  type ImportResult,
  type ModelImportEngine,
  type PlacementListener,
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
      readonly customFiles: ReadonlyArray<CustomSource>;
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
    customFiles: archive.customFiles,
  };
}

export interface StudioLdraw {
  readonly fileName: string;
  readonly text: string;
  readonly customFiles: ReadonlyArray<CustomSource>;
}

async function preparedStudioFile(
  compiler: BrickCompiler,
  mirror: LdrawMirror,
  input: StudioFileInput,
): Promise<Extract<StudioPrepared, { readonly kind: "ready" }>> {
  const prepared = await prepareStudioImport(
    compiler,
    input.job.fileName,
    input.bytes,
    new BricklinkPartsCrosswalk(input.bricklinkParts),
    new MirrorPartExists(mirror, new Set(input.job.bundlePartIds)),
    new Set(input.job.ldconfigCodes),
  );
  if (prepared.kind === "rejected") throw new Error(prepared.rejection.message);
  return prepared;
}

export async function studioLdraw(
  compiler: BrickCompiler,
  mirror: LdrawMirror,
  input: StudioFileInput,
): Promise<StudioLdraw> {
  const prepared = await preparedStudioFile(compiler, mirror, input);
  return { fileName: prepared.fileName, text: prepared.ldraw, customFiles: prepared.customFiles };
}

export async function importStudioFile(
  engine: ModelImportEngine,
  compiler: BrickCompiler,
  mirror: LdrawMirror,
  input: StudioFileInput,
  onPlaced: PlacementListener = IGNORE_PLACEMENT,
): Promise<ImportResult> {
  const prepared = await preparedStudioFile(compiler, mirror, input);
  const result = await engine.importText(
    {
      ...input.job,
      fileName: prepared.fileName,
      text: prepared.ldraw,
    },
    onPlaced,
    prepared.customFiles,
  );
  return { ...result, studio: prepared.report };
}
