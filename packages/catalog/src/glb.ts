import { INHERIT_COLOR, type ColorGroup, type MeshArrays, type PartMesh } from "./part-bundle.ts";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_INT = 5125;

interface GltfAccessor {
  readonly bufferView: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: "SCALAR" | "VEC3";
}

interface GltfBufferView {
  readonly byteOffset: number;
  readonly byteLength: number;
}

interface GltfPrimitive {
  readonly attributes: { readonly POSITION: number; readonly NORMAL: number };
  readonly indices: number;
  readonly extras: { readonly ldrawColor: number };
}

export interface GltfDocument {
  readonly accessors: ReadonlyArray<GltfAccessor>;
  readonly bufferViews: ReadonlyArray<GltfBufferView>;
  readonly meshes: ReadonlyArray<{ readonly primitives: ReadonlyArray<GltfPrimitive> }>;
  readonly extras: unknown;
}

export interface ParsedGlb {
  readonly document: GltfDocument;
  readonly binary: ArrayBuffer;
}

export function parseGlb(bytes: ArrayBuffer): ParsedGlb {
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB file");
  const jsonLength = view.getUint32(HEADER_BYTES, true);
  if (view.getUint32(HEADER_BYTES + 4, true) !== CHUNK_JSON) throw new Error("GLB missing JSON");
  const jsonStart = HEADER_BYTES + CHUNK_HEADER_BYTES;
  const jsonText = new TextDecoder().decode(new Uint8Array(bytes, jsonStart, jsonLength));
  const binHeader = jsonStart + jsonLength;
  const binLength = view.getUint32(binHeader, true);
  if (view.getUint32(binHeader + 4, true) !== CHUNK_BIN) throw new Error("GLB missing BIN");
  const binStart = binHeader + CHUNK_HEADER_BYTES;
  return {
    document: JSON.parse(jsonText) as GltfDocument,
    binary: bytes.slice(binStart, binStart + binLength),
  };
}

function accessor(glb: ParsedGlb, index: number): { view: GltfBufferView; meta: GltfAccessor } {
  const meta = glb.document.accessors[index];
  const view = meta ? glb.document.bufferViews[meta.bufferView] : undefined;
  if (!meta || !view) throw new Error(`GLB accessor ${index} is missing`);
  return { view, meta };
}

function floatVec3(glb: ParsedGlb, index: number): Float32Array {
  const { view, meta } = accessor(glb, index);
  if (meta.componentType !== COMPONENT_FLOAT || meta.type !== "VEC3")
    throw new Error(`GLB accessor ${index} is not float VEC3`);
  return new Float32Array(glb.binary, view.byteOffset, meta.count * 3);
}

function uint32Scalar(glb: ParsedGlb, index: number): Uint32Array {
  const { view, meta } = accessor(glb, index);
  if (meta.componentType !== COMPONENT_UNSIGNED_INT || meta.type !== "SCALAR")
    throw new Error(`GLB accessor ${index} is not uint32 SCALAR`);
  return new Uint32Array(glb.binary, view.byteOffset, meta.count);
}

export function readInheritColorMesh(glb: ParsedGlb, label: string): MeshArrays {
  const primitives = glb.document.meshes[0]?.primitives ?? [];
  const [primitive, ...rest] = primitives;
  if (!primitive || rest.length > 0 || primitive.extras.ldrawColor !== INHERIT_COLOR) {
    throw new Error(`${label}: fixed-color primitives are not supported by the M0 bundle reader`);
  }
  return {
    positions: floatVec3(glb, primitive.attributes.POSITION),
    normals: floatVec3(glb, primitive.attributes.NORMAL),
    indices: uint32Scalar(glb, primitive.indices),
  };
}

export function readPartMesh(glb: ParsedGlb, label: string): PartMesh {
  const primitives = glb.document.meshes[0]?.primitives ?? [];
  const [first] = primitives;
  if (!first) throw new Error(`${label}: GLB has no primitives`);
  const groups: ColorGroup[] = primitives.map((primitive) => {
    if (
      primitive.attributes.POSITION !== first.attributes.POSITION ||
      primitive.attributes.NORMAL !== first.attributes.NORMAL
    ) {
      throw new Error(`${label}: colour groups must share one vertex buffer`);
    }
    return {
      ldrawColor: primitive.extras.ldrawColor,
      indices: uint32Scalar(glb, primitive.indices),
    };
  });
  return {
    positions: floatVec3(glb, first.attributes.POSITION),
    normals: floatVec3(glb, first.attributes.NORMAL),
    groups,
  };
}
