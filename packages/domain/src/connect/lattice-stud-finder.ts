import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import { SOURCES, STATUSES, VECTOR_FLOATS } from "./connector-table.ts";
import { IntKeyMap, MISSING } from "./int-key-map.ts";
import {
  PLATE_SIXTEENTHS,
  QUARTER_TURNS,
  STUD_SIXTEENTHS,
  checkPose,
  phaseOf,
  sixteenths,
  verticalSign,
} from "./lattice-frame.ts";
import type { UnnamedPartnerFinder } from "./mate-finder.ts";
import type { ProposalProgress } from "./proposal-progress.ts";
import { MateClasses } from "./mate-classes.ts";
import { MODEL_CACHE_CONNECTORS, MODEL_CACHE_MODELS, ModelCache } from "./model-cache.ts";
import { NO_PARTNER, type MateReport } from "./mate-report.ts";
import type { SnapMating } from "./mating.ts";
import { NO_INSTANCE, type ModelConnectors } from "./model-connectors.ts";
import { StudLevel } from "./stud-level.ts";

const WORD_SHIFT = 5;
const WORD_MASK = 31;
const NO_PHASE = -1;
const INITIAL_LEVELS = 4;
const INITIAL_MATCHES = 256;
const MATCHED_ENTRIES = 256;
const KEPT_MATCHES = 2 ** 16;
const MATCHED_KEY_INTS = 2;
const PROVENANCES = SOURCES.length * STATUSES.length;
const STUD_CENTRE_SIXTEENTHS = STUD_SIXTEENTHS / 2;

function partnerPhase(phase: number): number {
  return phaseOf(STUD_CENTRE_SIXTEENTHS - phase);
}

function centredCell(turned16: number): number {
  return (turned16 + partnerPhase(phaseOf(turned16)) - STUD_CENTRE_SIXTEENTHS) / STUD_SIXTEENTHS;
}

class PhaseGroups {
  readonly phaseStart = new Int32Array(QUARTER_TURNS + 1);
  phaseKey = new Int32Array(0);
  phaseGroupStart = new Int32Array(1);
  phaseMemberStart = new Int32Array(1);
  memberConnector = new Int32Array(0);
  memberGroup = new Int32Array(0);
  memberCellX = new Int32Array(0);
  memberCellZ = new Int32Array(0);
  groupMemberStart = new Int32Array(1);
  groupClass = new Int32Array(0);
  groupAxis = new Int32Array(0);
  groupY = new Int32Array(0);
  groupMinX = new Int32Array(0);
  groupMinZ = new Int32Array(0);
  groupMaxX = new Int32Array(0);
  groupMaxZ = new Int32Array(0);
  groupWords = new Int32Array(0);
  groupOffset = new Int32Array(0);
  raster = new Uint32Array(0);

