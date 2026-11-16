import {
  INHERIT_COLOR,
  type MeshArrays,
  type PartAsset,
  type StudPrimitiveAsset,
} from "@brr/catalog";
import { BufferAttribute, BufferGeometry } from "three/webgpu";
import { COLOR_CHANNELS, INSTANCE_MATRIX_FLOATS } from "../scene-backend.ts";

export type LinearColorLookup = (ldrawColor: number, out: Float32Array) => void;

function geometry(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  colors?: Float32Array,
): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute("position", new BufferAttribute(positions, 3));
  result.setAttribute("normal", new BufferAttribute(normals, 3));
  if (colors) result.setAttribute("color", new BufferAttribute(colors, COLOR_CHANNELS));
  result.setIndex(new BufferAttribute(indices, 1));
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

export function primitiveGeometry(mesh: MeshArrays): BufferGeometry {
  return geometry(mesh.positions, mesh.normals, mesh.indices);
}

export function inheritBodyGeometry(part: PartAsset): BufferGeometry | undefined {
  const group = part.mesh.groups.find((g) => g.ldrawColor === INHERIT_COLOR);
  return group ? geometry(part.mesh.positions, part.mesh.normals, group.indices) : undefined;
}

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  addIndexed(
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    matrix: Float32Array | undefined,
    color: Float32Array | undefined,
  ): void {
    const remap = new Map<number, number>();
    for (let i = 0; i < indices.length; i++) {
      const source = indices[i] ?? 0;
      let target = remap.get(source);
      if (target === undefined) {
        target = this.positions.length / 3;
        remap.set(source, target);
        this.pushVertex(positions, normals, source, matrix);
        if (color) this.colors.push(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0);
      }
      this.indices.push(target);
    }
  }

  private pushVertex(
    positions: Float32Array,
    normals: Float32Array,
    v: number,
    m: Float32Array | undefined,
  ): void {
    const x = positions[v * 3] ?? 0;
    const y = positions[v * 3 + 1] ?? 0;
    const z = positions[v * 3 + 2] ?? 0;
    const nx = normals[v * 3] ?? 0;
    const ny = normals[v * 3 + 1] ?? 0;
    const nz = normals[v * 3 + 2] ?? 0;
    if (!m) {
      this.positions.push(x, y, z);
      this.normals.push(nx, ny, nz);
      return;
    }
    this.positions.push(
      (m[0] ?? 0) * x + (m[1] ?? 0) * y + (m[2] ?? 0) * z + (m[3] ?? 0),
      (m[4] ?? 0) * x + (m[5] ?? 0) * y + (m[6] ?? 0) * z + (m[7] ?? 0),
      (m[8] ?? 0) * x + (m[9] ?? 0) * y + (m[10] ?? 0) * z + (m[11] ?? 0),
    );
    const tx = (m[0] ?? 0) * nx + (m[1] ?? 0) * ny + (m[2] ?? 0) * nz;
    const ty = (m[4] ?? 0) * nx + (m[5] ?? 0) * ny + (m[6] ?? 0) * nz;
    const tz = (m[8] ?? 0) * nx + (m[9] ?? 0) * ny + (m[10] ?? 0) * nz;
    const length = Math.hypot(tx, ty, tz) || 1;
    this.normals.push(tx / length, ty / length, tz / length);
  }

  build(withColors: boolean): BufferGeometry | undefined {
    if (this.indices.length === 0) return undefined;
    return geometry(
      Float32Array.from(this.positions),
      Float32Array.from(this.normals),
      Uint32Array.from(this.indices),
      withColors ? Float32Array.from(this.colors) : undefined,
    );
  }
}

function studMatrix(part: PartAsset, stud: number): Float32Array {
  return part.studMatrices.subarray(
    stud * INSTANCE_MATRIX_FLOATS,
    (stud + 1) * INSTANCE_MATRIX_FLOATS,
  );
}

function studPrimitive(
  part: PartAsset,
  primitives: ReadonlyArray<StudPrimitiveAsset>,
  stud: number,
): StudPrimitiveAsset {
  const primitive = primitives[part.studPrimitiveIndex[stud] ?? 0];
  if (!primitive) throw new Error(`${part.id}: stud primitive ${stud} missing from palette`);
  return primitive;
}

export function inheritStudGeometry(
  part: PartAsset,
  primitives: ReadonlyArray<StudPrimitiveAsset>,
): BufferGeometry | undefined {
  const builder = new MeshBuilder();
  for (let s = 0; s < part.studPrimitiveIndex.length; s++) {
    if (part.studColors[s] !== INHERIT_COLOR) continue;
    const { mesh } = studPrimitive(part, primitives, s);
    builder.addIndexed(mesh.positions, mesh.normals, mesh.indices, studMatrix(part, s), undefined);
  }
  return builder.build(false);
}

export function fixedColorGeometry(
  part: PartAsset,
  primitives: ReadonlyArray<StudPrimitiveAsset>,
  linearColor: LinearColorLookup,
): BufferGeometry | undefined {
  const builder = new MeshBuilder();
  const color = new Float32Array(COLOR_CHANNELS);
  for (const group of part.mesh.groups) {
    if (group.ldrawColor === INHERIT_COLOR) continue;
    linearColor(group.ldrawColor, color);
    builder.addIndexed(part.mesh.positions, part.mesh.normals, group.indices, undefined, color);
  }
  for (let s = 0; s < part.studPrimitiveIndex.length; s++) {
    const code = part.studColors[s] ?? INHERIT_COLOR;
    if (code === INHERIT_COLOR) continue;
    linearColor(code, color);
    const { mesh } = studPrimitive(part, primitives, s);
    builder.addIndexed(mesh.positions, mesh.normals, mesh.indices, studMatrix(part, s), color);
  }
  return builder.build(true);
}
