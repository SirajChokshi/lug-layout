import type { ModelCells, ModelStudCover, PartModelLattice, PartVehicle } from "@brr/catalog";
import type { BakeReceptors } from "./bake-receptors.ts";
import {
  type AuthoredIdentification,
  CompilerBake,
  CompilerBakeNeeds,
  CompilerCompile,
  type BakeShard,
  CompilerError,
  CompilerModelRead,
  StudioRead,
  type CompilerBaked,
  type CompilerBakePhases,
  type CompilerBlobs,
  type CompilerConnectorInputs,
  type CompilerEnvelope,
  type CompilerLibraryDelta,
  type CompilerRecordDelta,
  type CompilerRequest,
  type CompilerVehicle,
  type CompilerVehicles,
  type ModelSection,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { WasiReactor } from "./wasi-reactor.ts";

export type CompileLod = Extract<CompilerRequest, { op: "compile" }>["lod"];

export type LdrawHeader = ModelSection;

export interface LooseGeometry {
  readonly section: string;
  readonly triangles: number;
  readonly quads: number;
  readonly occurrences: number;
}

export interface InlinePart {
  readonly inline: string;
  readonly official: string;
}

export interface ModelRead {
  readonly sections: ReadonlyArray<LdrawHeader>;
  readonly parts: ReadonlyArray<string>;
  readonly inlineParts: ReadonlyArray<InlinePart>;
  readonly looseGeometry: ReadonlyArray<LooseGeometry>;
  readonly instancePart: Uint32Array;
  readonly instanceColor: Uint32Array;
  readonly instanceTransform: Float64Array;
  readonly instanceSubmodel: Int32Array;
  readonly submodelParent: Int32Array;
  readonly submodelMatrix: Float64Array;
  readonly authoredIdentification: AuthoredIdentification | null;
}

export interface ModelBakeOptions {
  readonly omrAuthoringIdentification?: boolean;
}

export interface LibraryFiles {
  readonly key: string;
  readonly files: ReadonlyMap<string, string>;
  readonly absent: ReadonlySet<string>;
}

export interface RecordFiles {
  readonly key: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface CompileRequest {
  readonly lod: CompileLod;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly connectors: CompilerConnectorInputs;
  readonly parts: ReadonlyArray<string>;
  readonly model: string;
  readonly inlineChecks: ReadonlyArray<InlinePart>;
  readonly records?: boolean;
}

type RawCompile = CompilerCompile;
type RawPartOutcome = RawCompile["parts"][number];
type RawInlineOutcome = RawCompile["inline"][number];

export type Failure = Omit<Extract<RawPartOutcome, { status: "failed" }>, "reference">;
export type FailureKind = Failure["kind"];
export type Need = Omit<Extract<RawPartOutcome, { status: "need" }>, "reference">;

export type PartOutcome =
  | Exclude<RawPartOutcome, { status: "compiled" }>
  | (Omit<Extract<RawPartOutcome, { status: "compiled" }>, "glb" | "record"> & {
      readonly glb: Uint8Array;
      readonly record: Uint8Array | null;
    });

export type InlineOutcome = RawInlineOutcome;

export interface CompileOutput {
  readonly parts: ReadonlyArray<PartOutcome>;
  readonly inline: ReadonlyArray<InlineOutcome>;
  readonly weldEpsilonLdu: number;
}

export interface BakeInputs {
  readonly source: string;
  readonly drawn: Uint8Array;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly translucentColors: ReadonlyArray<number>;
  readonly tableDepthLdu: number;
  readonly vehicles: CompilerVehicles | null;
  readonly keepParts?: boolean;
  readonly omrAuthoringIdentification?: boolean;
}

export interface VisibilityBakeRequest extends BakeInputs {
  readonly shard: BakeShard & { readonly visibilityOnly: true };
  readonly receptors?: never;
}

export interface PlacementBakeRequest extends BakeInputs {
  readonly shard?: BakeShard & { readonly visibilityOnly: false };
  readonly receptors: BakeReceptors;
}

export type BakeRequest = VisibilityBakeRequest | PlacementBakeRequest;

export type BakePhases = CompilerBakePhases;

export interface BakedModel {
  readonly status: "baked";
  readonly recordedParts: number;
  readonly resumedParts: number;
  readonly phases: BakePhases;
  readonly lattice: PartModelLattice | null;
  readonly latticeIssue: string | null;
  readonly studCover: ModelStudCover;
  readonly cells: ModelCells | null;
  readonly vehicles: ReadonlyArray<PartVehicle>;
  readonly vehicleIssue: string | null;
}

export interface BakeFailure {
  readonly status: "failed";
  readonly message: string;
}

export type BakeOutcome = BakedModel | Need | BakeFailure;

export type BakeNeedsRequest = Pick<BakeInputs, "source" | "drawn" | "studPrimitives" | "vehicles">;

export type BakeNeeds = { readonly status: "complete" } | Need;

interface Response {
  readonly header: unknown;
  readonly body: Uint8Array;
}

type Range = readonly [number, number];

type Segments = Readonly<Record<string, Uint8Array>>;

function wordBytes(values: Uint32Array | Int32Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function receptorSegments(receptors: BakeReceptors): Segments {
  return {
    receptorParts: wordBytes(receptors.instanceParts),
    receptorStarts: wordBytes(receptors.partStarts),
    receptorSixteenths: wordBytes(receptors.sixteenths),
    receptorDirections: receptors.directions,
  };
}

const HEADER_LENGTH_BYTES = 4;
const utf8 = new TextEncoder();

class RequestPayload {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  add(bytes: Uint8Array): Range {
    const range = [this.length, bytes.length] as const;
    this.parts.push(bytes);
    this.length += bytes.length;
    return range;
  }

  frame(header: CompilerEnvelope): Uint8Array {
    const json = utf8.encode(JSON.stringify(header));
    const request = new Uint8Array(HEADER_LENGTH_BYTES + json.length + this.length);
    new DataView(request.buffer).setUint32(0, json.length, true);
    request.set(json, HEADER_LENGTH_BYTES);
    let offset = HEADER_LENGTH_BYTES + json.length;
    for (const part of this.parts) {
      request.set(part, offset);
      offset += part.length;
    }
    return request;
  }
}

function bytesOf(body: Uint8Array, blobs: CompilerBlobs, name: string): ArrayBuffer {
  const range = blobs[name];
  if (!range) throw new Error(`brick-compile response has no ${name} blob`);
  const [offset, length] = range;
  return body.slice(offset, offset + length).buffer;
}

function indices(all: Uint32Array, [start, count]: Range): Uint32Array {
  return all.slice(start, start + count);
}

function vehicleOf(
  vehicle: CompilerVehicle,
  body: Uint32Array,
  bogieInstances: Uint32Array,
): PartVehicle {
  return {
    ...vehicle,
    body: indices(body, vehicle.body),
    bogies: vehicle.bogies.map((bogie) => ({
      ...bogie,
      instances: indices(bogieInstances, bogie.instances),
    })),
  };
}

function bakedVehicles(header: CompilerBaked, body: Uint8Array): ReadonlyArray<PartVehicle> {
  const { vehicles, blobs } = header;
  if (vehicles === undefined) return [];
  const vehicleBody = new Uint32Array(bytesOf(body, blobs, "vehicleBody"));
  const bogieInstances = new Uint32Array(bytesOf(body, blobs, "bogieInstances"));
  return vehicles.map((vehicle) => vehicleOf(vehicle, vehicleBody, bogieInstances));
}

function bakedModel(header: CompilerBaked, body: Uint8Array): BakedModel {
  const { blobs, cover, lattice } = header;
  const cells = cover.cells;
  return {
    status: "baked",
    recordedParts: header.recordedParts,
    resumedParts: header.resumedParts,
    phases: header.phases,
    lattice:
      lattice === null
        ? null
        : {
            phaseX: lattice.phase[0],
            phaseZ: lattice.phase[1],
            aabbMin: lattice.aabb.min,
            aabbMax: lattice.aabb.max,
          },
    latticeIssue: header.latticeIssue ?? null,
    studCover: {
      studs: cover.studs,
      covered: cover.coveredStuds,
      visibleBits: new Uint32Array(bytesOf(body, blobs, "visibleBits")),
    },
    cells:
      cells === null
        ? null
        : {
            originX: cells.origin[0],
            originZ: cells.origin[1],
            width: cells.size[0],
            depth: cells.size[1],
            restY: cells.bottomY,
            footprint: new Uint32Array(bytesOf(body, blobs, "footprint")),
            flat: new Uint32Array(bytesOf(body, blobs, "flat")),
            columnBottom: new Int16Array(bytesOf(body, blobs, "columnBottom")),
            columnTop: new Int16Array(bytesOf(body, blobs, "columnTop")),
            footing: {
              instance: new Uint32Array(bytesOf(body, blobs, "footingInstance")),
              cell: new Uint32Array(bytesOf(body, blobs, "footingCell")),
            },
          },
    vehicles: bakedVehicles(header, body),
    vehicleIssue: header.vehicleIssue ?? null,
  };
}

interface LibraryDelta {
  readonly header: CompilerLibraryDelta;
  readonly files: ReadonlyArray<string>;
  readonly absent: ReadonlyArray<string>;
}

export class BrickCompiler {
  private readonly reactor: WasiReactor;
  private libraryKey = "";
  private libraryGeneration = 0;
  private readonly sentFiles = new Set<string>();
  private readonly sentAbsent = new Set<string>();
  private recordKey = "";
  private recordGeneration = 0;
  private readonly sentRecords = new Set<string>();

  constructor(module: WebAssembly.Module) {
    this.reactor = new WasiReactor(module);
  }

  private call(
    request: CompilerRequest,
    segments: Segments,
    library: LibraryFiles | null = null,
    records: RecordFiles | null = null,
  ): Response {
    const payload = new RequestPayload();
    const ranges: Record<string, Range> = {};
    for (const [name, bytes] of Object.entries(segments)) ranges[name] = payload.add(bytes);
    const delta = library === null ? null : this.libraryDelta(library, payload);
    const shelved = records === null ? null : this.recordDelta(records, payload);
    const response = this.send(
      payload.frame({
        request,
        segments: ranges,
        ...(delta === null ? {} : { library: delta.header }),
        ...(shelved === null ? {} : { records: shelved.header }),
      }),
    );
    for (const path of delta?.files ?? []) this.sentFiles.add(path);
    for (const path of delta?.absent ?? []) this.sentAbsent.add(path);
    if (records !== null) {
      this.sentRecords.clear();
      for (const reference of records.files.keys()) this.sentRecords.add(reference);
    }
    return response;
  }

  private recordDelta(
    records: RecordFiles,
    payload: RequestPayload,
  ): { readonly header: CompilerRecordDelta } {
    if (records.key !== this.recordKey || this.reactor.generation !== this.recordGeneration) {
      this.recordKey = records.key;
      this.recordGeneration = this.reactor.generation;
      this.sentRecords.clear();
    }
    const files: Array<CompilerRecordDelta["files"][number]> = [];
    for (const [reference, bytes] of records.files) {
      if (this.sentRecords.has(reference)) continue;
      files.push({ reference, bytes: payload.add(bytes) });
    }
    return { header: { key: records.key, files, references: [...records.files.keys()] } };
  }

  private send(request: Uint8Array): Response {
    const response = this.reactor.call(request);
    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    const headerEnd = HEADER_LENGTH_BYTES + view.getUint32(0, true);
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(response.subarray(HEADER_LENGTH_BYTES, headerEnd)),
    );
    const error = decode(CompilerError, parsed);
    if (error.ok) throw new Error(`brick-compile: ${error.value.message}`);
    return { header: parsed, body: response.subarray(headerEnd) };
  }

  private libraryDelta(library: LibraryFiles, payload: RequestPayload): LibraryDelta {
    if (library.key !== this.libraryKey || this.reactor.generation !== this.libraryGeneration) {
      this.libraryKey = library.key;
      this.libraryGeneration = this.reactor.generation;
      this.sentFiles.clear();
      this.sentAbsent.clear();
    }
    const entries: Array<CompilerLibraryDelta["files"][number]> = [];
    const files: string[] = [];
    for (const [path, text] of library.files) {
      if (this.sentFiles.has(path)) continue;
      entries.push({ path, bytes: payload.add(utf8.encode(text)) });
      files.push(path);
    }
    const absent = [...library.absent].filter((path) => !this.sentAbsent.has(path));
    return { header: { key: library.key, files: entries, absent }, files, absent };
  }

  readModel(source: string, options: ModelBakeOptions = {}): ModelRead {
    const { header, body } = this.call(
      { op: "readModel", omrAuthoringIdentification: options.omrAuthoringIdentification ?? false },
      { source: utf8.encode(source) },
    );
    const read = decodedOrThrow(decode(CompilerModelRead, header), "brick-compile readModel");
    return {
      sections: read.sections,
      parts: read.parts,
      inlineParts: read.inlineParts,
      looseGeometry: read.looseGeometry,
      instancePart: new Uint32Array(bytesOf(body, read.blobs, "instancePart")),
      instanceColor: new Uint32Array(bytesOf(body, read.blobs, "instanceColor")),
      instanceTransform: new Float64Array(bytesOf(body, read.blobs, "instanceTransform")),
      instanceSubmodel: new Int32Array(bytesOf(body, read.blobs, "instanceSubmodel")),
      submodelParent: new Int32Array(bytesOf(body, read.blobs, "submodelParent")),
      submodelMatrix: new Float64Array(bytesOf(body, read.blobs, "submodelMatrix")),
      authoredIdentification: read.authoredIdentification ?? null,
    };
  }

  readStudio(io: Uint8Array): StudioRead {
    const { header } = this.call({ op: "readStudio" }, { io });
    return decodedOrThrow(decode(StudioRead, header), "brick-compile readStudio");
  }

  compile(request: CompileRequest, library: LibraryFiles): CompileOutput {
    const { model, ...rest } = request;
    const { header, body } = this.call(
      { op: "compile", ...rest },
      { source: utf8.encode(model) },
      library,
    );
    const output = decodedOrThrow(decode(CompilerCompile, header), "brick-compile compile");
    const slice = ([offset, length]: Range): Uint8Array => body.slice(offset, offset + length);
    return {
      weldEpsilonLdu: output.weldEpsilonLdu,
      inline: output.inline,
      parts: output.parts.map((outcome): PartOutcome => {
        if (outcome.status !== "compiled") return outcome;
        return {
          ...outcome,
          glb: slice(outcome.glb),
          record: outcome.record === null ? null : slice(outcome.record),
        };
      }),
    };
  }

  bakeNeeds(
    request: BakeNeedsRequest,
    library: LibraryFiles,
    records: RecordFiles | null = null,
  ): BakeNeeds {
    const { header } = this.call(
      { op: "bakeNeeds", studPrimitives: request.studPrimitives, vehicles: request.vehicles },
      { source: utf8.encode(request.source), drawn: request.drawn },
      library,
      records,
    );
    return decodedOrThrow(decode(CompilerBakeNeeds, header), "brick-compile bakeNeeds");
  }

  bake(
    request: BakeRequest,
    library: LibraryFiles,
    records: RecordFiles | null = null,
  ): BakeOutcome {
    const { drawn, source, receptors, ...rest } = request;
    const { header, body } = this.call(
      { op: "bake", ...rest },
      {
        source: utf8.encode(source),
        drawn,
        ...(receptors === undefined ? {} : receptorSegments(receptors)),
      },
      library,
      records,
    );
    const outcome = decodedOrThrow(decode(CompilerBake, header), "brick-compile bake");
    return outcome.status === "baked" ? bakedModel(outcome, body) : outcome;
  }
}
