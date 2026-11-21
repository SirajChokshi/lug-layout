import type { PartShape, StudRecord } from "@brr/schema/bundle";
import type { Affine, Vec3 } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { walkPart } from "../ldraw/walk.ts";

const REPRESENTATION_LDU = 1e-9;
const MESH_WELD_LDU = 0.05;
const POSE_KEY_DECIMALS = 3;

export type StudAuditIssueKind =
  | "unextracted-stud"
  | "unmatched-stud"
  | "body-bounds"
  | "stud-primitives";

type Bounds = PartShape["bounds"];

export interface StudAuditIssue {
  readonly kind: StudAuditIssueKind;
  readonly subject: string;
  readonly detail: string;
}

export interface LdrawStud {
  readonly primitive: string;
  readonly matrix: ReadonlyArray<number>;
}

export interface MeasuredPart {
  readonly studs: ReadonlyArray<LdrawStud>;
  readonly body: Bounds;
}

export interface CompiledPart {
  readonly id: string;
  readonly studs: ReadonlyArray<Pick<StudRecord, "primitive" | "matrix">>;
  readonly bounds: Bounds;
}

export interface PartAudit {
  readonly extracted: ReadonlyMap<string, number>;
  readonly baked: ReadonlyMap<string, number>;
  readonly issues: ReadonlyArray<StudAuditIssue>;
}

export function studPrimitiveFiles(
  library: LdrawLibrary,
  names: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  return new Map(
    names.map((name) => {
      const file = library.resolve(name);
      if (file === undefined) throw new Error(`stud primitive ${name} is not in the library`);
      return [file, name];
    }),
  );
}

function pointToYUp([x, y, z]: Vec3): Vec3 {
  return [x, -y + 0, -z + 0];
}

function rowMajorToYUp([a, b, c, d, e, f, g, h, i, x, y, z]: Affine): ReadonlyArray<number> {
  return [a, -b + 0, -c + 0, x, -d + 0, e, f, -y + 0, -g + 0, h, i, -z + 0];
}

export function measurePart(
  library: LdrawLibrary,
  path: string,
  studFiles: ReadonlyMap<string, string>,
): MeasuredPart {
  const studs: LdrawStud[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  walkPart(library, path, {
    reference: (placed) => {
      const primitive = studFiles.get(library.resolve(placed.file) ?? "");
      if (primitive === undefined) return "descend";
      studs.push({ primitive, matrix: rowMajorToYUp(placed.world) });
      return "skip";
    },
    polygon: (polygon) => {
      for (const vertex of polygon.vertices) {
        const point = pointToYUp(vertex);
        for (const axis of [0, 1, 2] as const) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
    },
  });
  return { studs, body: { min, max } };
}

function poseKey(primitive: string, matrix: ReadonlyArray<number>): string {
  return `${primitive}@${[matrix[3], matrix[7], matrix[11]]
    .map((value) => (value ?? NaN).toFixed(POSE_KEY_DECIMALS))
    .join(",")}`;
}

function samePose(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  return (
    a.length === b.length &&
    a.every((value, i) => Math.abs(value - (b[i] ?? NaN)) <= REPRESENTATION_LDU)
  );
}

function counted(studs: ReadonlyArray<{ readonly primitive: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { primitive } of studs) counts.set(primitive, (counts.get(primitive) ?? 0) + 1);
  return counts;
}

function boundsIssue(id: string, measured: Bounds, compiled: Bounds): StudAuditIssue | null {
  const agrees = [0, 1, 2].every(
    (axis) =>
      Math.abs((measured.min[axis] ?? NaN) - (compiled.min[axis] ?? NaN)) <= MESH_WELD_LDU &&
      Math.abs((measured.max[axis] ?? NaN) - (compiled.max[axis] ?? NaN)) <= MESH_WELD_LDU,
  );
  if (agrees) return null;
  return {
    kind: "body-bounds",
    subject: id,
    detail: `mesh bounds ${JSON.stringify(compiled)} differ from the LDraw body without its studs ${JSON.stringify(measured)}`,
  };
}

export function auditPart(measured: MeasuredPart, compiled: CompiledPart): PartAudit {
  const pending = new Map<string, Array<ReadonlyArray<number>>>();
  for (const stud of compiled.studs) {
    const key = poseKey(stud.primitive, stud.matrix);
    pending.set(key, [...(pending.get(key) ?? []), stud.matrix]);
  }
  const extracted: LdrawStud[] = [];
  const baked: LdrawStud[] = [];
  for (const stud of measured.studs) {
    const candidates = pending.get(poseKey(stud.primitive, stud.matrix)) ?? [];
    const match = candidates.findIndex((candidate) => samePose(candidate, stud.matrix));
    if (match < 0) {
      baked.push(stud);
      continue;
    }
    candidates.splice(match, 1);
    extracted.push(stud);
  }
  const issues: StudAuditIssue[] = [...counted(baked)].map(([primitive, count]) => ({
    kind: "unextracted-stud",
    subject: compiled.id,
    detail: `${count} ${primitive} reference(s) have no stud at the same pose in the GLB`,
  }));
  const unmatched = [...pending.values()].reduce((sum, left) => sum + left.length, 0);
  if (unmatched > 0) {
    issues.push({
      kind: "unmatched-stud",
      subject: compiled.id,
      detail: `${unmatched} GLB stud(s) match no stud reference in the LDraw file`,
    });
  }
  const bounds = boundsIssue(compiled.id, measured.body, compiled.bounds);
  if (bounds !== null) issues.push(bounds);
  return { extracted: counted(extracted), baked: counted(baked), issues };
}
