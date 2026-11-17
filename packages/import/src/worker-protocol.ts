import type { ImportResult, ImportJob } from "./model-import.ts";

export interface LdrawTextInput {
  readonly kind: "ldraw";
  readonly job: ImportJob;
}

export type ImportInput = LdrawTextInput;

export interface ImportWorkerRequest {
  readonly id: number;
  readonly compilerUrl: string;
  readonly input: ImportInput;
}

export type ImportWorkerResponse =
  | { readonly id: number; readonly kind: "imported"; readonly model: ImportResult }
  | { readonly id: number; readonly kind: "failed"; readonly message: string };

export function transferablesOf(model: ImportResult): Transferable[] {
  return [
    model.partIndex.buffer,
    model.ldrawColor.buffer,
    model.matrices.buffer,
    ...model.compiled.map((part) => part.glb.buffer),
  ];
}
