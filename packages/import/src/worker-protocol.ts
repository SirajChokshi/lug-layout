import type { BricklinkPartCandidates } from "@brr/catalog";
import type { ImportResult, ImportJob, ModelBake } from "./model-import.ts";

export interface LdrawTextInput {
  readonly kind: "ldraw";
  readonly job: ImportJob;
}

export interface StudioFileInput {
  readonly kind: "studio";
  readonly job: Omit<ImportJob, "text">;
  readonly bytes: Uint8Array;
  readonly bricklinkParts: BricklinkPartCandidates;
}

export type ImportInput = LdrawTextInput | StudioFileInput;

export interface ImportWorkerRequest {
  readonly kind: "import";
  readonly compilerUrl: string;
  readonly ldrawLibraryUrl?: string;
  readonly input: ImportInput;
}

export type ImportWorkerResponse =
  | { readonly kind: "imported"; readonly model: ImportResult }
  | { readonly kind: "failed"; readonly message: string };

export function bakeTransferables(bake: ModelBake): Transferable[] {
  return [
    bake.studCover.visibleBits.buffer,
    ...(bake.cells
      ? [
          bake.cells.footprint.buffer,
          bake.cells.flat.buffer,
          bake.cells.columnBottom.buffer,
          bake.cells.columnTop.buffer,
        ]
      : []),
    ...bake.vehicles.flatMap((vehicle) => [
      vehicle.body.buffer,
      ...vehicle.bogies.map((bogie) => bogie.instances.buffer),
    ]),
  ];
}

export function transferablesOf(model: ImportResult): Transferable[] {
  return [
    model.partIndex.buffer,
    model.ldrawColor.buffer,
    model.matrices.buffer,
    ...model.compiled.map((part) => part.glb.buffer),
    ...(model.bake ? bakeTransferables(model.bake) : []),
  ];
}
