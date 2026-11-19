import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import { SOURCES, STATUSES, VECTOR_FLOATS } from "./connector-table.ts";
import {
  PLATE_SIXTEENTHS,
  QUARTER_TURNS,
  STUD_SIXTEENTHS,
  checkPose,
  phaseOf,
  sixteenths,
  verticalSign,
} from "./lattice-frame.ts";
import type { MateFinder } from "./mate-finder.ts";
import { MateClasses } from "./mate-classes.ts";
import { NO_PARTNER, type MateReport } from "./mate-report.ts";
import type { SnapMating } from "./mating.ts";
import { NO_INSTANCE, type ModelConnectors } from "./model-connectors.ts";
import { StudLevel } from "./stud-level.ts";

const WORD_SHIFT = 5;
const WORD_MASK = 31;
const NO_PHASE = -1;
const INITIAL_LEVELS = 4;
const INITIAL_MATCHES = 256;
const PROVENANCES = SOURCES.length * STATUSES.length;
const STUD_CENTRE_SIXTEENTHS = STUD_SIXTEENTHS / 2;

function partnerPhase(phase: number): number {
  return phaseOf(STUD_CENTRE_SIXTEENTHS - phase);
}

function centredCell(turned16: number): number {
  return (turned16 + partnerPhase(phaseOf(turned16)) - STUD_CENTRE_SIXTEENTHS) / STUD_SIXTEENTHS;
}

export class LatticeStudFinder implements MateFinder {
  private readonly classes: MateClasses;
  private readonly levelYs: Int32Array[] = [];
  private readonly levelsOf: StudLevel[][] = [];
  private levelCount = new Int32Array(0);
  private revision = 0;
  private matchedRevision = -1;
  private matchedPhase = NO_PHASE;
  private matchedBaseY = 0;
  private matches = 0;
  private matchGroup = new Int32Array(INITIAL_MATCHES);
  private matchBucket = new Int32Array(INITIAL_MATCHES);
  private matchLevel = new Int32Array(INITIAL_MATCHES);
  private preparedModel: ModelConnectors | null = null;
  private readonly phaseStart = new Int32Array(QUARTER_TURNS + 1);
  private phaseKey = new Int32Array(0);
  private phaseGroupStart = new Int32Array(1);
  private phaseMemberStart = new Int32Array(1);
  private memberConnector = new Int32Array(0);
  private memberGroup = new Int32Array(0);
  private memberCellX = new Int32Array(0);
  private memberCellZ = new Int32Array(0);
  private groupClass = new Int32Array(0);
  private groupAxis = new Int32Array(0);
  private groupY = new Int32Array(0);
  private groupMinX = new Int32Array(0);
  private groupMinZ = new Int32Array(0);
  private groupMaxX = new Int32Array(0);
  private groupMaxZ = new Int32Array(0);
  private groupWords = new Int32Array(0);
  private groupOffset = new Int32Array(0);
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
    this.prepare(model);
    const phaseX = phaseOf(sixteenths(window.x));
    const phaseZ = phaseOf(sixteenths(window.z));
    for (let turn = 0; turn < window.turns; turn++) {
      const rot = (window.rot + turn) % QUARTER_TURNS;
      const phase = this.phaseAt(rot, phaseX, phaseZ);
      if (phase === NO_PHASE) continue;
      for (let y = window.yPlates - window.plates; y <= window.yPlates + window.plates; y++) {
        if (!this.reachesLevel(phase, y)) continue;
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
    this.prepare(model);
    const x16 = sixteenths(pose.x);
    const z16 = sixteenths(pose.z);
    const phaseX = phaseOf(x16);
    const phaseZ = phaseOf(z16);
    const phase = this.phaseAt(pose.rot, phaseX, phaseZ);
    if (phase === NO_PHASE) return 0;
    const cellX = (x16 - phaseX) / STUD_SIXTEENTHS;
    const cellZ = (z16 - phaseZ) / STUD_SIXTEENTHS;
    const baseY = pose.yPlates * PLATE_SIXTEENTHS;
    if (
      this.matchedRevision !== this.revision ||
      this.matchedPhase !== phase ||
      this.matchedBaseY !== baseY
    ) {
      this.match(phase, baseY);
    }
    let n = 0;
    for (let j = 0; j < this.matches; j++) {
      const g = this.matchGroup[j] ?? 0;
      const minX = this.groupMinX[g] ?? 0;
      const minZ = this.groupMinZ[g] ?? 0;
      n +=
        this.levelsOf[this.matchBucket[j] ?? 0]?.[this.matchLevel[j] ?? 0]?.countRows(
          this.raster,
          this.groupOffset[g] ?? 0,
          (this.groupMaxZ[g] ?? 0) - minZ + 1,
          this.groupWords[g] ?? 0,
          cellX + minX,
          cellZ + minZ,
        ) ?? 0;
    }
    return n;
  }

  mates(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    checkPose(pose);
    this.prepare(model);
    const x16 = sixteenths(pose.x);
    const z16 = sixteenths(pose.z);
    const phaseX = phaseOf(x16);
    const phaseZ = phaseOf(z16);
    const phase = this.phaseAt(pose.rot, phaseX, phaseZ);
    if (phase === NO_PHASE) return;
    const cellX = (x16 - phaseX) / STUD_SIXTEENTHS;
    const cellZ = (z16 - phaseZ) / STUD_SIXTEENTHS;
    const baseY = pose.yPlates * PLATE_SIXTEENTHS;
    const classes = this.classes;
    for (
      let k = this.phaseMemberStart[phase] ?? 0;
      k < (this.phaseMemberStart[phase + 1] ?? 0);
      k++
    ) {
      const i = this.memberConnector[k] ?? 0;
      const g = this.memberGroup[k] ?? 0;
      const own = this.groupClass[g] ?? 0;
      const axis = this.groupAxis[g] ?? 0;
      const ownSource = model.source[i] ?? 0;
      const ownStatus = model.status[i] ?? 0;
      const y = (this.groupY[g] ?? 0) + baseY;
      const x = cellX + (this.memberCellX[k] ?? 0);
      const z = cellZ + (this.memberCellZ[k] ?? 0);
      for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
        const partner = classes.pairClass[p] ?? 0;
        const from = y + this.nearestTravel(p, axis);
        const to = y + this.farthestTravel(p, axis);
        for (let q = 0; q < this.presentCount; q++) {
          const provenance = this.present[q] ?? 0;
          const bucket = levelBucket(partner, -axis, provenance);
          const size = this.levelCount[bucket] ?? 0;
          if (size === 0) continue;
          const ys = this.levelYs[bucket];
          const levels = this.levelsOf[bucket];
          if (!ys || !levels) continue;
          for (let l = this.firstLevelFrom(bucket, from); l < size && (ys[l] ?? 0) <= to; l++) {
            if (!this.classes.pairEngages(p, Math.imul((ys[l] ?? 0) - y, axis))) continue;
            if (!levels[l]?.has(x, z)) continue;
            out.push(
              i,
              ownSource | provenanceSource(provenance),
              Math.max(ownStatus, provenanceStatus(provenance)),
              NO_PARTNER,
              model.instance[i] ?? NO_INSTANCE,
              NO_INSTANCE,
              null,
            );
          }
        }
      }
    }
  }

