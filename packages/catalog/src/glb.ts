import {
  FarMeshGltfDocument,
  GltfDocument,
  type GltfAccessor,
  type GltfBufferView,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { INHERIT_COLOR, type ColorGroup, type MeshArrays, type PartMesh } from "./part-bundle.ts";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_INT = 5125;

type GltfMeshDocument = Omit<GltfDocument, "extras">;

export interface ParsedGlb<TDocument extends GltfMeshDocument = GltfDocument> {
  readonly document: TDocument;
  readonly binary: ArrayBuffer;
}

function splitGlb(bytes: ArrayBuffer): { readonly json: unknown; readonly binary: ArrayBuffer } {
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
  return { json: JSON.parse(jsonText), binary: bytes.slice(binStart, binStart + binLength) };
}

export function parseGlb(bytes: ArrayBuffer, label: string): ParsedGlb {
  const { json, binary } = splitGlb(bytes);
  return { document: decodedOrThrow(decode(GltfDocument, json), label), binary };
}

export function parseFarMeshGlb(bytes: ArrayBuffer, label: string): ParsedGlb<FarMeshGltfDocument> {
  const { json, binary } = splitGlb(bytes);
  return { document: decodedOrThrow(decode(FarMeshGltfDocument, json), label), binary };
}

function accessor(
  glb: ParsedGlb<GltfMeshDocument>,
  index: number,
): { view: GltfBufferView; meta: GltfAccessor } {
  const meta = glb.document.accessors[index];
  const view = meta ? glb.document.bufferViews[meta.bufferView] : undefined;
  if (!meta || !view) throw new Error(`GLB accessor ${index} is missing`);
  return { view, meta };
}

function floatVec3(glb: ParsedGlb<GltfMeshDocument>, index: number): Float32Array {
  const { view, meta } = accessor(glb, index);
  if (meta.componentType !== COMPONENT_FLOAT || meta.type !== "VEC3")
    throw new Error(`GLB accessor ${index} is not float VEC3`);
  return new Float32Array(glb.binary, view.byteOffset, meta.count * 3);
}

function uint32Scalar(glb: ParsedGlb<GltfMeshDocument>, index: number): Uint32Array {
  const { view, meta } = accessor(glb, index);
  if (meta.componentType !== COMPONENT_UNSIGNED_INT || meta.type !== "SCALAR")
    throw new Error(`GLB accessor ${index} is not uint32 SCALAR`);
  return new Uint32Array(glb.binary, view.byteOffset, meta.count);
}

export function readInheritColorMesh(glb: ParsedGlb<GltfMeshDocument>, label: string): MeshArrays {
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

export function readUint32Array(glb: ParsedGlb<GltfMeshDocument>, index: number): Uint32Array {
  return uint32Scalar(glb, index);
}

export function readPartMesh(glb: ParsedGlb<GltfMeshDocument>, label: string): PartMesh {
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
