import { PLATE_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import { SOURCES, STATUSES, VECTOR_FLOATS } from "./connector-table.ts";
import { QUARTER_TURNS, checkPose, isLatticeStud, phaseOf, verticalSign } from "./lattice-frame.ts";
import type { MateFinder } from "./mate-finder.ts";
import { MateClasses } from "./mate-classes.ts";
import type { MateReport } from "./mate-report.ts";
import type { SnapMating } from "./mating.ts";
import type { ModelConnectors } from "./model-connectors.ts";
import { StudLevel } from "./stud-level.ts";

const STUD_CENTRE_LDU = STUD_LDU / 2;
const LEVEL_Y_SPAN = 2 ** 20;
const LEVEL_Y_BIAS = LEVEL_Y_SPAN / 2;
const WORD_SHIFT = 5;
const WORD_MASK = 31;
const NOT_ON_LATTICE = -1;
const INITIAL_GROUPS = 16;
const PROVENANCES = SOURCES.length * STATUSES.length;

export class LatticeStudFinder implements MateFinder {
  private readonly classes: MateClasses;
  private readonly levels = new Map<number, StudLevel>();
  private rasterModel: ModelConnectors | null = null;
  private rasterPhaseX = 0;
  private rasterPhaseZ = 0;
  private connectorGroup = new Int32Array(0);
  private connectorCellX = new Int32Array(0);
  private connectorCellZ = new Int32Array(0);
  private readonly groupStart = new Int32Array(QUARTER_TURNS + 1);
  private groupClass = new Int32Array(INITIAL_GROUPS);
  private groupAxis = new Int32Array(INITIAL_GROUPS);
  private groupY = new Int32Array(INITIAL_GROUPS);
  private groupMinX = new Int32Array(INITIAL_GROUPS);
  private groupMinZ = new Int32Array(INITIAL_GROUPS);
  private groupMaxX = new Int32Array(INITIAL_GROUPS);
  private groupMaxZ = new Int32Array(INITIAL_GROUPS);
  private groupWords = new Int32Array(INITIAL_GROUPS);
  private groupOffset = new Int32Array(INITIAL_GROUPS);
  private raster = new Uint32Array(0);
  private readonly provenanceUses = new Int32Array(PROVENANCES);
  private readonly present = new Int32Array(PROVENANCES);
  private presentCount = 0;

  constructor(mating: SnapMating) {
    this.classes = new MateClasses(mating);
  }

  insert(model: ModelConnectors, pose: LatticePose): void {
    this.stamp(model, pose, true);
  }

  remove(model: ModelConnectors, pose: LatticePose): void {
    this.stamp(model, pose, false);
  }

  propose(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void {
    checkPose(window);
    this.prepare(model, phaseOf(window.x), phaseOf(window.z));
    for (let turn = 0; turn < window.turns; turn++) {
      const rot = (window.rot + turn) % QUARTER_TURNS;
      for (let y = window.yPlates - window.plates; y <= window.yPlates + window.plates; y++) {
        if (!this.reachesLevel(rot, y)) continue;
        for (let dz = -window.cells; dz <= window.cells; dz++) {
          for (let dx = -window.cells; dx <= window.cells; dx++) {
            out.add(window.x + dx * STUD_LDU, window.z + dz * STUD_LDU, y, rot);
          }
        }
      }
    }
  }

  count(model: ModelConnectors, pose: LatticePose): number {
    checkPose(pose);
    const phaseX = phaseOf(pose.x);
    const phaseZ = phaseOf(pose.z);
    this.prepare(model, phaseX, phaseZ);
    const cellX = (pose.x - phaseX) / STUD_LDU;
    const cellZ = (pose.z - phaseZ) / STUD_LDU;
    const baseY = pose.yPlates * PLATE_LDU;
    const classes = this.classes;
    let n = 0;
    for (let g = this.groupStart[pose.rot] ?? 0; g < (this.groupStart[pose.rot + 1] ?? 0); g++) {
      const own = this.groupClass[g] ?? 0;
      const axis = this.groupAxis[g] ?? 0;
      const y = (this.groupY[g] ?? 0) + baseY;
      const minX = this.groupMinX[g] ?? 0;
      const minZ = this.groupMinZ[g] ?? 0;
      const rows = (this.groupMaxZ[g] ?? 0) - minZ + 1;
      const words = this.groupWords[g] ?? 0;
      const offset = this.groupOffset[g] ?? 0;
      for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
        const partner = classes.pairClass[p] ?? 0;
        for (
          let k = classes.pairOffsetStart[p] ?? 0;
          k < (classes.pairOffsetStart[p + 1] ?? 0);
          k++
        ) {
          const partnerY = y + axis * (classes.offsets[k] ?? 0);
          for (let q = 0; q < this.presentCount; q++) {
            const level = this.levels.get(levelKey(partner, -axis, this.present[q] ?? 0, partnerY));
            if (!level) continue;
            n += level.countRows(this.raster, offset, rows, words, cellX + minX, cellZ + minZ);
          }
        }
      }
    }
    return n;
  }

  mates(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    checkPose(pose);
    const phaseX = phaseOf(pose.x);
    const phaseZ = phaseOf(pose.z);
    this.prepare(model, phaseX, phaseZ);
    const cellX = (pose.x - phaseX) / STUD_LDU;
    const cellZ = (pose.z - phaseZ) / STUD_LDU;
    const baseY = pose.yPlates * PLATE_LDU;
    const classes = this.classes;
    const at = pose.rot * model.count;
    for (let i = 0; i < model.count; i++) {
      const g = this.connectorGroup[at + i] ?? NOT_ON_LATTICE;
      if (g === NOT_ON_LATTICE) continue;
      const own = this.groupClass[g] ?? 0;
      const axis = this.groupAxis[g] ?? 0;
      const ownSource = model.source[i] ?? 0;
      const ownStatus = model.status[i] ?? 0;
      const y = (model.origin[i * VECTOR_FLOATS + 1] ?? 0) + baseY;
      const x = cellX + (this.connectorCellX[at + i] ?? 0);
      const z = cellZ + (this.connectorCellZ[at + i] ?? 0);
      for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
        const partner = classes.pairClass[p] ?? 0;
        for (
          let k = classes.pairOffsetStart[p] ?? 0;
          k < (classes.pairOffsetStart[p + 1] ?? 0);
          k++
        ) {
          const partnerY = y + axis * (classes.offsets[k] ?? 0);
          for (let q = 0; q < this.presentCount; q++) {
            const provenance = this.present[q] ?? 0;
            const level = this.levels.get(levelKey(partner, -axis, provenance, partnerY));
            if (!level?.has(x, z)) continue;
            out.push(
              i,
              ownSource | provenanceSource(provenance),
              Math.max(ownStatus, provenanceStatus(provenance)),
            );
          }
        }
      }
    }
  }

  private stamp(model: ModelConnectors, pose: LatticePose, adding: boolean): void {
    checkPose(pose);
    const phaseX = phaseOf(pose.x);
    const phaseZ = phaseOf(pose.z);
    this.prepare(model, phaseX, phaseZ);
    const cellX = (pose.x - phaseX) / STUD_LDU;
    const cellZ = (pose.z - phaseZ) / STUD_LDU;
    const baseY = pose.yPlates * PLATE_LDU;
    const at = pose.rot * model.count;
    for (let i = 0; i < model.count; i++) {
      const g = this.connectorGroup[at + i] ?? NOT_ON_LATTICE;
      if (g === NOT_ON_LATTICE) continue;
      const provenance = provenanceOf(model.source[i] ?? 0, model.status[i] ?? 0);
      const key = levelKey(
        this.groupClass[g] ?? 0,
        this.groupAxis[g] ?? 0,
        provenance,
        (model.origin[i * VECTOR_FLOATS + 1] ?? 0) + baseY,
      );
      const x = cellX + (this.connectorCellX[at + i] ?? 0);
      const z = cellZ + (this.connectorCellZ[at + i] ?? 0);
      let level = this.levels.get(key);
      if (adding) {
        if (!level) {
          level = new StudLevel();
          this.levels.set(key, level);
        }
        level.add(x, z);
        this.use(provenance, 1);
      } else {
        if (!level) throw new RangeError(`no placed connector to remove at cell ${x}, ${z}`);
        level.remove(x, z);
        this.use(provenance, -1);
      }
    }
  }

  private use(provenance: number, delta: number): void {
    const before = this.provenanceUses[provenance] ?? 0;
    const after = before + delta;
    this.provenanceUses[provenance] = after;
    if ((before === 0) === (after === 0)) return;
    this.presentCount = 0;
    for (let p = 0; p < PROVENANCES; p++) {
      if ((this.provenanceUses[p] ?? 0) > 0) this.present[this.presentCount++] = p;
    }
  }

  private reachesLevel(rot: number, yPlates: number): boolean {
    const classes = this.classes;
    const baseY = yPlates * PLATE_LDU;
    for (let g = this.groupStart[rot] ?? 0; g < (this.groupStart[rot + 1] ?? 0); g++) {
      const own = this.groupClass[g] ?? 0;
      const axis = this.groupAxis[g] ?? 0;
      const y = (this.groupY[g] ?? 0) + baseY;
      for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
        const partner = classes.pairClass[p] ?? 0;
        for (
          let k = classes.pairOffsetStart[p] ?? 0;
          k < (classes.pairOffsetStart[p + 1] ?? 0);
          k++
        ) {
          const partnerY = y + axis * (classes.offsets[k] ?? 0);
          for (let q = 0; q < this.presentCount; q++) {
            if (this.levels.has(levelKey(partner, -axis, this.present[q] ?? 0, partnerY))) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  private prepare(model: ModelConnectors, phaseX: number, phaseZ: number): void {
    if (
      this.rasterModel === model &&
      this.rasterPhaseX === phaseX &&
      this.rasterPhaseZ === phaseZ
    ) {
      return;
    }
    const n = model.count;
    if (this.connectorGroup.length < n * QUARTER_TURNS) {
      this.connectorGroup = new Int32Array(n * QUARTER_TURNS);
      this.connectorCellX = new Int32Array(n * QUARTER_TURNS);
      this.connectorCellZ = new Int32Array(n * QUARTER_TURNS);
    }
    let groups = 0;
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      this.groupStart[rot] = groups;
      groups = this.groupTurn(model, rot, phaseX, phaseZ, groups);
    }
    this.groupStart[QUARTER_TURNS] = groups;
    let words = 0;
    for (let g = 0; g < groups; g++) {
      const columns = (this.groupMaxX[g] ?? 0) - (this.groupMinX[g] ?? 0);
      const rows = (this.groupMaxZ[g] ?? 0) - (this.groupMinZ[g] ?? 0) + 1;
      const wordsPerRow = (columns >> WORD_SHIFT) + 1;
      this.groupWords[g] = wordsPerRow;
      this.groupOffset[g] = words;
      words += rows * wordsPerRow;
    }
    if (this.raster.length < words) this.raster = new Uint32Array(words);
    this.raster.fill(0, 0, words);
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      const at = rot * n;
      for (let i = 0; i < n; i++) {
        const g = this.connectorGroup[at + i] ?? NOT_ON_LATTICE;
        if (g === NOT_ON_LATTICE) continue;
        const bx = (this.connectorCellX[at + i] ?? 0) - (this.groupMinX[g] ?? 0);
        const bz = (this.connectorCellZ[at + i] ?? 0) - (this.groupMinZ[g] ?? 0);
        const word =
          (this.groupOffset[g] ?? 0) + bz * (this.groupWords[g] ?? 0) + (bx >> WORD_SHIFT);
        this.raster[word] = ((this.raster[word] ?? 0) | (1 << (bx & WORD_MASK))) >>> 0;
      }
    }
    this.rasterModel = model;
    this.rasterPhaseX = phaseX;
    this.rasterPhaseZ = phaseZ;
  }

  private groupTurn(
    model: ModelConnectors,
    rot: number,
    phaseX: number,
    phaseZ: number,
    firstGroup: number,
  ): number {
    const turn = rot % QUARTER_TURNS;
    if (!isRot90(turn)) throw new RangeError(`rotation ${rot} is not a quarter turn 0-3`);
    const cos = rot90Cos(turn);
    const sin = rot90Sin(turn);
    const at = rot * model.count;
    let groups = firstGroup;
    for (let i = 0; i < model.count; i++) {
      this.connectorGroup[at + i] = NOT_ON_LATTICE;
      const o = i * VECTOR_FLOATS;
      const mx = model.origin[o] ?? 0;
      const mz = model.origin[o + 2] ?? 0;
      const phasedX = cos * mx + sin * mz + phaseX;
      const phasedZ = -sin * mx + cos * mz + phaseZ;
      if (!isLatticeStud(model.axis[i] ?? 0, phasedX, phasedZ)) continue;
      const cellX = (phasedX - STUD_CENTRE_LDU) / STUD_LDU;
      const cellZ = (phasedZ - STUD_CENTRE_LDU) / STUD_LDU;
      const own = this.classes.classOf(model.shape[i] ?? 0, model.gender[i] ?? 0);
      const axis = verticalSign(model.axis[i] ?? 0);
      const y = model.origin[o + 1] ?? 0;
      let g = firstGroup;
      while (
        g < groups &&
        (this.groupClass[g] !== own || this.groupAxis[g] !== axis || this.groupY[g] !== y)
      ) {
        g++;
      }
      if (g === groups) {
        if (groups === this.groupClass.length) this.growGroups();
        this.groupClass[g] = own;
        this.groupAxis[g] = axis;
        this.groupY[g] = y;
        this.groupMinX[g] = cellX;
        this.groupMinZ[g] = cellZ;
        this.groupMaxX[g] = cellX;
        this.groupMaxZ[g] = cellZ;
        groups++;
      } else {
        this.groupMinX[g] = Math.min(this.groupMinX[g] ?? 0, cellX);
        this.groupMinZ[g] = Math.min(this.groupMinZ[g] ?? 0, cellZ);
        this.groupMaxX[g] = Math.max(this.groupMaxX[g] ?? 0, cellX);
        this.groupMaxZ[g] = Math.max(this.groupMaxZ[g] ?? 0, cellZ);
      }
      this.connectorGroup[at + i] = g;
      this.connectorCellX[at + i] = cellX;
      this.connectorCellZ[at + i] = cellZ;
    }
    return groups;
  }

  private growGroups(): void {
    const capacity = this.groupClass.length * 2;
    this.groupClass = widened(this.groupClass, capacity);
    this.groupAxis = widened(this.groupAxis, capacity);
    this.groupY = widened(this.groupY, capacity);
    this.groupMinX = widened(this.groupMinX, capacity);
    this.groupMinZ = widened(this.groupMinZ, capacity);
    this.groupMaxX = widened(this.groupMaxX, capacity);
    this.groupMaxZ = widened(this.groupMaxZ, capacity);
    this.groupWords = widened(this.groupWords, capacity);
    this.groupOffset = widened(this.groupOffset, capacity);
  }
}

const BUCKETS_PER_CLASS = 2 * PROVENANCES;

function provenanceOf(source: number, status: number): number {
  return SOURCES.indexOf(source) * STATUSES.length + status;
}

function provenanceSource(provenance: number): number {
  return SOURCES[Math.floor(provenance / STATUSES.length)] ?? 0;
}

function provenanceStatus(provenance: number): number {
  return provenance % STATUSES.length;
}

function levelKey(mateClass: number, axis: number, provenance: number, yLdu: number): number {
  const bucket = mateClass * BUCKETS_PER_CLASS + (axis > 0 ? PROVENANCES : 0) + provenance;
  return bucket * LEVEL_Y_SPAN + yLdu + LEVEL_Y_BIAS;
}

function widened(values: Int32Array, capacity: number): Int32Array<ArrayBuffer> {
  const out = new Int32Array(capacity);
  out.set(values);
  return out;
}
