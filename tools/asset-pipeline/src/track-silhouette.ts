import { STUD_LDU, ZETA16_ORDER, zeta16ToStuds, type Pose16 } from "@brr/math";
import type { TrackPartFrame, TrackPlan } from "@brr/schema/bundle";
import ClipperLib from "clipper-lib";
import earcut from "earcut";

const HALF_STEP_RADIANS = Math.PI / ZETA16_ORDER;
const HEADING_RADIANS = 2 * HALF_STEP_RADIANS;
const CLIPPER_SCALE = 1e9;
const POSITION_FLOATS = 3;

export interface PlanMesh {
  readonly positions: Float32Array;
  readonly groups: ReadonlyArray<{ readonly indices: Uint32Array }>;
}

function scaled(value: number): number {
  return Math.round(value * CLIPPER_SCALE);
}

type PlanPoint = readonly [number, number];

function footprintFrameTriangles(
  mesh: PlanMesh,
  headingHalfSteps: number,
): ReadonlyArray<ReadonlyArray<PlanPoint>> {
  const phi = headingHalfSteps * HALF_STEP_RADIANS;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const { positions } = mesh;
  const point = (vertex: number): PlanPoint => {
    const px = positions[vertex * POSITION_FLOATS] ?? 0;
    const pz = positions[vertex * POSITION_FLOATS + 2] ?? 0;
    return [c * px - s * pz, s * px + c * pz];
  };
  const triangles: Array<ReadonlyArray<PlanPoint>> = [];
  for (const { indices } of mesh.groups) {
    for (let t = 0; t + 3 <= indices.length; t += 3) {
      triangles.push([
        point(indices[t] ?? 0),
        point(indices[t + 1] ?? 0),
        point(indices[t + 2] ?? 0),
      ]);
    }
  }
  return triangles;
}

function scaledPaths(polygons: ReadonlyArray<ReadonlyArray<PlanPoint>>): ClipperLib.Paths {
  const paths: ClipperLib.Paths = [];
  for (const polygon of polygons) {
    const path = polygon.map(([x, z]) => ({ X: scaled(x), Y: scaled(z) }));
    if (path.length < 3 || ClipperLib.Clipper.Area(path) === 0) continue;
    paths.push(ClipperLib.Clipper.Orientation(path) ? path : path.toReversed());
  }
  return paths;
}

function union(paths: ClipperLib.Paths): ClipperLib.PolyTree {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  const nonZero = ClipperLib.PolyFillType.pftNonZero;
  if (!clipper.Execute(ClipperLib.ClipType.ctUnion, tree, nonZero, nonZero)) {
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

interface HalfPlane {
  readonly nx: number;
  readonly nz: number;
  readonly limit: number;
}

function connectorHalfPlanes(
  connectors: ReadonlyArray<Pose16>,
  frame: TrackPartFrame,
): ReadonlyArray<HalfPlane> {
  return connectors.map((connector) => {
    const at = zeta16ToStuds(connector.position);
    const nx = Math.cos(connector.heading * HEADING_RADIANS);
    const nz = Math.sin(connector.heading * HEADING_RADIANS);
    const limit = nx * (at.x * STUD_LDU - frame.xLdu) + nz * (at.z * STUD_LDU - frame.zLdu);
    return { nx, nz, limit };
  });
}

function clipToHalfPlane(
  polygon: ReadonlyArray<PlanPoint>,
  { nx, nz, limit }: HalfPlane,
): ReadonlyArray<PlanPoint> {
  const out: PlanPoint[] = [];
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length] ?? a;
    const da = nx * a[0] + nz * a[1] - limit;
    const db = nx * b[0] + nz * b[1] - limit;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  });
  return out;
}

export function trackPlans(
  mesh: PlanMesh,
  frame: TrackPartFrame,
  connectors: ReadonlyArray<Pose16>,
): { readonly plan: TrackPlan; readonly support: TrackPlan } {
  const triangles = footprintFrameTriangles(mesh, frame.headingHalfSteps);
  const planes = connectorHalfPlanes(connectors, frame);
  const spans = triangles.map((triangle) =>
    planes.reduce<ReadonlyArray<PlanPoint>>(clipToHalfPlane, triangle),
  );
  return {
    plan: triangulated(union(scaledPaths(triangles))),
    support: triangulated(union(scaledPaths(spans))),
  };
}
