import type { ModelCells, ModelStudCover, PartModelLattice } from "@brr/catalog";
import {
  CompilerBake,
  CompilerBakeNeeds,
  CompilerCompile,
  type BakeShard,
  CompilerError,
  CompilerModelRead,
  StudioRead,
  type CompilerBaked,
  type CompilerBlobs,
  type CompilerConnectorInputs,
  type CompilerEnvelope,
  type CompilerLibraryDelta,
  type CompilerRequest,
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
}

export interface LibraryFiles {
  readonly key: string;
  readonly files: ReadonlyMap<string, string>;
  readonly absent: ReadonlySet<string>;
}

export interface CompileRequest {
  readonly lod: CompileLod;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly connectors: CompilerConnectorInputs;
  readonly parts: ReadonlyArray<string>;
  readonly model: string;
  readonly inlineChecks: ReadonlyArray<InlinePart>;
}

type RawCompile = CompilerCompile;
type RawPartOutcome = RawCompile["parts"][number];
type RawInlineOutcome = RawCompile["inline"][number];

export type Failure = Omit<Extract<RawPartOutcome, { status: "failed" }>, "reference">;
export type FailureKind = Failure["kind"];
export type Need = Omit<Extract<RawPartOutcome, { status: "need" }>, "reference">;

export type PartOutcome =
  | Exclude<RawPartOutcome, { status: "compiled" }>
  | (Omit<Extract<RawPartOutcome, { status: "compiled" }>, "glb"> & { readonly glb: Uint8Array });

export type InlineOutcome = RawInlineOutcome;

export interface CompileOutput {
  readonly parts: ReadonlyArray<PartOutcome>;
  readonly inline: ReadonlyArray<InlineOutcome>;
  readonly weldEpsilonLdu: number;
}

export interface BakeRequest {
  readonly source: string;
  readonly drawn: Uint8Array;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly translucentColors: ReadonlyArray<number>;
  readonly tableDepthLdu: number;
  readonly shard?: BakeShard;
}

export interface BakedModel {
  readonly status: "baked";
  readonly lattice: PartModelLattice | null;
  readonly latticeIssue: string | null;
  readonly studCover: ModelStudCover;
  readonly cells: ModelCells | null;
}

export interface BakeFailure {
  readonly status: "failed";
  readonly message: string;
}

export type BakeOutcome = BakedModel | Need | BakeFailure;

export type BakeNeedsRequest = Pick<BakeRequest, "source" | "drawn" | "studPrimitives">;

export type BakeNeeds = { readonly status: "complete" } | Need;

interface Response {
  readonly header: unknown;
  readonly body: Uint8Array;
}

type Range = readonly [number, number];

type Segments = Readonly<Record<string, Uint8Array>>;

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

function bakedModel(header: CompilerBaked, body: Uint8Array): BakedModel {
  const { blobs, cover, lattice } = header;
  const cells = cover.cells;
  return {
    status: "baked",
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
          },
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

  constructor(module: WebAssembly.Module) {
    this.reactor = new WasiReactor(module);
  }

  private call(
    request: CompilerRequest,
    segments: Segments,
    library: LibraryFiles | null = null,
  ): Response {
    const payload = new RequestPayload();
    const ranges: Record<string, Range> = {};
    for (const [name, bytes] of Object.entries(segments)) ranges[name] = payload.add(bytes);
    if (library === null) return this.send(payload.frame({ request, segments: ranges }));
    const delta = this.libraryDelta(library, payload);
    const response = this.send(payload.frame({ request, segments: ranges, library: delta.header }));
    for (const path of delta.files) this.sentFiles.add(path);
    for (const path of delta.absent) this.sentAbsent.add(path);
    return response;
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

  readModel(source: string): ModelRead {
    const { header, body } = this.call({ op: "readModel" }, { source: utf8.encode(source) });
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
    return {
      weldEpsilonLdu: output.weldEpsilonLdu,
      inline: output.inline,
      parts: output.parts.map((outcome): PartOutcome => {
        if (outcome.status !== "compiled") return outcome;
        const [offset, length] = outcome.glb;
        return { ...outcome, glb: body.slice(offset, offset + length) };
      }),
    };
  }

  bakeNeeds(request: BakeNeedsRequest, library: LibraryFiles): BakeNeeds {
    const { header } = this.call(
      { op: "bakeNeeds", studPrimitives: request.studPrimitives },
      { source: utf8.encode(request.source), drawn: request.drawn },
      library,
    );
    return decodedOrThrow(decode(CompilerBakeNeeds, header), "brick-compile bakeNeeds");
  }

  bake(request: BakeRequest, library: LibraryFiles): BakeOutcome {
    const { drawn, source, ...rest } = request;
    const { header, body } = this.call(
      { op: "bake", ...rest },
      { source: utf8.encode(source), drawn },
      library,
    );
    const outcome = decodedOrThrow(decode(CompilerBake, header), "brick-compile bake");
    return outcome.status === "baked" ? bakedModel(outcome, body) : outcome;
  }
}
