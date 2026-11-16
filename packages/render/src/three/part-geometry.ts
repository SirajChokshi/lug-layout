import type { MeshArrays, PartAsset, StudPrimitiveAsset } from "@brr/catalog";
import { BufferAttribute, BufferGeometry } from "three/webgpu";
import { INSTANCE_MATRIX_FLOATS } from "../scene-backend.ts";

export function geometryFromMesh(mesh: MeshArrays): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function studClusterGeometry(
  part: PartAsset,
  primitives: ReadonlyArray<StudPrimitiveAsset>,
): BufferGeometry | undefined {
  const studCount = part.studPrimitiveIndex.length;
  if (studCount === 0) return undefined;
  let vertexTotal = 0;
  let indexTotal = 0;
  for (let s = 0; s < studCount; s++) {
    const primitive = primitives[part.studPrimitiveIndex[s] ?? 0];
    if (!primitive) throw new Error(`${part.id}: stud primitive ${s} missing from palette`);
    vertexTotal += primitive.mesh.positions.length / 3;
    indexTotal += primitive.mesh.indices.length;
  }
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  let vertexBase = 0;
  let indexBase = 0;
  for (let s = 0; s < studCount; s++) {
    const primitive = primitives[part.studPrimitiveIndex[s] ?? 0];
    if (!primitive) continue;
    const m = part.studMatrices.subarray(
      s * INSTANCE_MATRIX_FLOATS,
      (s + 1) * INSTANCE_MATRIX_FLOATS,
    );
    const source = primitive.mesh;
    const vertexCount = source.positions.length / 3;
    for (let v = 0; v < vertexCount; v++) {
      const x = source.positions[v * 3] ?? 0;
      const y = source.positions[v * 3 + 1] ?? 0;
      const z = source.positions[v * 3 + 2] ?? 0;
      const nx = source.normals[v * 3] ?? 0;
      const ny = source.normals[v * 3 + 1] ?? 0;
      const nz = source.normals[v * 3 + 2] ?? 0;
      const o = (vertexBase + v) * 3;
      positions[o] = (m[0] ?? 0) * x + (m[1] ?? 0) * y + (m[2] ?? 0) * z + (m[3] ?? 0);
      positions[o + 1] = (m[4] ?? 0) * x + (m[5] ?? 0) * y + (m[6] ?? 0) * z + (m[7] ?? 0);
      positions[o + 2] = (m[8] ?? 0) * x + (m[9] ?? 0) * y + (m[10] ?? 0) * z + (m[11] ?? 0);
      const tx = (m[0] ?? 0) * nx + (m[1] ?? 0) * ny + (m[2] ?? 0) * nz;
      const ty = (m[4] ?? 0) * nx + (m[5] ?? 0) * ny + (m[6] ?? 0) * nz;
      const tz = (m[8] ?? 0) * nx + (m[9] ?? 0) * ny + (m[10] ?? 0) * nz;
      const length = Math.hypot(tx, ty, tz) || 1;
      normals[o] = tx / length;
      normals[o + 1] = ty / length;
      normals[o + 2] = tz / length;
    }
    for (let i = 0; i < source.indices.length; i++) {
      indices[indexBase + i] = (source.indices[i] ?? 0) + vertexBase;
    }
    vertexBase += vertexCount;
    indexBase += source.indices.length;
  }
  return geometryFromMesh({ positions, normals, indices });
}
