import { STUD_LDU } from "@brr/math";
import { REPRESENTATION_EPSILON_LDU, type PlaneTransform } from "./cell-raster.ts";

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

interface TriangleCells {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

function triangleCells(t: Float64Array, o: number): TriangleCells {
  return {
    x0: Math.floor(Math.min(t[o] ?? 0, t[o + 3] ?? 0, t[o + 6] ?? 0) / STUD_LDU),
    x1: Math.floor(Math.max(t[o] ?? 0, t[o + 3] ?? 0, t[o + 6] ?? 0) / STUD_LDU),
    z0: Math.floor(Math.min(t[o + 2] ?? 0, t[o + 5] ?? 0, t[o + 8] ?? 0) / STUD_LDU),
    z1: Math.floor(Math.max(t[o + 2] ?? 0, t[o + 5] ?? 0, t[o + 8] ?? 0) / STUD_LDU),
  };
}

export class PlanShell {
  private readonly triangles: Float64Array;
  private readonly cellX0: number;
  private readonly cellZ0: number;
  private readonly width: number;
  private readonly depth: number;
  private readonly cellStart: Int32Array;
  private readonly cellTriangles: Int32Array;
  readonly bottomLdu: number;

  constructor(triangles: Float64Array) {
    this.triangles = triangles;
    const count = Math.floor(triangles.length / TRIANGLE_FLOATS);
    const cells: TriangleCells[] = [];
    let bottom = Number.POSITIVE_INFINITY;
    let x0 = 0;
    let x1 = -1;
    let z0 = 0;
    let z1 = -1;
    for (let k = 0; k < count; k++) {
      const o = k * TRIANGLE_FLOATS;
      bottom = Math.min(
        bottom,
        triangles[o + 1] ?? 0,
        triangles[o + 4] ?? 0,
        triangles[o + 7] ?? 0,
      );
      const c = triangleCells(triangles, o);
      cells.push(c);
      x0 = k === 0 ? c.x0 : Math.min(x0, c.x0);
      x1 = k === 0 ? c.x1 : Math.max(x1, c.x1);
      z0 = k === 0 ? c.z0 : Math.min(z0, c.z0);
      z1 = k === 0 ? c.z1 : Math.max(z1, c.z1);
    }
    this.cellX0 = x0;
    this.cellZ0 = z0;
    this.width = x1 - x0 + 1;
    this.depth = z1 - z0 + 1;
    this.bottomLdu = bottom;
    const counts = new Int32Array(this.width * this.depth + 1);
    for (const c of cells) {
      for (let cz = c.z0; cz <= c.z1; cz++) {
        for (let cx = c.x0; cx <= c.x1; cx++) {
          const at = (cz - z0) * this.width + (cx - x0) + 1;
          counts[at] = (counts[at] ?? 0) + 1;
        }
      }
    }
    for (let i = 1; i < counts.length; i++) counts[i] = (counts[i] ?? 0) + (counts[i - 1] ?? 0);
    this.cellStart = counts.slice();
    const fill = counts.slice();
    this.cellTriangles = new Int32Array(counts.at(-1) ?? 0);
    cells.forEach((c, k) => {
      for (let cz = c.z0; cz <= c.z1; cz++) {
        for (let cx = c.x0; cx <= c.x1; cx++) {
          const cell = (cz - z0) * this.width + (cx - x0);
          this.cellTriangles[fill[cell] ?? 0] = k * TRIANGLE_FLOATS;
          fill[cell] = (fill[cell] ?? 0) + 1;
        }
      }
    });
  }

  spanAt(x: number, z: number, out: Float64Array): boolean {
    const cx = Math.floor(x / STUD_LDU) - this.cellX0;
    const cz = Math.floor(z / STUD_LDU) - this.cellZ0;
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.depth) return false;
    const cell = cz * this.width + cx;
    const from = this.cellStart[cell] ?? 0;
    const to = this.cellStart[cell + 1] ?? 0;
    const t = this.triangles;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (let k = from; k < to; k++) {
      const o = this.cellTriangles[k] ?? 0;
      const ax = t[o] ?? 0;
      const az = t[o + 2] ?? 0;
      const bx = t[o + 3] ?? 0;
      const bz = t[o + 5] ?? 0;
      const qx = t[o + 6] ?? 0;
      const qz = t[o + 8] ?? 0;
      const area = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
      if (area === 0) continue;
      const wa = ((bx - x) * (qz - z) - (bz - z) * (qx - x)) / area;
      const wb = ((qx - x) * (az - z) - (qz - z) * (ax - x)) / area;
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

function restsOnStudLayer(solid: PlacedSolid, bottomLdu: number): boolean {
  return (
    solid.studLayerLdu !== null && bottomLdu >= solid.studLayerLdu - REPRESENTATION_EPSILON_LDU
  );
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
  if (restsOnStudLayer(solid, shell.bottomLdu)) return false;
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
      if (restsOnStudLayer(solid, shellBottom)) continue;
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
