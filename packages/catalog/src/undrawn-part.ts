import type { PartAsset, PartMesh, PartShapeAsset } from "./part-bundle.ts";

const NO_GEOMETRY: PartMesh = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  groups: [],
};

export function undrawnPart(shape: PartShapeAsset): PartAsset {
  return { ...shape, mesh: NO_GEOMETRY };
}
