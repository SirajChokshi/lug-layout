import { ZETA16_ORDER } from "@brr/math";
import type { TrackPlan } from "@brr/schema/bundle";
import ClipperLib from "clipper-lib";
import earcut from "earcut";

const HALF_STEP_RADIANS = Math.PI / ZETA16_ORDER;
const CLIPPER_SCALE = 1e9;
const POSITION_FLOATS = 3;

export interface PlanMesh {
  readonly positions: Float32Array;
  readonly groups: ReadonlyArray<{ readonly indices: Uint32Array }>;
}

function scaled(value: number): number {
  return Math.round(value * CLIPPER_SCALE);
}

function footprintFrameTriangles(mesh: PlanMesh, headingHalfSteps: number): ClipperLib.Paths {
  const phi = headingHalfSteps * HALF_STEP_RADIANS;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const { positions } = mesh;
  const point = (vertex: number): ClipperLib.IntPoint => {
    const px = positions[vertex * POSITION_FLOATS] ?? 0;
    const pz = positions[vertex * POSITION_FLOATS + 2] ?? 0;
    return { X: scaled(c * px - s * pz), Y: scaled(s * px + c * pz) };
  };
  const paths: ClipperLib.Paths = [];
  for (const { indices } of mesh.groups) {
    for (let t = 0; t + 3 <= indices.length; t += 3) {
      const a = point(indices[t] ?? 0);
      const b = point(indices[t + 1] ?? 0);
      const d = point(indices[t + 2] ?? 0);
      const area = (b.X - a.X) * (d.Y - a.Y) - (b.Y - a.Y) * (d.X - a.X);
      if (area === 0) continue;
      paths.push(area > 0 ? [a, b, d] : [a, d, b]);
    }
  }
  return paths;
}

function clipped(
  subject: ClipperLib.Paths,
  clip: ClipperLib.Paths,
  type: ClipperLib.ClipType,
): ClipperLib.PolyTree {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip.length > 0) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  const nonZero = ClipperLib.PolyFillType.pftNonZero;
  if (!clipper.Execute(type, tree, nonZero, nonZero)) {
    throw new Error("Clipper could not combine the plan triangles");
  }
  return tree;
}

function triangulated(tree: ClipperLib.PolyTree): TrackPlan {
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (const polygon of ClipperLib.JS.PolyTreeToExPolygons(tree)) {
    const first = vertices.length / 2;
    const flat: number[] = [];
    const holes: number[] = [];
    for (const ring of [polygon.outer, ...polygon.holes]) {
      if (ring !== polygon.outer) holes.push(flat.length / 2);
      for (const p of ring) flat.push(p.X / CLIPPER_SCALE, p.Y / CLIPPER_SCALE);
    }
    for (const index of earcut(flat, holes)) triangles.push(first + index);
    vertices.push(...flat);
  }
  return { vertices, triangles };
}

export function planSilhouette(mesh: PlanMesh, headingHalfSteps: number): TrackPlan {
  return triangulated(
    clipped(footprintFrameTriangles(mesh, headingHalfSteps), [], ClipperLib.ClipType.ctUnion),
  );
}
