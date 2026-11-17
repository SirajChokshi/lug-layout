import { STUD_LDU } from "@brr/math";
import { REPRESENTATION_EPSILON_LDU, packedCellKey, type PlaneTransform } from "./cell-raster.ts";

export interface SolidSamples {
  readonly samplesPerStud: number;
  readonly stepsPerLdu: number;
  readonly lists: Int32Array;
  readonly patterns: Int32Array;
  readonly cells: Int32Array;
}

export interface PlacedSolid {
  readonly samples: SolidSamples;
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
  readonly x: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;
  readonly ySteps: number;
  readonly studLayerLdu: number | null;
}

export interface Contact {
  xLdu: number;
  zLdu: number;
  bottomLdu: number;
  topLdu: number;
  candidateBottomLdu: number;
  candidateTopLdu: number;
}

const NO_LIST = -1;
const TRIANGLE_FLOATS = 9;
const COVERAGE_TOLERANCE = 1e-9;

function samplesPerCell(samples: SolidSamples): number {
  return samples.samplesPerStud * samples.samplesPerStud;
}

function cellPattern(solid: PlacedSolid, cellX: number, cellZ: number): number {
  const centreX = cellX * STUD_LDU + STUD_LDU / 2 - solid.x;
  const centreZ = cellZ * STUD_LDU + STUD_LDU / 2 - solid.z;
  const i = Math.floor((solid.cos * centreX - solid.sin * centreZ) / STUD_LDU) - solid.cellX0;
  const j = Math.floor((solid.sin * centreX + solid.cos * centreZ) / STUD_LDU) - solid.cellZ0;
  if (i < 0 || j < 0 || i >= solid.width || j >= solid.depth) return NO_LIST;
  const pattern = solid.samples.cells[j * solid.width + i] ?? -1;
  return pattern < 0 ? NO_LIST : pattern * samplesPerCell(solid.samples);
}

function listOf(solid: PlacedSolid, pattern: number, i: number, j: number): number {
  const perStud = solid.samples.samplesPerStud;
  const x2 = 2 * i + 1 - perStud;
  const z2 = 2 * j + 1 - perStud;
  const a = (solid.cos * x2 - solid.sin * z2 + perStud - 1) / 2;
  const b = (solid.sin * x2 + solid.cos * z2 + perStud - 1) / 2;
  return solid.samples.patterns[pattern + b * perStud + a] ?? NO_LIST;
}

function sameSampling(a: SolidSamples, b: SolidSamples): void {
  if (a.samplesPerStud !== b.samplesPerStud || a.stepsPerLdu !== b.stepsPerLdu) {
    throw new Error(
      `solids sampled ${a.samplesPerStud}/${a.stepsPerLdu} and ${b.samplesPerStud}/${b.stepsPerLdu} cannot be compared`,
    );
  }
}

export function solidsMeetInCell(
  candidate: PlacedSolid,
  owner: PlacedSolid,
  cellX: number,
  cellZ: number,
  out: Contact,
): boolean {
  sameSampling(candidate.samples, owner.samples);
  const perStud = candidate.samples.samplesPerStud;
  const pitch = STUD_LDU / perStud;
  const steps = candidate.samples.stepsPerLdu;
  const c = candidate.samples.lists;
  const o = owner.samples.lists;
  const candidatePattern = cellPattern(candidate, cellX, cellZ);
  const ownerPattern = cellPattern(owner, cellX, cellZ);
  if (candidatePattern === NO_LIST || ownerPattern === NO_LIST) return false;
  for (let j = 0; j < perStud; j++) {
    for (let i = 0; i < perStud; i++) {
      const cl = listOf(candidate, candidatePattern, i, j);
      const ol = listOf(owner, ownerPattern, i, j);
      const cn = c[cl] ?? 0;
      const on = o[ol] ?? 0;
      let p = 0;
      let q = 0;
      while (p < cn && q < on) {
        const cb = (c[cl + 1 + 2 * p] ?? 0) + candidate.ySteps;
        const ct = (c[cl + 2 + 2 * p] ?? 0) + candidate.ySteps;
        const ob = (o[ol + 1 + 2 * q] ?? 0) + owner.ySteps;
        const ot = (o[ol + 2 + 2 * q] ?? 0) + owner.ySteps;
        if (Math.max(cb, ob) < Math.min(ct, ot)) {
          out.xLdu = cellX * STUD_LDU + (i + 0.5) * pitch;
          out.zLdu = cellZ * STUD_LDU + (j + 0.5) * pitch;
          out.bottomLdu = ob / steps;
          out.topLdu = ot / steps;
          out.candidateBottomLdu = cb / steps;
          out.candidateTopLdu = ct / steps;
          return true;
        }
        if (ct <= ot) p++;
        else q++;
      }
    }
  }
  return false;
}

export class PlanShell {
  private readonly byCell = new Map<number, Int32Array>();
  private readonly triangles: Float64Array;