  static of(model: ModelConnectors, classes: MateClasses): PhaseGroups {
    const prepared = new PhaseGroups();
    const n = model.count;
    const ownClass = classes.classesOf(model);
    let vertical = 0;
    for (let i = 0; i < n; i++) {
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
    prepared.phaseKey = new Int32Array(phases);
    prepared.phaseGroupStart = new Int32Array(phases + 1);
    prepared.phaseMemberStart = new Int32Array(phases + 1);
    prepared.memberConnector = new Int32Array(total);
    prepared.memberGroup = new Int32Array(total);
    prepared.memberCellX = new Int32Array(total);
    prepared.memberCellZ = new Int32Array(total);
    prepared.groupMemberStart = new Int32Array(groups + 1);
    prepared.groupClass = new Int32Array(groups);
    prepared.groupAxis = new Int32Array(groups);
    prepared.groupY = new Int32Array(groups);
    prepared.groupMinX = new Int32Array(groups);
    prepared.groupMinZ = new Int32Array(groups);
    prepared.groupMaxX = new Int32Array(groups);
    prepared.groupMaxZ = new Int32Array(groups);
    let phase = -1;
    let g = -1;
    for (let k = 0; k < total; k++) {
      const entry = order[k] ?? 0;
      const cellX = entryCellX[entry] ?? 0;
      const cellZ = entryCellZ[entry] ?? 0;
      if (startsPhase(k)) {
        phase++;
        prepared.phaseKey[phase] = entryKey[entry] ?? 0;
        prepared.phaseGroupStart[phase] = g + 1;
        prepared.phaseMemberStart[phase] = k;
        for (let r = (entryTurn[entry] ?? 0) + 1; r <= QUARTER_TURNS; r++) {
          prepared.phaseStart[r] = phase + 1;
        }
      }
      if (startsGroup(k)) {
        g++;
        prepared.groupMemberStart[g] = k;
        prepared.groupClass[g] = entryClass[entry] ?? 0;
        prepared.groupAxis[g] = entryAxis[entry] ?? 0;
        prepared.groupY[g] = entryY[entry] ?? 0;
        prepared.groupMinX[g] = cellX;
        prepared.groupMinZ[g] = cellZ;
        prepared.groupMaxX[g] = cellX;
        prepared.groupMaxZ[g] = cellZ;
      }
      prepared.groupMinX[g] = Math.min(prepared.groupMinX[g] ?? 0, cellX);
      prepared.groupMinZ[g] = Math.min(prepared.groupMinZ[g] ?? 0, cellZ);
      prepared.groupMaxX[g] = Math.max(prepared.groupMaxX[g] ?? 0, cellX);
      prepared.groupMaxZ[g] = Math.max(prepared.groupMaxZ[g] ?? 0, cellZ);
      prepared.memberConnector[k] = entryConnector[entry] ?? 0;
      prepared.memberGroup[k] = g;
      prepared.memberCellX[k] = cellX;
      prepared.memberCellZ[k] = cellZ;
    }
    prepared.phaseGroupStart[phases] = groups;
    prepared.phaseMemberStart[phases] = total;
    prepared.groupMemberStart[groups] = total;
    prepared.rasterize(groups, total);
    return prepared;
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
}

export class LatticeStudFinder implements UnnamedPartnerFinder {
  readonly namesPartners = false;
  readonly proposesEveryPose = true;
  private readonly classes: MateClasses;
  private readonly levelYs: Int32Array[] = [];
  private readonly levelsOf: StudLevel[][] = [];
  private levelCount = new Int32Array(0);
  private revision = 0;
  private matchedRevision = -1;
  private readonly matchedEntries = new IntKeyMap(MATCHED_KEY_INTS);
  private readonly matchedKey = new Int32Array(MATCHED_KEY_INTS);
  private readonly matchedStart = new Int32Array(MATCHED_ENTRIES + 1);
  private matchedEntryCount = 0;
  private matches = 0;
  private matchGroup = new Int32Array(INITIAL_MATCHES);
  private matchBucket = new Int32Array(INITIAL_MATCHES);
  private matchLevel = new Int32Array(INITIAL_MATCHES);
  private preparedModel: ModelConnectors | null = null;
  private phases = new PhaseGroups();
  private readonly preparedPhases = new ModelCache<PhaseGroups>(
    MODEL_CACHE_CONNECTORS,
    MODEL_CACHE_MODELS,
  );
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

  placedChanged(): void {
    this.revision++;
  }

  proposeOnLattice(
    model: ModelConnectors,
    window: SnapWindow,
    out: CandidatePoses,
    _progress: ProposalProgress,
    _slotBudget: number,
  ): boolean {
    this.propose(model, window, out);
    return true;
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
    const phases = this.phases;
    const x16 = sixteenths(pose.x);
    const z16 = sixteenths(pose.z);
    const phaseX = phaseOf(x16);
    const phaseZ = phaseOf(z16);
    const phase = this.phaseAt(pose.rot, phaseX, phaseZ);
    if (phase === NO_PHASE) return 0;
    const cellX = (x16 - phaseX) / STUD_SIXTEENTHS;
    const cellZ = (z16 - phaseZ) / STUD_SIXTEENTHS;
    const baseY = pose.yPlates * PLATE_SIXTEENTHS;
    if (this.matchedRevision !== this.revision) this.clearMatches();
    this.matchedKey[0] = phase;
    this.matchedKey[1] = baseY;
    let entry = this.matchedEntries.get(this.matchedKey);
    if (entry === MISSING) entry = this.match(phase, baseY);
    const { raster, groupOffset, groupWords, groupMinX, groupMinZ, groupMaxZ } = phases;
    const end = this.matchedStart[entry + 1] ?? 0;
    let n = 0;
    for (let j = this.matchedStart[entry] ?? 0; j < end; j++) {
      const g = this.matchGroup[j] ?? 0;
      const minX = groupMinX[g] ?? 0;
      const minZ = groupMinZ[g] ?? 0;
      n +=
        this.levelsOf[this.matchBucket[j] ?? 0]?.[this.matchLevel[j] ?? 0]?.countRows(
          raster,
          groupOffset[g] ?? 0,
          (groupMaxZ[g] ?? 0) - minZ + 1,
          groupWords[g] ?? 0,
          cellX + minX,
          cellZ + minZ,
        ) ?? 0;
    }
    return n;
  }

  mates(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    checkPose(pose);
    this.prepare(model);
    const phases = this.phases;
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
    const {
      memberConnector,
      memberGroup,
      memberCellX,
      memberCellZ,
      groupClass,
      groupAxis,
      groupY,
    } = phases;
    for (
      let group = phases.phaseGroupStart[phase] ?? 0;
      group < (phases.phaseGroupStart[phase + 1] ?? 0);
      group++
    ) {
      if (!this.groupHasStuds(group, cellX, cellZ, baseY)) continue;
      for (
        let k = phases.groupMemberStart[group] ?? 0;
        k < (phases.groupMemberStart[group + 1] ?? 0);
        k++
      ) {
        const i = memberConnector[k] ?? 0;
        const g = memberGroup[k] ?? 0;
        const own = groupClass[g] ?? 0;
        const axis = groupAxis[g] ?? 0;
        const ownSource = model.source[i] ?? 0;
        const ownStatus = model.status[i] ?? 0;
        const y = (groupY[g] ?? 0) + baseY;
        const x = cellX + (memberCellX[k] ?? 0);
        const z = cellZ + (memberCellZ[k] ?? 0);
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
                model.shape[i] ?? 0,
                model.gender[i] ?? 0,
                classes.shapeOf(partner),
                classes.genderOf(partner),
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
  }

  private groupHasStuds(group: number, cellX: number, cellZ: number, baseY: number): boolean {
    const phases = this.phases;
    const classes = this.classes;
    const own = phases.groupClass[group] ?? 0;
    const axis = phases.groupAxis[group] ?? 0;
    const y = (phases.groupY[group] ?? 0) + baseY;
    const minX = phases.groupMinX[group] ?? 0;
    const minZ = phases.groupMinZ[group] ?? 0;
    const rows = (phases.groupMaxZ[group] ?? 0) - minZ + 1;
    for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
      const partner = classes.pairClass[p] ?? 0;
      const from = y + this.nearestTravel(p, axis);
      const to = y + this.farthestTravel(p, axis);
      for (let q = 0; q < this.presentCount; q++) {
        const bucket = levelBucket(partner, -axis, this.present[q] ?? 0);
        const size = this.levelCount[bucket] ?? 0;
        if (size === 0) continue;
        const ys = this.levelYs[bucket];
        const levels = this.levelsOf[bucket];
        if (!ys || !levels) continue;
        for (let l = this.firstLevelFrom(bucket, from); l < size && (ys[l] ?? 0) <= to; l++) {
          if (!this.classes.pairEngages(p, Math.imul((ys[l] ?? 0) - y, axis))) continue;
          const studs =
            levels[l]?.countRows(
              phases.raster,
              phases.groupOffset[group] ?? 0,
              rows,
              phases.groupWords[group] ?? 0,
              cellX + minX,
              cellZ + minZ,
            ) ?? 0;
          if (studs > 0) return true;
        }
      }
    }
    return false;
  }

  private stamp(model: ModelConnectors, pose: LatticePose, adding: boolean): void {
    checkPose(pose);
    this.prepare(model);
    const phases = this.phases;
    const x16 = sixteenths(pose.x);
    const z16 = sixteenths(pose.z);
    const phaseX = phaseOf(x16);
    const phaseZ = phaseOf(z16);
    const phase = this.phaseAt(pose.rot, phaseX, phaseZ);
    if (phase === NO_PHASE) return;
    const cellX = (x16 - phaseX) / STUD_SIXTEENTHS;
    const cellZ = (z16 - phaseZ) / STUD_SIXTEENTHS;
    const baseY = pose.yPlates * PLATE_SIXTEENTHS;
    const {
      memberConnector,
      memberGroup,
      memberCellX,
      memberCellZ,
      groupClass,
      groupAxis,
      groupY,
    } = phases;
    for (
      let k = phases.phaseMemberStart[phase] ?? 0;
      k < (phases.phaseMemberStart[phase + 1] ?? 0);
      k++
    ) {
      const i = memberConnector[k] ?? 0;
      const g = memberGroup[k] ?? 0;
      const provenance = provenanceOf(model.source[i] ?? 0, model.status[i] ?? 0);
      const bucket = levelBucket(groupClass[g] ?? 0, groupAxis[g] ?? 0, provenance);
      const y = (groupY[g] ?? 0) + baseY;
      const x = cellX + (memberCellX[k] ?? 0);
      const z = cellZ + (memberCellZ[k] ?? 0);
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
    const phases = this.phases;
    const classes = this.classes;
    const baseY = yPlates * PLATE_SIXTEENTHS;
    for (
      let g = phases.phaseGroupStart[phase] ?? 0;
      g < (phases.phaseGroupStart[phase + 1] ?? 0);
      g++
    ) {
      const own = phases.groupClass[g] ?? 0;
      const axis = phases.groupAxis[g] ?? 0;
      const y = (phases.groupY[g] ?? 0) + baseY;
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
    const phases = this.phases;
    const key = partnerPhase(phaseX) * STUD_SIXTEENTHS + partnerPhase(phaseZ);
    let low = phases.phaseStart[rot] ?? 0;
    let high = (phases.phaseStart[rot + 1] ?? 0) - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const at = phases.phaseKey[middle] ?? 0;
      if (at === key) return middle;
      if (at < key) low = middle + 1;
      else high = middle - 1;
    }
    return NO_PHASE;
  }

  private prepare(model: ModelConnectors): void {
    if (this.preparedModel !== model) this.switchPhases(model);
  }

  private switchPhases(model: ModelConnectors): void {
    let phases = this.preparedPhases.get(model);
    if (phases === undefined) {
      phases = PhaseGroups.of(model, this.classes);
      this.preparedPhases.set(model, phases);
    }
    this.phases = phases;
    this.preparedModel = model;
    this.revision++;
  }

  private match(phase: number, baseY: number): number {
    if (this.matchedEntryCount === MATCHED_ENTRIES || this.matches >= KEPT_MATCHES)
      this.clearMatches();
    const phases = this.phases;
    const classes = this.classes;
    const { groupClass, groupAxis, groupY } = phases;
    for (
      let g = phases.phaseGroupStart[phase] ?? 0;
      g < (phases.phaseGroupStart[phase + 1] ?? 0);
      g++
    ) {
      const own = groupClass[g] ?? 0;
      const axis = groupAxis[g] ?? 0;
      const y = (groupY[g] ?? 0) + baseY;
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
    const entry = this.matchedEntryCount++;
    this.matchedStart[entry + 1] = this.matches;
    this.matchedKey[0] = phase;
    this.matchedKey[1] = baseY;
    this.matchedEntries.set(this.matchedKey, entry);
    return entry;
  }

  private clearMatches(): void {
    this.matchedEntries.clear();
    this.matchedEntryCount = 0;
    this.matches = 0;
    this.matchedStart[0] = 0;
    this.matchedRevision = this.revision;
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
