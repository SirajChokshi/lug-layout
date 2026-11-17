import { GltfDocument, type GltfAccessor } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_INT = 5125;
const TRIANGLES = 4;
const VEC3 = 3;
export const MATRIX_FLOATS = 12;

export interface ColorGroup {
  readonly ldrawColor: number;
  readonly indices: Uint32Array;
}

export interface Mesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly groups: ReadonlyArray<ColorGroup>;
}

export interface StudPlacements {
  readonly primitive: ReadonlyArray<string>;
  readonly color: Uint16Array;
  readonly matrices: Float32Array;
}

export interface CompiledGlb {
  readonly mesh: Mesh;
  readonly studs: StudPlacements;
}

function chunks(bytes: Uint8Array, label: string): { json: unknown; binary: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error(`${label} is not a GLB file`);
  const jsonLength = view.getUint32(HEADER_BYTES, true);
  if (view.getUint32(HEADER_BYTES + 4, true) !== CHUNK_JSON) {
    throw new Error(`${label} has no JSON chunk`);
  }
  const jsonStart = HEADER_BYTES + CHUNK_HEADER_BYTES;
  const json: unknown = JSON.parse(
    new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLength)),
  );
  const binHeader = jsonStart + jsonLength;
  if (binHeader >= bytes.byteLength) return { json, binary: new Uint8Array(0) };
  const binLength = view.getUint32(binHeader, true);
  if (view.getUint32(binHeader + 4, true) !== CHUNK_BIN)
    throw new Error(`${label} has no BIN chunk`);
  const binStart = binHeader + CHUNK_HEADER_BYTES;
  return { json, binary: bytes.slice(binStart, binStart + binLength) };
}

function accessorBytes(
  document: GltfDocument,
  binary: Uint8Array,
  index: number,
  label: string,
): { meta: GltfAccessor; buffer: ArrayBuffer; byteOffset: number } {
  const meta = document.accessors[index];
  const view = meta ? document.bufferViews[meta.bufferView] : undefined;
  if (!meta || !view) throw new Error(`${label}: accessor ${index} is missing`);
  return {
    meta,
    buffer: binary.buffer as ArrayBuffer,
    byteOffset: binary.byteOffset + view.byteOffset,
  };
}

function floatVec3(document: GltfDocument, binary: Uint8Array, index: number, label: string) {
  const { meta, buffer, byteOffset } = accessorBytes(document, binary, index, label);
  if (meta.componentType !== COMPONENT_FLOAT || meta.type !== "VEC3") {
    throw new Error(`${label}: accessor ${index} is not float VEC3`);
  }
  return new Float32Array(buffer, byteOffset, meta.count * VEC3);
}

function uint32Scalar(document: GltfDocument, binary: Uint8Array, index: number, label: string) {
  const { meta, buffer, byteOffset } = accessorBytes(document, binary, index, label);
  if (meta.componentType !== COMPONENT_UNSIGNED_INT || meta.type !== "SCALAR") {
    throw new Error(`${label}: accessor ${index} is not uint32 SCALAR`);
  }
  return new Uint32Array(buffer, byteOffset, meta.count);
}

const EMPTY_MESH: Mesh = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  groups: [],
};

export function readCompiledGlb(bytes: Uint8Array, label: string): CompiledGlb {
  const { json, binary } = chunks(bytes, label);
  const document = decodedOrThrow(decode(GltfDocument, json), label);
  const primitives = document.meshes[0]?.primitives ?? [];
  const [first] = primitives;
  const { studs } = document.extras;
  const placements: StudPlacements = {
    primitive: studs.map((stud) => stud.primitive),
    color: Uint16Array.from(studs, (stud) => stud.color),
    matrices: Float32Array.from(studs.flatMap((stud) => stud.matrix)),
  };
  if (!first) return { mesh: EMPTY_MESH, studs: placements };
  const groups = primitives.map((primitive) => {
    if (primitive.mode !== TRIANGLES) throw new Error(`${label}: a primitive is not triangles`);
    if (
      primitive.attributes.POSITION !== first.attributes.POSITION ||
      primitive.attributes.NORMAL !== first.attributes.NORMAL
    ) {
      throw new Error(`${label}: colour groups must share one vertex buffer`);
    }
    return {
      ldrawColor: primitive.extras.ldrawColor,
      indices: uint32Scalar(document, binary, primitive.indices, label),
    };
  });
  return {
    mesh: {
      positions: floatVec3(document, binary, first.attributes.POSITION, label),
      normals: floatVec3(document, binary, first.attributes.NORMAL, label),
      groups,
    },
    studs: placements,
  };
}