  private stamp(model: ModelConnectors, pose: LatticePose, adding: boolean): void {
    checkPose(pose);
    this.prepare(model);
    const x16 = sixteenths(pose.x);
    const z16 = sixteenths(pose.z);
    const phaseX = phaseOf(x16);
    const phaseZ = phaseOf(z16);
    const phase = this.phaseAt(pose.rot, phaseX, phaseZ);
    if (phase === NO_PHASE) return;
    const cellX = (x16 - phaseX) / STUD_SIXTEENTHS;
    const cellZ = (z16 - phaseZ) / STUD_SIXTEENTHS;
    const baseY = pose.yPlates * PLATE_SIXTEENTHS;
    for (
      let k = this.phaseMemberStart[phase] ?? 0;
      k < (this.phaseMemberStart[phase + 1] ?? 0);
      k++
    ) {
      const i = this.memberConnector[k] ?? 0;
      const g = this.memberGroup[k] ?? 0;
      const provenance = provenanceOf(model.source[i] ?? 0, model.status[i] ?? 0);
      const bucket = levelBucket(this.groupClass[g] ?? 0, this.groupAxis[g] ?? 0, provenance);
      const y = (this.groupY[g] ?? 0) + baseY;
      const x = cellX + (this.memberCellX[k] ?? 0);
      const z = cellZ + (this.memberCellZ[k] ?? 0);
      const l = this.firstLevelFrom(bucket, y);
      const found = l < (this.levelCount[bucket] ?? 0) && this.levelYs[bucket]?.[l] === y;
      const level = found ? this.levelsOf[bucket]?.[l] : undefined;
      if (adding) {
        (level ?? this.addLevel(bucket, l, y)).add(x, z);
        this.use(provenance, 1);
      } else {
        if (!level) throw new RangeError(`no placed connector to remove at cell ${x}, ${z}`);
        level.remove(x, z);
        this.use(provenance, -1);
      }
    }
    this.revision++;
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

  private reachesLevel(phase: number, yPlates: number): boolean {
    const classes = this.classes;
    const baseY = yPlates * PLATE_SIXTEENTHS;
    for (
      let g = this.phaseGroupStart[phase] ?? 0;
      g < (this.phaseGroupStart[phase + 1] ?? 0);
      g++
    ) {
      const own = this.groupClass[g] ?? 0;
      const axis = this.groupAxis[g] ?? 0;
      const y = (this.groupY[g] ?? 0) + baseY;
      for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
        const partner = classes.pairClass[p] ?? 0;
        const from = y + this.nearestTravel(p, axis);
        const to = y + this.farthestTravel(p, axis);
        for (let q = 0; q < this.presentCount; q++) {
          const bucket = levelBucket(partner, -axis, this.present[q] ?? 0);
          const size = this.levelCount[bucket] ?? 0;
          if (size === 0) continue;
          const ys = this.levelYs[bucket];
          if (!ys) continue;
          for (let l = this.firstLevelFrom(bucket, from); l < size && (ys[l] ?? 0) <= to; l++) {
            if (this.classes.pairEngages(p, Math.imul((ys[l] ?? 0) - y, axis))) return true;
          }
        }
      }
    }
    return false;
  }

