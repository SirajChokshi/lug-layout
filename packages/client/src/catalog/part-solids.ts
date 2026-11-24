import type { MeshArrays, PartAsset, PartMesh, StudPrimitiveAsset } from "@brr/catalog";
import {
  SOLID_BOX_FLOATS,
  SOLID_MATRIX_FLOATS,
  SOLID_TRIANGLE_FLOATS,
  invertAffine,
  posedBoxBounds,
  type PartSolid,
  type StudSolid,
} from "@brr/domain";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { MeshReadiness } from "../edit/part-mesh-stream.ts";

const POSITION_FLOATS = 3;
const TRIANGLE_CORNERS = 3;
const MAX = 3;
const MATRIX_ROW_FLOATS = 4;

export interface IPartSolids {
  studReach(): number;
  box(partIndex: number): Float64Array;
  readiness(partIndex: number): MeshReadiness;
  solid(partIndex: number): PartSolid;
}

export interface SolidSource {
  parts(): ReadonlyArray<PartAsset>;
  readiness(partIndex: number): MeshReadiness;
}

function meshTriangles(mesh: PartMesh): number {
  let count = 0;
  for (const group of mesh.groups) count += Math.floor(group.indices.length / TRIANGLE_CORNERS);
  return count;
}

function writeMeshTriangles(
  positions: Float32Array,
  indices: Uint32Array,
  frame: ArrayLike<number> | null,
  frameAt: number,
  out: Float64Array,
  from: number,
): number {
  let t = from;
  for (let k = 0; k + TRIANGLE_CORNERS <= indices.length; k += TRIANGLE_CORNERS, t++) {
    for (let corner = 0; corner < TRIANGLE_CORNERS; corner++) {
      const p = (indices[k + corner] ?? 0) * POSITION_FLOATS;
      const x = positions[p] ?? 0;
      const y = positions[p + 1] ?? 0;
      const z = positions[p + 2] ?? 0;
      const o = t * SOLID_TRIANGLE_FLOATS + corner * POSITION_FLOATS;
      if (frame === null) {
        out[o] = x;
        out[o + 1] = y;
        out[o + 2] = z;
        continue;
      }
      for (let row = 0; row < POSITION_FLOATS; row++) {
        const r = frameAt + row * MATRIX_ROW_FLOATS;
        out[o + row] =
          (frame[r] ?? 0) * x +
          (frame[r + 1] ?? 0) * y +
          (frame[r + 2] ?? 0) * z +
          (frame[r + 3] ?? 0);
      }
    }
  }
  return t;
}

function primitiveBox(mesh: MeshArrays): Float64Array {
  const box = new Float64Array(SOLID_BOX_FLOATS);
  box.fill(Number.POSITIVE_INFINITY, 0, MAX);
  box.fill(Number.NEGATIVE_INFINITY, MAX, SOLID_BOX_FLOATS);
  for (let i = 0; i < mesh.positions.length; i += POSITION_FLOATS) {
    for (let axis = 0; axis < POSITION_FLOATS; axis++) {
      const value = mesh.positions[i + axis] ?? 0;
      box[axis] = Math.min(box[axis] ?? 0, value);
      box[MAX + axis] = Math.max(box[MAX + axis] ?? 0, value);
    }
  }
  return box;
}

function farthestVertex(mesh: MeshArrays): number {
  let farthest = 0;
  for (let i = 0; i < mesh.positions.length; i += POSITION_FLOATS) {
    const x = mesh.positions[i] ?? 0;
    const y = mesh.positions[i + 1] ?? 0;
    const z = mesh.positions[i + 2] ?? 0;
    farthest = Math.max(farthest, Math.sqrt(x * x + y * y + z * z));
  }
  return farthest;
}

function studSolid(primitive: StudPrimitiveAsset): StudSolid {
  const { mesh } = primitive;
  const count = Math.floor(mesh.indices.length / TRIANGLE_CORNERS);
  const triangles = new Float64Array(count * SOLID_TRIANGLE_FLOATS);
  writeMeshTriangles(mesh.positions, mesh.indices, null, 0, triangles, 0);
  return { box: primitiveBox(mesh), triangles };
}

