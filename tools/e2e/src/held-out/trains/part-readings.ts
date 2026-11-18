import { type PinnedLibrary } from "./pinned-library.ts";
import { BrickCompiler } from "@brr/import";
import type { Vec3 } from "../assembly.ts";
import type { Bundle } from "../bundle.ts";

export interface PrimitiveFrame {
  readonly primitive: string;
  readonly origin: Vec3;
  readonly columns: readonly [Vec3, Vec3, Vec3];
}

export interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface PartReading {
  readonly reference: string;
  readonly bounds: Box;
  readonly frames: ReadonlyArray<PrimitiveFrame>;
  readonly studs: ReadonlyArray<PrimitiveFrame>;
  readonly triangles: Float32Array;
}

const PINNED_LIBRARY_KEY = "held-out-pinned";
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_INT = 5125;
const MODE_TRIANGLES = 4;
const VEC3 = 3;
const TRIANGLE_FLOATS = 9;
const BATCH = 150;

interface GltfJson {
  readonly meshes: ReadonlyArray<{
    readonly primitives: ReadonlyArray<{
      readonly attributes: { readonly POSITION: number };
      readonly indices: number;
      readonly mode: number;
    }>;
  }>;
  readonly accessors: ReadonlyArray<{
    readonly bufferView: number;
    readonly componentType: number;
    readonly count: number;
    readonly byteOffset?: number;
  }>;
  readonly bufferViews: ReadonlyArray<{ readonly byteOffset: number; readonly byteLength: number }>;
  readonly extras: {
    readonly studs: ReadonlyArray<{ readonly primitive: string; readonly matrix: number[] }>;
    readonly bounds: { readonly min: number[]; readonly max: number[] };
    readonly ldraw: { readonly file: string };
  };
}

interface Glb {
  readonly json: GltfJson;
  readonly binary: Uint8Array;
}

function readGlb(glb: Uint8Array): Glb {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(GLB_HEADER_BYTES, true);
  const jsonStart = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
  const json = JSON.parse(
    new TextDecoder().decode(glb.subarray(jsonStart, jsonStart + jsonLength)),
  ) as GltfJson;
  const binaryHeader = jsonStart + jsonLength;
  const binaryLength =
    binaryHeader + CHUNK_HEADER_BYTES <= glb.byteLength ? view.getUint32(binaryHeader, true) : 0;
  const binaryStart = binaryHeader + CHUNK_HEADER_BYTES;
  return { json, binary: glb.subarray(binaryStart, binaryStart + binaryLength) };
}

function accessorArray(glb: Glb, index: number): Float32Array | Uint32Array {
  const accessor = glb.json.accessors[index];
  if (!accessor) throw new Error(`glb accessor ${index} missing`);
  const view = glb.json.bufferViews[accessor.bufferView];
  if (!view) throw new Error(`glb buffer view ${accessor.bufferView} missing`);
  const start = glb.binary.byteOffset + view.byteOffset + (accessor.byteOffset ?? 0);
  const buffer = glb.binary.buffer.slice(start, start + view.byteLength);
  switch (accessor.componentType) {
    case COMPONENT_FLOAT:
      return new Float32Array(buffer, 0, accessor.count * VEC3);
    case COMPONENT_UNSIGNED_INT:
      return new Uint32Array(buffer, 0, accessor.count);
    default:
      throw new Error(`glb component type ${accessor.componentType} unsupported`);
  }
}

function triangles(glb: Glb): Float32Array {
  const out: number[] = [];
  for (const mesh of glb.json.meshes) {
    for (const primitive of mesh.primitives) {
      if (primitive.mode !== MODE_TRIANGLES) continue;
      const positions = accessorArray(glb, primitive.attributes.POSITION);
      const indices = accessorArray(glb, primitive.indices);
      for (const index of indices) {
        out.push(
          positions[index * VEC3] ?? 0,
          positions[index * VEC3 + 1] ?? 0,
          positions[index * VEC3 + 2] ?? 0,
        );
      }
    }
  }
  return Float32Array.from(out.slice(0, out.length - (out.length % TRIANGLE_FLOATS)));
}

function frameOf(stud: { readonly primitive: string; readonly matrix: number[] }): PrimitiveFrame {
  const m = stud.matrix;
  const at = (i: number): number => m[i] ?? 0;
  return {
    primitive: stud.primitive,
    origin: [at(3), at(7), at(11)],
    columns: [
      [at(0), at(4), at(8)],
      [at(1), at(5), at(9)],
      [at(2), at(6), at(10)],
    ],
  };
}

function vec3(values: ReadonlyArray<number>): Vec3 {
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

export class PartReader {
  private readonly cache = new Map<string, PartReading | null>();
  private readonly framed = new Map<string, ReadonlyArray<PrimitiveFrame> | null>();

  constructor(
    private readonly bundle: Bundle,
    private readonly library: PinnedLibrary,
    private readonly frameVocabulary: ReadonlyArray<string>,
  ) {}

  private async compile(
    references: ReadonlyArray<string>,
    vocabulary: ReadonlyArray<string>,
  ): Promise<Map<string, Glb>> {
    const { files, absent } = await this.library.files(references);
    const output = new BrickCompiler(this.bundle.compiler).compile(
      {
        lod: this.bundle.job.lod,
        studPrimitives: vocabulary,
        unofficialAllowlist: this.bundle.job.unofficialAllowlist,
        connectors: {
          primitives: this.bundle.job.primitives,
          sectionVocabulary: this.bundle.job.sectionVocabulary,
          cavityProbe: this.bundle.job.cavityProbe,
          infer: [],
          shadowPatchManifest: null,
        },
        parts: references,
        model: "",
        inlineChecks: [],
      },
      { key: PINNED_LIBRARY_KEY, files: new Map(Object.entries(files)), absent: new Set(absent) },
    );
    const out = new Map<string, Glb>();
    for (const outcome of output.parts) {
      if (outcome.status === "compiled") out.set(outcome.reference, readGlb(outcome.glb));
    }
    return out;
  }

  async frames(
    references: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, ReadonlyArray<PrimitiveFrame>>> {
    const missing = [...new Set(references)].filter((reference) => !this.framed.has(reference));
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const compiled = await this.compile(batch, this.frameVocabulary);
      for (const reference of batch) {
        const glb = compiled.get(reference);
        this.framed.set(reference, glb ? glb.json.extras.studs.map(frameOf) : null);
      }
    }
    const out = new Map<string, ReadonlyArray<PrimitiveFrame>>();
    for (const reference of references) {
      const frames = this.framed.get(reference);
      if (frames) out.set(reference, frames);
    }
    return out;
  }

  async read(references: ReadonlyArray<string>): Promise<ReadonlyMap<string, PartReading>> {
    const framed = await this.frames(references);
    const missing = [...new Set(references)].filter(
      (reference) => !this.cache.has(reference) && framed.has(reference),
    );
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const plain = await this.compile(batch, this.bundle.job.studPrimitives);
      for (const reference of batch) {
        const frames = framed.get(reference);
        const meshed = plain.get(reference);
        if (!frames || !meshed) {
          this.cache.set(reference, null);
          continue;
        }
        this.cache.set(reference, {
          reference,
          bounds: {
            min: vec3(meshed.json.extras.bounds.min),
            max: vec3(meshed.json.extras.bounds.max),
          },
          frames,
          studs: meshed.json.extras.studs.map(frameOf),
          triangles: triangles(meshed),
        });
      }
    }
    const out = new Map<string, PartReading>();
    for (const reference of references) {
      const reading = this.cache.get(reference);
      if (reading) out.set(reference, reading);
    }
    return out;
  }
}