  private phaseAt(rot: number, phaseX: number, phaseZ: number): number {
    const key = partnerPhase(phaseX) * STUD_SIXTEENTHS + partnerPhase(phaseZ);
    let low = this.phaseStart[rot] ?? 0;
    let high = (this.phaseStart[rot + 1] ?? 0) - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const at = this.phaseKey[middle] ?? 0;
      if (at === key) return middle;
      if (at < key) low = middle + 1;
      else high = middle - 1;
    }
    return NO_PHASE;
  }

  private prepare(model: ModelConnectors): void {
    if (this.preparedModel !== model) this.groupPhases(model);
  }

  private groupPhases(model: ModelConnectors): void {
    const n = model.count;
    const ownClass = new Int32Array(n);
    let vertical = 0;
    for (let i = 0; i < n; i++) {
      ownClass[i] = this.classes.classOf(model.shape[i] ?? 0, model.gender[i] ?? 0);
      if (verticalSign(model.axis[i] ?? 0) !== 0) vertical++;
    }
    const total = vertical * QUARTER_TURNS;
    const entryTurn = new Int32Array(total);
    const entryKey = new Int32Array(total);
    const entryClass = new Int32Array(total);
    const entryAxis = new Int32Array(total);
    const entryY = new Int32Array(total);
    const entryCellX = new Int32Array(total);
    const entryCellZ = new Int32Array(total);
    const entryConnector = new Int32Array(total);
    let e = 0;
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      if (!isRot90(rot)) throw new RangeError(`rotation ${rot} is not a quarter turn 0-3`);
      const cos = rot90Cos(rot);
      const sin = rot90Sin(rot);
      for (let i = 0; i < n; i++) {
        const axis = verticalSign(model.axis[i] ?? 0);
        if (axis === 0) continue;
        const o = i * VECTOR_FLOATS;
        const mx = model.origin[o] ?? 0;
        const mz = model.origin[o + 2] ?? 0;
        const tx = cos * mx + sin * mz;
        const tz = -sin * mx + cos * mz;
        entryTurn[e] = rot;
        entryKey[e] = phaseOf(tx) * STUD_SIXTEENTHS + phaseOf(tz);
        entryClass[e] = ownClass[i] ?? 0;
        entryAxis[e] = axis;
        entryY[e] = model.origin[o + 1] ?? 0;
        entryCellX[e] = centredCell(tx);
        entryCellZ[e] = centredCell(tz);
        entryConnector[e] = i;
        e++;
      }
    }
    const order = Int32Array.from({ length: total }, (_, k) => k).toSorted(
      (a, b) =>
        (entryTurn[a] ?? 0) - (entryTurn[b] ?? 0) ||
        (entryKey[a] ?? 0) - (entryKey[b] ?? 0) ||
        (entryClass[a] ?? 0) - (entryClass[b] ?? 0) ||
        (entryAxis[a] ?? 0) - (entryAxis[b] ?? 0) ||
        (entryY[a] ?? 0) - (entryY[b] ?? 0) ||
        (entryConnector[a] ?? 0) - (entryConnector[b] ?? 0),
    );
    const startsPhase = (k: number): boolean => {
      if (k === 0) return true;
      const a = order[k - 1] ?? 0;
      const b = order[k] ?? 0;
      return entryTurn[a] !== entryTurn[b] || entryKey[a] !== entryKey[b];
    };
    const startsGroup = (k: number): boolean => {
      if (startsPhase(k)) return true;
      const a = order[k - 1] ?? 0;
      const b = order[k] ?? 0;
      return (
        entryClass[a] !== entryClass[b] || entryAxis[a] !== entryAxis[b] || entryY[a] !== entryY[b]
      );
    };
    let phases = 0;
    let groups = 0;
    for (let k = 0; k < total; k++) {
      if (startsPhase(k)) phases++;
      if (startsGroup(k)) groups++;
    }
    this.phaseKey = new Int32Array(phases);
    this.phaseGroupStart = new Int32Array(phases + 1);
    this.phaseMemberStart = new Int32Array(phases + 1);
    this.memberConnector = new Int32Array(total);
    this.memberGroup = new Int32Array(total);
    this.memberCellX = new Int32Array(total);
    this.memberCellZ = new Int32Array(total);
    this.groupClass = new Int32Array(groups);
    this.groupAxis = new Int32Array(groups);
    this.groupY = new Int32Array(groups);
    this.groupMinX = new Int32Array(groups);
    this.groupMinZ = new Int32Array(groups);
    this.groupMaxX = new Int32Array(groups);
    this.groupMaxZ = new Int32Array(groups);
    this.phaseStart.fill(0);
    let phase = -1;
    let g = -1;
    for (let k = 0; k < total; k++) {
      const entry = order[k] ?? 0;
      const cellX = entryCellX[entry] ?? 0;
      const cellZ = entryCellZ[entry] ?? 0;
      if (startsPhase(k)) {
        phase++;
        this.phaseKey[phase] = entryKey[entry] ?? 0;
        this.phaseGroupStart[phase] = g + 1;
        this.phaseMemberStart[phase] = k;
        for (let r = (entryTurn[entry] ?? 0) + 1; r <= QUARTER_TURNS; r++) {
          this.phaseStart[r] = phase + 1;
        }
      }
      if (startsGroup(k)) {
        g++;
        this.groupClass[g] = entryClass[entry] ?? 0;
        this.groupAxis[g] = entryAxis[entry] ?? 0;
        this.groupY[g] = entryY[entry] ?? 0;
        this.groupMinX[g] = cellX;
        this.groupMinZ[g] = cellZ;
        this.groupMaxX[g] = cellX;
        this.groupMaxZ[g] = cellZ;
      }
      this.groupMinX[g] = Math.min(this.groupMinX[g] ?? 0, cellX);
      this.groupMinZ[g] = Math.min(this.groupMinZ[g] ?? 0, cellZ);
      this.groupMaxX[g] = Math.max(this.groupMaxX[g] ?? 0, cellX);
      this.groupMaxZ[g] = Math.max(this.groupMaxZ[g] ?? 0, cellZ);
      this.memberConnector[k] = entryConnector[entry] ?? 0;
      this.memberGroup[k] = g;
      this.memberCellX[k] = cellX;
      this.memberCellZ[k] = cellZ;
    }
    this.phaseGroupStart[phases] = groups;
    this.phaseMemberStart[phases] = total;
    this.rasterize(groups, total);
    this.preparedModel = model;
    this.revision++;
  }

  private rasterize(groups: number, members: number): void {
    this.groupWords = new Int32Array(groups);
    this.groupOffset = new Int32Array(groups);
    let words = 0;
    for (let g = 0; g < groups; g++) {
      const columns = (this.groupMaxX[g] ?? 0) - (this.groupMinX[g] ?? 0);
      const rows = (this.groupMaxZ[g] ?? 0) - (this.groupMinZ[g] ?? 0) + 1;
      const wordsPerRow = (columns >> WORD_SHIFT) + 1;
      this.groupWords[g] = wordsPerRow;
      this.groupOffset[g] = words;
      words += rows * wordsPerRow;
    }
    this.raster = new Uint32Array(words);
    for (let k = 0; k < members; k++) {
      const g = this.memberGroup[k] ?? 0;
      const bx = (this.memberCellX[k] ?? 0) - (this.groupMinX[g] ?? 0);
      const bz = (this.memberCellZ[k] ?? 0) - (this.groupMinZ[g] ?? 0);
      const word = (this.groupOffset[g] ?? 0) + bz * (this.groupWords[g] ?? 0) + (bx >> WORD_SHIFT);
      this.raster[word] = ((this.raster[word] ?? 0) | (1 << (bx & WORD_MASK))) >>> 0;
    }
  }

  private match(phase: number, baseY: number): void {
    const classes = this.classes;
    this.matches = 0;
    for (
      let g = this.phaseGroupStart[phase] ?? 0;
      g < (this.phaseGroupStart[phase + 1] ?? 0);
      g++
    ) {
      const own = this.groupClass[g] ?? 0;
      const axis = this.groupAxis[g] ?? 0;
      const y = (this.groupY[g] ?? 0) + baseY;
      for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
        const partner = classes.pairClass[p] ?? 0;
        const from = y + this.nearestTravel(p, axis);
        const to = y + this.farthestTravel(p, axis);
        for (let q = 0; q < this.presentCount; q++) {
          const bucket = levelBucket(partner, -axis, this.present[q] ?? 0);
          const size = this.levelCount[bucket] ?? 0;
          if (size === 0) continue;
          const ys = this.levelYs[bucket];
          if (!ys) continue;
          for (let l = this.firstLevelFrom(bucket, from); l < size && (ys[l] ?? 0) <= to; l++) {
            if (!this.classes.pairEngages(p, Math.imul((ys[l] ?? 0) - y, axis))) continue;
            if (this.matches === this.matchGroup.length) this.growMatches();
            this.matchGroup[this.matches] = g;
            this.matchBucket[this.matches] = bucket;
            this.matchLevel[this.matches] = l;
            this.matches++;
          }
        }
      }
    }
    this.matchedRevision = this.revision;
    this.matchedPhase = phase;
    this.matchedBaseY = baseY;
  }

  private growMatches(): void {
    const capacity = this.matchGroup.length * 2;
    this.matchGroup = widened(this.matchGroup, capacity);
    this.matchBucket = widened(this.matchBucket, capacity);
    this.matchLevel = widened(this.matchLevel, capacity);
  }

  private nearestTravel(pair: number, axis: number): number {
    const classes = this.classes;
    const first = classes.rangeLow[classes.pairRangeStart[pair] ?? 0] ?? 0;
    const last = classes.rangeHigh[(classes.pairRangeStart[pair + 1] ?? 0) - 1] ?? 0;
    return Math.min(Math.imul(axis, first), Math.imul(axis, last));
  }

  private farthestTravel(pair: number, axis: number): number {
    const classes = this.classes;
    const first = classes.rangeLow[classes.pairRangeStart[pair] ?? 0] ?? 0;
    const last = classes.rangeHigh[(classes.pairRangeStart[pair + 1] ?? 0) - 1] ?? 0;
    return Math.max(Math.imul(axis, first), Math.imul(axis, last));
  }

  private firstLevelFrom(bucket: number, y: number): number {
    const ys = this.levelYs[bucket];
    if (!ys) return 0;
    let low = 0;
    let high = this.levelCount[bucket] ?? 0;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((ys[middle] ?? 0) < y) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private addLevel(bucket: number, at: number, y: number): StudLevel {
    if (bucket >= this.levelCount.length) {
      this.levelCount = widened(this.levelCount, Math.max(bucket + 1, this.levelCount.length * 2));
    }
    const size = this.levelCount[bucket] ?? 0;
    let ys = this.levelYs[bucket] ?? new Int32Array(INITIAL_LEVELS);
    if (size === ys.length) ys = widened(ys, size * 2);
    ys.copyWithin(at + 1, at, size);
    ys[at] = y;
    this.levelYs[bucket] = ys;
    const level = new StudLevel();
    const levels = this.levelsOf[bucket] ?? [];
    levels.splice(at, 0, level);
    this.levelsOf[bucket] = levels;
    this.levelCount[bucket] = size + 1;
    return level;
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

function levelBucket(mateClass: number, axis: number, provenance: number): number {
  return mateClass * BUCKETS_PER_CLASS + (axis > 0 ? PROVENANCES : 0) + provenance;
}

function widened(values: Int32Array, capacity: number): Int32Array<ArrayBuffer> {
  const out = new Int32Array(capacity);
  out.set(values);
  return out;
}