export class PartSolids implements IPartSolids {
  private readonly primitives: ReadonlyArray<StudSolid>;
  private readonly boxes: Array<Float64Array | undefined> = [];
  private readonly solids: Array<PartSolid | undefined> = [];
  private readonly studBounds = new Float64Array(SOLID_BOX_FLOATS);

  private readonly reach: number;

  constructor(
    private readonly source: SolidSource,
    private readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>,
  ) {
    this.primitives = studPrimitives.map(studSolid);
    this.reach = Math.max(0, ...studPrimitives.map(({ mesh }) => farthestVertex(mesh)));
  }

  studReach(): number {
    return this.reach;
  }

  box(partIndex: number): Float64Array {
    const known = this.boxes[partIndex];
    if (known) return known;
    const part = this.partAt(partIndex);
    const box = new Float64Array(SOLID_BOX_FLOATS);
    for (let axis = 0; axis < POSITION_FLOATS; axis++) {
      box[axis] = part.boundsMin[axis] ?? 0;
      box[MAX + axis] = part.boundsMax[axis] ?? 0;
    }
    for (let s = 0; s < part.studPrimitiveIndex.length; s++) {
      const primitive = this.primitives[part.studPrimitiveIndex[s] ?? 0];
      if (!primitive) continue;
      posedBoxBounds(
        part.studMatrices,
        s * INSTANCE_MATRIX_FLOATS,
        primitive.box,
        0,
        this.studBounds,
        0,
      );
      for (let axis = 0; axis < POSITION_FLOATS; axis++) {
        box[axis] = Math.min(box[axis] ?? 0, this.studBounds[axis] ?? 0);
        box[MAX + axis] = Math.max(box[MAX + axis] ?? 0, this.studBounds[MAX + axis] ?? 0);
      }
    }
    this.boxes[partIndex] = box;
    return box;
  }

  readiness(partIndex: number): MeshReadiness {
    return this.solids[partIndex] ? "ready" : this.source.readiness(partIndex);
  }

  solid(partIndex: number): PartSolid {
    const known = this.solids[partIndex];
    if (known) return known;
    if (this.source.readiness(partIndex) !== "ready") {
      throw new Error(`palette part ${partIndex} has no mesh to collide with yet`);
    }
    const part = this.partAt(partIndex);
    const studs = part.studPrimitiveIndex.length;
    const bodyTriangles = meshTriangles(part.mesh);
    let total = bodyTriangles;
    for (let s = 0; s < studs; s++) {
      const primitive = this.primitives[part.studPrimitiveIndex[s] ?? 0];
      total += primitive ? primitive.triangles.length / SOLID_TRIANGLE_FLOATS : 0;
    }
    const triangles = new Float64Array(total * SOLID_TRIANGLE_FLOATS);
    let t = 0;
    for (const group of part.mesh.groups) {
      t = writeMeshTriangles(part.mesh.positions, group.indices, null, 0, triangles, t);
    }
    const studFrames = new Float64Array(studs * SOLID_MATRIX_FLOATS);
    for (let s = 0; s < studs; s++) {
      const at = s * INSTANCE_MATRIX_FLOATS;
      if (!invertAffine(part.studMatrices, at, studFrames.subarray(s * SOLID_MATRIX_FLOATS))) {
        throw new Error(`${part.id} stud ${s} has a singular matrix`);
      }
      const mesh = this.studPrimitives[part.studPrimitiveIndex[s] ?? 0]?.mesh;
      if (mesh)
        t = writeMeshTriangles(mesh.positions, mesh.indices, part.studMatrices, at, triangles, t);
    }
    const solid: PartSolid = {
      box: this.box(partIndex),
      triangles,
      bodyTriangles,
      studFrames,
      studPrimitive: part.studPrimitiveIndex,
      primitives: this.primitives,
    };
    this.solids[partIndex] = solid;
    return solid;
  }

  private partAt(partIndex: number): PartAsset {
    const part = this.source.parts()[partIndex];
    if (!part) throw new Error(`no palette part has index ${partIndex}`);
    return part;
  }
}