  constructor(triangles: Float64Array) {
    this.triangles = triangles;
    const lists = new Map<number, number[]>();
    for (let t = 0; t + TRIANGLE_FLOATS <= triangles.length; t += TRIANGLE_FLOATS) {
      const x0 = Math.min(triangles[t] ?? 0, triangles[t + 3] ?? 0, triangles[t + 6] ?? 0);
      const x1 = Math.max(triangles[t] ?? 0, triangles[t + 3] ?? 0, triangles[t + 6] ?? 0);
      const z0 = Math.min(triangles[t + 2] ?? 0, triangles[t + 5] ?? 0, triangles[t + 8] ?? 0);
      const z1 = Math.max(triangles[t + 2] ?? 0, triangles[t + 5] ?? 0, triangles[t + 8] ?? 0);
      for (let cz = Math.floor(z0 / STUD_LDU); cz <= Math.floor(z1 / STUD_LDU); cz++) {
        for (let cx = Math.floor(x0 / STUD_LDU); cx <= Math.floor(x1 / STUD_LDU); cx++) {
          const key = packedCellKey(cx, cz);
          let list = lists.get(key);
          if (!list) {
            list = [];
            lists.set(key, list);
          }
          list.push(t);
        }
      }
    }
    for (const [key, list] of lists) this.byCell.set(key, Int32Array.from(list));
  }

  spanAt(x: number, z: number, out: Float64Array): boolean {
    const list = this.byCell.get(packedCellKey(Math.floor(x / STUD_LDU), Math.floor(z / STUD_LDU)));
    if (!list) return false;
    const t = this.triangles;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < list.length; k++) {
      const o = list[k] ?? 0;
      const ax = t[o] ?? 0;
      const az = t[o + 2] ?? 0;
      const bx = t[o + 3] ?? 0;
      const bz = t[o + 5] ?? 0;
      const cx = t[o + 6] ?? 0;
      const cz = t[o + 8] ?? 0;
      const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (area === 0) continue;
      const wa = ((bx - x) * (cz - z) - (bz - z) * (cx - x)) / area;
      const wb = ((cx - x) * (az - z) - (cz - z) * (ax - x)) / area;
      const wc = 1 - wa - wb;
      if (wa < -COVERAGE_TOLERANCE || wb < -COVERAGE_TOLERANCE || wc < -COVERAGE_TOLERANCE)
        continue;
      const ya = t[o + 1] ?? 0;
      const yb = t[o + 4] ?? 0;
      const yc = t[o + 7] ?? 0;
      const y = ya === yb && yb === yc ? ya : wa * ya + wb * yb + wc * yc;
      if (y < bottom) bottom = y;
      if (y > top) top = y;
    }
    if (top <= bottom) return false;
    out[0] = bottom;
    out[1] = top;
    return true;
  }
}

export interface PlacedShell {
  readonly shell: PlanShell;
  readonly pose: PlaneTransform;
}

const shellSpan = new Float64Array(2);

export function solidMeetsShellInCell(
  solid: PlacedSolid,
  { shell, pose }: PlacedShell,
  solidIsCandidate: boolean,
  cellX: number,
  cellZ: number,
  out: Contact,
): boolean {
  const perStud = solid.samples.samplesPerStud;
  const pitch = STUD_LDU / perStud;
  const steps = solid.samples.stepsPerLdu;
  const lists = solid.samples.lists;
  const pattern = cellPattern(solid, cellX, cellZ);
  if (pattern === NO_LIST) return false;
  for (let j = 0; j < perStud; j++) {
    const z = cellZ * STUD_LDU + (j + 0.5) * pitch;
    for (let i = 0; i < perStud; i++) {
      const x = cellX * STUD_LDU + (i + 0.5) * pitch;
      const list = listOf(solid, pattern, i, j);
      const dx = x - pose.x;
      const dz = z - pose.z;
      if (!shell.spanAt(pose.cos * dx + pose.sin * dz, pose.cos * dz - pose.sin * dx, shellSpan)) {
        continue;
      }
      const shellBottom = shellSpan[0] ?? 0;
      const shellTop = shellSpan[1] ?? 0;
      if (
        solid.studLayerLdu !== null &&
        shellBottom >= solid.studLayerLdu - REPRESENTATION_EPSILON_LDU
      ) {
        continue;
      }
      const count = lists[list] ?? 0;
      for (let k = 0; k < count; k++) {
        const bottomLdu = ((lists[list + 1 + 2 * k] ?? 0) + solid.ySteps) / steps;
        const topLdu = ((lists[list + 2 + 2 * k] ?? 0) + solid.ySteps) / steps;
        const shared = Math.min(topLdu, shellTop) - Math.max(bottomLdu, shellBottom);
        if (shared <= REPRESENTATION_EPSILON_LDU) continue;
        out.xLdu = x;
        out.zLdu = z;
        out.bottomLdu = solidIsCandidate ? shellBottom : bottomLdu;
        out.topLdu = solidIsCandidate ? shellTop : topLdu;
        out.candidateBottomLdu = solidIsCandidate ? bottomLdu : shellBottom;
        out.candidateTopLdu = solidIsCandidate ? topLdu : shellTop;
        return true;
      }
    }
  }
  return false;
}
