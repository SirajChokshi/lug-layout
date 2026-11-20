import type { BricklinkPartCandidates } from "@brr/catalog";
import type { UnreadBandDiagnostic } from "@brr/schema/bundle";
import type { ConnectorIndexPaths, PartConnectors } from "@brr/catalog/connector-records";
import type { LibraryConnectorsIndexRef, ShadowLibraryIndexRef } from "@brr/schema/bundle";
import type { PinnedRecords } from "./library-bake-store.ts";
import type { ImportResult, ImportJob, ModelBake, PlacedImport } from "./model-import.ts";

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

export interface LibraryBakeSource {
  readonly url: string;
  readonly pin: PinnedRecords;
}

export interface LibraryConnectorsSource {
  readonly url: string;
  readonly pin: LibraryConnectorsIndexRef;
}

export interface ShadowLibrarySource {
  readonly url: string;
  readonly pin: ShadowLibraryIndexRef;
}

export interface ImportWorkerRequest {
  readonly kind: "import";
  readonly ticket: number;
  readonly compilerUrl: string;
  readonly bundleBaseUrl: string;
  readonly connectorIndexes: ConnectorIndexPaths;
  readonly connectorVocabulary: string;
  readonly ldrawLibraryUrl?: string;
  readonly libraryBake?: LibraryBakeSource;
  readonly libraryConnectors?: LibraryConnectorsSource;
  readonly shadowLibrary?: ShadowLibrarySource;
  readonly input: ImportInput;
}

export interface RollingDiagnosticsRequest {
  readonly kind: "rollingDiagnostics";
  readonly libraryBake: LibraryBakeSource;
  readonly partIds: ReadonlyArray<string>;
}

export type RollingDiagnosticsRows = Readonly<Record<string, ReadonlyArray<UnreadBandDiagnostic>>>;

export type ImportWorkerResponse =
  | { readonly kind: "imported"; readonly model: ImportResult }
  | { readonly kind: "rollingDiagnostics"; readonly rows: RollingDiagnosticsRows }
  | { readonly kind: "failed"; readonly message: string };

export interface ImportWorkerPlaced {
  readonly kind: "placed";
  readonly ticket: number;
  readonly placed: PlacedImport;
}

export function bakeTransferables(bake: ModelBake): Transferable[] {
  return [
    bake.studCover.visibleBits.buffer,
    ...(bake.cells
      ? [
          bake.cells.footprint.buffer,
          bake.cells.flat.buffer,
          bake.cells.columnBottom.buffer,
          bake.cells.columnTop.buffer,
          ...(bake.cells.partCells
            ? [
                bake.cells.partCells.start.buffer,
                bake.cells.partCells.instance.buffer,
                bake.cells.partCells.cellBox.buffer,
                bake.cells.partCells.heightBox.buffer,
              ]
            : []),
        ]
      : []),
    ...bake.vehicles.flatMap((vehicle) => [
      vehicle.body.buffer,
      ...vehicle.bogies.map((bogie) => bogie.instances.buffer),
    ]),
  ];
}

function connectorBuffers(connectors: PartConnectors): ArrayBufferLike[] {
  return [
    connectors.gender,
    connectors.source,
    connectors.status,
    connectors.caps,
    connectors.slide,
    connectors.origin,
    connectors.axis,
    connectors.sectionStart,
    connectors.sectionCount,
    connectors.sectionCode,
    connectors.sectionSize,
    connectors.sectionLength,
    connectors.piece,
    connectors.freeFace,
    connectors.freeOrigin,
    connectors.freeAxis,
  ].map((array) => array.buffer);
}

export function transferablesOf(model: ImportResult): Transferable[] {
  return [
    model.partIndex.buffer,
    model.ldrawColor.buffer,
    model.matrices.buffer,
    model.partTransforms.buffer,
    model.submodels.parent.buffer,
    model.submodels.matrices.buffer,
    model.submodels.ofPart.buffer,
    ...model.compiled.map((part) => part.glb.buffer),
    ...model.connectors.flatMap((connectors) => (connectors ? connectorBuffers(connectors) : [])),
    ...(model.bake ? bakeTransferables(model.bake) : []),
  ];
}
