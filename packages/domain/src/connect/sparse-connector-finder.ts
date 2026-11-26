import { CHUNK_LDU, SIXTEENTHS_PER_LDU } from "@brr/math";
import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import {
  GENDER_MALE,
  VECTOR_FLOATS,
  axisDimension,
  axisSign,
  oppositeAxis,
} from "./connector-table.ts";
import { IntKeyMap, MISSING } from "./int-key-map.ts";
import {
  PLATE_SIXTEENTHS,
  QUARTER_TURNS,
  STUD_SIXTEENTHS,
  checkPose,
  isLatticeStud,
  phaseOf,
  rotatedAxis,
  sixteenths,
  verticalSign,
  turnCos,
  turnSin,
} from "./lattice-frame.ts";
import { MateClasses } from "./mate-classes.ts";
import type { MateFinder } from "./mate-finder.ts";
import { MODEL_CACHE_CONNECTORS, MODEL_CACHE_MODELS, ModelCache } from "./model-cache.ts";
import { NO_PROPOSAL_SLOT, ProposalProgress } from "./proposal-progress.ts";
import {
  ENGAGED_AXIS,
  ENGAGED_FROM,
  ENGAGED_RADIUS,
  ENGAGED_TO,
  ENGAGED_U,
  ENGAGED_V,
  ENGAGEMENT_FLOATS,
  type MateReport,
} from "./mate-report.ts";
import { SPAN_FLOATS, SPAN_FROM, SPAN_TO, SPAN_WIDEST, type SnapMating } from "./mating.ts";
import { NO_INSTANCE, type ModelConnectors } from "./model-connectors.ts";

const CELL_SIXTEENTHS = STUD_SIXTEENTHS;
const REGION_SIXTEENTHS = 8 * STUD_SIXTEENTHS;
const CHUNK_SIXTEENTHS = CHUNK_LDU * SIXTEENTHS_PER_LDU;
const REGIONS_PER_CHUNK = CHUNK_SIXTEENTHS / REGION_SIXTEENTHS;
const WALK_MODEL = -1;
const WALKS_PER_PROBE = 8;
const AXIS_CODES = 6;
const GATHER_MARGIN = 2 * STUD_SIXTEENTHS;
const NO_SLOT = MISSING;
const CELL_KEY_INTS = 3;
const MODEL_KEY_INTS = 4;
const BOX_INTS = 6;
const INITIAL_SLOTS = 256;
const UNCLASSED = -1;
const X = 0;
const Y = 1;
const Z = 2;
const AXIAL_GROUP = -1;
const STUD_CENTRE_SIXTEENTHS = STUD_SIXTEENTHS / 2;
const JOINT_KEY_INTS = 6;
const LINE_KEY_INTS = 4;

function cellOf(ldu: number, size: number): number {
  return Math.floor(ldu / size);
}

function axisStep(axis: number, dimension: number): number {
  return axisDimension(axis) === dimension ? axisSign(axis) : 0;
}

function phaseKey(x16: number, z16: number): number {
  return phaseOf(x16) * STUD_SIXTEENTHS + phaseOf(z16);
}

function latticeKey(pose: LatticePose): number {
  return phaseKey(
    STUD_CENTRE_SIXTEENTHS - sixteenths(pose.x),
    STUD_CENTRE_SIXTEENTHS - sixteenths(pose.z),
  );
}

function lineIndex(
  position: Int32Array,
  axis: Int8Array,
  n: number,
  size: number,
): readonly [IntKeyMap, Int32Array<ArrayBuffer>, Int32Array<ArrayBuffer>, Int32Array<ArrayBuffer>] {
  const total = QUARTER_TURNS * n;
  const key = new Int32Array(MODEL_KEY_INTS);
  const lineOf = new Int32Array(total);
  const lines = new IntKeyMap(MODEL_KEY_INTS);
  let count = 0;
  for (let m = 0; m < total; m++) {
    const dimension = axisDimension(axis[m] ?? 0);
    const at = m * VECTOR_FLOATS;
    key[0] = Math.floor(m / n);
    key[1] = dimension;
    key[2] = cellOf(position[at + ((dimension + 1) % VECTOR_FLOATS)] ?? 0, size);
    key[3] = cellOf(position[at + ((dimension + 2) % VECTOR_FLOATS)] ?? 0, size);
    let line = lines.get(key);
    if (line === MISSING) {
      line = count++;
      lines.set(key, line);
    }
    lineOf[m] = line;
  }
  const start = new Int32Array(count + 1);
  for (let m = 0; m < total; m++)
    start[(lineOf[m] ?? 0) + 1] = (start[(lineOf[m] ?? 0) + 1] ?? 0) + 1;
  for (let line = 0; line < count; line++)
    start[line + 1] = (start[line + 1] ?? 0) + (start[line] ?? 0);
  const alongOf = (m: number): number =>
    position[m * VECTOR_FLOATS + axisDimension(axis[m] ?? 0)] ?? 0;
  const order = Int32Array.from({ length: total }, (_, m) => m).toSorted(
    (a, b) => (lineOf[a] ?? 0) - (lineOf[b] ?? 0) || alongOf(a) - alongOf(b) || a - b,
  );
  return [lines, start, order, Int32Array.from(order, alongOf)];
}

function firstAtLeast(values: Int32Array, from: number, to: number, value: number): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((values[middle] ?? 0) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

class TurnedModel {
  constructor(readonly model: ModelConnectors | null) {}
  order = new Int32Array(0);
  groupKey = new Int32Array(0);
  groupEnd = new Int32Array(0);
  readonly groupsOfTurn = new Int32Array(QUARTER_TURNS + 1);
  readonly axesOfTurn = new Uint8Array(QUARTER_TURNS);
  connectorClass = new Int32Array(0);
  classes = new Int32Array(0);
  classCount = 0;
  axisClasses = new Uint8Array(0);
  pairable = new Uint8Array(0);
  pairsWith = new Uint8Array(0);
  position = new Int32Array(0);
  axis = new Int8Array(0);
  readonly box = new Int32Array(QUARTER_TURNS * BOX_INTS);
  exactLines = new IntKeyMap(MODEL_KEY_INTS);
  exactStart = new Int32Array(1);
  exactOrder = new Int32Array(0);
  exactAlong = new Int32Array(0);
  columnLines = new IntKeyMap(MODEL_KEY_INTS);
  columnStart = new Int32Array(1);
  columnOrder = new Int32Array(0);
  columnAlong = new Int32Array(0);
  lineShared = new Uint8Array(0);
}

export class SparseConnectorFinder implements MateFinder {
  readonly namesPartners = true;
  readonly proposesEveryPose = false;
  private readonly classes: MateClasses;
  private readonly cells = new IntKeyMap(CELL_KEY_INTS);
  private readonly regions = new IntKeyMap(CELL_KEY_INTS);
  private readonly chunks = new IntKeyMap(CELL_KEY_INTS);
  private readonly cellKey = new Int32Array(CELL_KEY_INTS);
  private readonly modelKey = new Int32Array(MODEL_KEY_INTS);
  private turned = new TurnedModel(null);
  private readonly turnedModels = new ModelCache<TurnedModel>(
    MODEL_CACHE_CONNECTORS,
    MODEL_CACHE_MODELS,
  );
  private slotX = new Int32Array(INITIAL_SLOTS);
  private slotY = new Int32Array(INITIAL_SLOTS);
  private slotZ = new Int32Array(INITIAL_SLOTS);
  private slotAxis = new Int8Array(INITIAL_SLOTS);
  private slotClass = new Int32Array(INITIAL_SLOTS);
  private slotSource = new Uint8Array(INITIAL_SLOTS);
  private slotStatus = new Uint8Array(INITIAL_SLOTS);
  private slotNext = new Int32Array(INITIAL_SLOTS);
  private slotRegionNext = new Int32Array(INITIAL_SLOTS);
  private slotRegionPrev = new Int32Array(INITIAL_SLOTS);
  private slotOwner = new Int32Array(INITIAL_SLOTS);
  private slotConnector = new Int32Array(INITIAL_SLOTS);
  private slotInstance = new Int32Array(INITIAL_SLOTS);
  private slotShape = new Uint16Array(INITIAL_SLOTS);
  private slotLineShared = new Uint8Array(INITIAL_SLOTS);
  private readonly span = new Float64Array(SPAN_FLOATS);
  private readonly engaged = new Float64Array(ENGAGEMENT_FLOATS);
  private readonly joints = new IntKeyMap(JOINT_KEY_INTS);
  private readonly jointKey = new Int32Array(JOINT_KEY_INTS);
  private nearby = new Int32Array(0);
  private readonly poseBox = new Int32Array(BOX_INTS);
  private readonly block = new Int32Array(BOX_INTS);
  private candidates = new Int32Array(0);
  private readonly proposeBox = new Int32Array(BOX_INTS);
  private readonly wholeWalk = new ProposalProgress();
  private readonly gatheredBox = new Int32Array(QUARTER_TURNS * BOX_INTS);
  private readonly gathered: Int32Array[] = [];
  private readonly gatheredCount = new Int32Array(QUARTER_TURNS);
  private readonly gatheredDense = new Uint8Array(QUARTER_TURNS);
  private readonly gatheredRevision = new Int32Array(QUARTER_TURNS).fill(-1);
  private readonly gatheredReach = new Int32Array(QUARTER_TURNS);
  private revision = 0;
  private slots = 0;
  private freeSlot = NO_SLOT;

  constructor(private readonly mating: SnapMating) {
    this.classes = new MateClasses(mating);
  }

  insert(model: ModelConnectors, pose: LatticePose, owner: number): void {
    checkPose(pose);
    const turned = this.turn(model);
    for (let i = 0; i < model.count; i++) {
      const at = (pose.rot * model.count + i) * VECTOR_FLOATS;
      const x = (turned.position[at + X] ?? 0) + sixteenths(pose.x);
      const y = (turned.position[at + Y] ?? 0) + pose.yPlates * PLATE_SIXTEENTHS;
      const z = (turned.position[at + Z] ?? 0) + sixteenths(pose.z);
      const axis = turned.axis[pose.rot * model.count + i] ?? 0;
      if (isLatticeStud(axis, x, z)) continue;
      const slot = this.allocate();
      this.slotX[slot] = x;
      this.slotY[slot] = y;
      this.slotZ[slot] = z;
      this.slotAxis[slot] = axis;
      this.slotClass[slot] = turned.connectorClass[i] ?? UNCLASSED;
      this.slotSource[slot] = model.source[i] ?? 0;
      this.slotStatus[slot] = model.status[i] ?? 0;
      this.slotOwner[slot] = owner;
      this.slotConnector[slot] = i;
      this.slotInstance[slot] = model.instance[i] ?? NO_INSTANCE;
      this.slotShape[slot] = model.shape[i] ?? 0;
      this.slotLineShared[slot] = turned.lineShared[i] ?? 0;
      this.slotNext[slot] = this.cells.get(this.keyOf(x, y, z, CELL_SIXTEENTHS));
      this.cells.set(this.cellKey, slot);
      const head = this.regions.get(this.keyOf(x, y, z, REGION_SIXTEENTHS));
      this.slotRegionNext[slot] = head;
      this.slotRegionPrev[slot] = NO_SLOT;
      if (head !== NO_SLOT) this.slotRegionPrev[head] = slot;
      this.regions.set(this.cellKey, slot);
      this.countChunk(x, y, z, 1);
    }
    this.revision++;
  }

  remove(model: ModelConnectors, pose: LatticePose, owner: number): void {
    checkPose(pose);
    const turned = this.turn(model);
    for (let i = 0; i < model.count; i++) {
      const at = (pose.rot * model.count + i) * VECTOR_FLOATS;
      const x = (turned.position[at + X] ?? 0) + sixteenths(pose.x);
      const y = (turned.position[at + Y] ?? 0) + pose.yPlates * PLATE_SIXTEENTHS;
      const z = (turned.position[at + Z] ?? 0) + sixteenths(pose.z);
      const axis = turned.axis[pose.rot * model.count + i] ?? 0;
      if (isLatticeStud(axis, x, z)) continue;
      const slot = this.unlinkCell(x, y, z, owner, i);
      this.unlinkRegion(slot);
      this.countChunk(x, y, z, -1);
      this.slotNext[slot] = this.freeSlot;
      this.freeSlot = slot;
    }
    this.revision++;
  }

  placedChanged(): void {
    this.revision++;
  }

  propose(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void {
    this.wholeWalk.restart();
    this.proposeStepping(model, window, out, false, this.wholeWalk, Number.POSITIVE_INFINITY);
  }

  proposeOnLattice(
    model: ModelConnectors,
    window: SnapWindow,
    out: CandidatePoses,
    progress: ProposalProgress,
    slotBudget: number,
  ): boolean {
    return this.proposeStepping(model, window, out, true, progress, slotBudget);
  }

  private proposeStepping(
    model: ModelConnectors,
    window: SnapWindow,
    out: CandidatePoses,
    latticeOnly: boolean,
    progress: ProposalProgress,
    slotBudget: number,
  ): boolean {
    checkPose(window);
    if (progress.resumed && progress.revision !== this.revision) {
      throw new RangeError("the placed connectors changed while a proposal walk was paused");
    }
    progress.revision = this.revision;
    const turned = this.turn(model);
    const reach = this.modelTravel(turned);
    const spanXZ = window.cells * STUD_SIXTEENTHS + reach;
    const spanY = window.plates * PLATE_SIXTEENTHS + reach;
    const baseX = sixteenths(window.x);
    const baseY = window.yPlates * PLATE_SIXTEENTHS;
    const baseZ = sixteenths(window.z);
    let left = slotBudget;
    for (let t = progress.turn; t < window.turns; t++) {
      const rot = (window.rot + t) % QUARTER_TURNS;
      const b = rot * BOX_INTS;
      const minX = baseX + (turned.box[b] ?? 0) - spanXZ;
      const maxX = baseX + (turned.box[b + 3] ?? 0) + spanXZ;
      const minY = baseY + (turned.box[b + 1] ?? 0) - spanY;
      const maxY = baseY + (turned.box[b + 4] ?? 0) + spanY;
      const minZ = baseZ + (turned.box[b + 2] ?? 0) - spanXZ;
      const maxZ = baseZ + (turned.box[b + 5] ?? 0) + spanXZ;
      const fromX = cellOf(minX, REGION_SIXTEENTHS);
      const fromY = cellOf(minY, REGION_SIXTEENTHS);
      const fromZ = cellOf(minZ, REGION_SIXTEENTHS);
      const acrossY = cellOf(maxY, REGION_SIXTEENTHS) - fromY + 1;
      const acrossZ = cellOf(maxZ, REGION_SIXTEENTHS) - fromZ + 1;
      const cells = (cellOf(maxX, REGION_SIXTEENTHS) - fromX + 1) * acrossY * acrossZ;
      const near = this.proposeBox;
      near[0] = minX + reach;
      near[1] = minY + reach;
      near[2] = minZ + reach;
      near[3] = maxX - reach;
      near[4] = maxY - reach;
      near[5] = maxZ - reach;
      for (let c = progress.cell; c < cells; c++) {
        this.cellKey[0] = fromX + Math.floor(c / (acrossY * acrossZ));
        this.cellKey[1] = fromY + (Math.floor(c / acrossZ) % acrossY);
        this.cellKey[2] = fromZ + (c % acrossZ);
        let slot =
          progress.slot === NO_PROPOSAL_SLOT ? this.regions.get(this.cellKey) : progress.slot;
        progress.slot = NO_PROPOSAL_SLOT;
        while (slot !== NO_SLOT) {
          if (left <= 0) {
            progress.turn = t;
            progress.cell = c;
            progress.slot = slot;
            progress.resumed = true;
            return false;
          }
          left--;
          const next = this.slotRegionNext[slot] ?? NO_SLOT;
          if (
            (!latticeOnly || this.pairableSlot(turned, slot, rot)) &&
            this.reachable(slot, near, 0, reach)
          ) {
            const travel = Math.min(reach, this.travelOf(this.slotClass[slot] ?? UNCLASSED));
            this.proposeFromSlot(slot, model.count, rot, window, travel, latticeOnly, out);
          }
          slot = next;
        }
      }
      progress.cell = 0;
    }
    return true;
  }

  count(model: ModelConnectors, pose: LatticePose): number {
    checkPose(pose);
    return this.matesAt(model, pose, null);
  }

  mates(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    checkPose(pose);
    this.matesAt(model, pose, out);
  }

  private matesAt(model: ModelConnectors, pose: LatticePose, out: MateReport | null): number {
    const turned = this.turn(model);
    this.joints.clear();
    const skipped = latticeKey(pose);
    const own = model.count - this.latticeGroupSize(turned, pose.rot, skipped, model.count);
    if (own === 0) return 0;
    const near = this.gatherNear(turned, pose, own);
    if (near === WALK_MODEL) return this.matesFromModel(model, pose, skipped, out);
    let n = 0;
    for (let k = 0; k < near; k++) n += this.slotMates(model, this.nearby[k] ?? 0, pose, out);
    return n;
  }

  private travelOf(mateClass: number): number {
    const low = this.classes.lineLow[mateClass] ?? 0;
    const high = this.classes.lineHigh[mateClass] ?? 0;
    return low > high ? 0 : Math.max(Math.abs(low), Math.abs(high));
  }

  private modelTravel(turned: TurnedModel): number {
    let travel = 0;
    for (let c = 0; c < turned.classes.length; c++) {
      travel = Math.max(travel, this.travelOf(turned.classes[c] ?? UNCLASSED));
    }
    return travel;
  }

  private latticeGroupSize(
    turned: TurnedModel,
    rot: number,
    key: number,
    connectors: number,
  ): number {
    const first = turned.groupsOfTurn[rot] ?? 0;
    let low = first;
    let high = (turned.groupsOfTurn[rot + 1] ?? 0) - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const at = turned.groupKey[middle] ?? 0;
      if (at < key) low = middle + 1;
      else if (at > key) high = middle - 1;
      else {
        const from = middle === first ? rot * connectors : (turned.groupEnd[middle - 1] ?? 0);
        return (turned.groupEnd[middle] ?? 0) - from;
      }
    }
    return 0;
  }

  private gatherNear(turned: TurnedModel, pose: LatticePose, own: number): number {
    const reach = this.modelTravel(turned);
    const rot = pose.rot;
    const box = this.poseBox;
    const b = rot * BOX_INTS;
    box[0] = sixteenths(pose.x) + (turned.box[b] ?? 0);
    box[1] = pose.yPlates * PLATE_SIXTEENTHS + (turned.box[b + 1] ?? 0);
    box[2] = sixteenths(pose.z) + (turned.box[b + 2] ?? 0);
    box[3] = sixteenths(pose.x) + (turned.box[b + 3] ?? 0);
    box[4] = pose.yPlates * PLATE_SIXTEENTHS + (turned.box[b + 4] ?? 0);
    box[5] = sixteenths(pose.z) + (turned.box[b + 5] ?? 0);
    if (!this.gatheredCovers(rot, reach, box)) this.regather(rot, reach, box, own);
    if (this.gatheredDense[rot] === 1) return WALK_MODEL;
    const list = this.gathered[rot] ?? this.nearby;
    const count = this.gatheredCount[rot] ?? 0;
    let budget = own * WALKS_PER_PROBE;
    let near = 0;
    for (let j = 0; j < count; j++) {
      if (--budget < 0) return WALK_MODEL;
      const slot = list[j] ?? 0;
      if (!this.reachable(slot, box, 0, reach)) continue;
      budget -= WALKS_PER_PROBE;
      if (budget < 0) return WALK_MODEL;
      this.nearby[near++] = slot;
    }
    return near;
  }

  private reachable(slot: number, box: Int32Array, at: number, reach: number): boolean {
    const along = axisDimension(this.slotAxis[slot] ?? 0);
    const travel = Math.min(reach, this.travelOf(this.slotClass[slot] ?? UNCLASSED));
    const x = this.slotX[slot] ?? 0;
    const y = this.slotY[slot] ?? 0;
    const z = this.slotZ[slot] ?? 0;
    const sx = along === X ? travel : 0;
    const sy = along === Y ? travel : 0;
    const sz = along === Z ? travel : 0;
    return (
      x >= (box[at] ?? 0) - sx &&
      y >= (box[at + 1] ?? 0) - sy &&
      z >= (box[at + 2] ?? 0) - sz &&
      x <= (box[at + 3] ?? 0) + sx &&
      y <= (box[at + 4] ?? 0) + sy &&
      z <= (box[at + 5] ?? 0) + sz
    );
  }

  private pairsWithTurn(slot: number, rot: number): boolean {
    const turned = this.turned;
    const classes = this.classes;
    const own = this.slotClass[slot] ?? UNCLASSED;
    const row = (rot * AXIS_CODES + oppositeAxis(this.slotAxis[slot] ?? 0)) * turned.classCount;
    for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
      const partner = classes.pairClass[p] ?? UNCLASSED;
      if (partner < turned.classCount && turned.axisClasses[row + partner] === 1) return true;
    }
    return false;
  }

  private gatheredCovers(rot: number, reach: number, box: Int32Array): boolean {
    const wide = this.gatheredBox;
    const at = rot * BOX_INTS;
    return (
      this.gatheredRevision[rot] === this.revision &&
      this.gatheredReach[rot] === reach &&
      (box[0] ?? 0) >= (wide[at] ?? 0) &&
      (box[1] ?? 0) >= (wide[at + 1] ?? 0) &&
      (box[2] ?? 0) >= (wide[at + 2] ?? 0) &&
      (box[3] ?? 0) <= (wide[at + 3] ?? 0) &&
      (box[4] ?? 0) <= (wide[at + 4] ?? 0) &&
      (box[5] ?? 0) <= (wide[at + 5] ?? 0)
    );
  }

  private regather(rot: number, reach: number, box: Int32Array, own: number): void {
    const wide = this.gatheredBox;
    const at = rot * BOX_INTS;
    for (let k = 0; k < BOX_INTS; k++) {
      wide[at + k] = (box[k] ?? 0) + (k < VECTOR_FLOATS ? -GATHER_MARGIN : GATHER_MARGIN);
    }
    this.gatheredRevision[rot] = this.revision;
    this.gatheredReach[rot] = reach;
    this.gatheredDense[rot] = 0;
    let list = this.gathered[rot] ?? new Int32Array(INITIAL_SLOTS);
    let count = 0;
    const limit = own * WALKS_PER_PROBE;
    const minX = (wide[at] ?? 0) - reach;
    const minY = (wide[at + 1] ?? 0) - reach;
    const minZ = (wide[at + 2] ?? 0) - reach;
    const maxX = (wide[at + 3] ?? 0) + reach;
    const maxY = (wide[at + 4] ?? 0) + reach;
    const maxZ = (wide[at + 5] ?? 0) + reach;
    for (let cx = cellOf(minX, CHUNK_SIXTEENTHS); cx <= cellOf(maxX, CHUNK_SIXTEENTHS); cx++) {
      for (let cy = cellOf(minY, CHUNK_SIXTEENTHS); cy <= cellOf(maxY, CHUNK_SIXTEENTHS); cy++) {
        for (let cz = cellOf(minZ, CHUNK_SIXTEENTHS); cz <= cellOf(maxZ, CHUNK_SIXTEENTHS); cz++) {
          this.cellKey[0] = cx;
          this.cellKey[1] = cy;
          this.cellKey[2] = cz;
          if (this.chunks.get(this.cellKey) <= 0) continue;
          const rx0 = Math.max(cx * REGIONS_PER_CHUNK, cellOf(minX, REGION_SIXTEENTHS));
          const ry0 = Math.max(cy * REGIONS_PER_CHUNK, cellOf(minY, REGION_SIXTEENTHS));
          const rz0 = Math.max(cz * REGIONS_PER_CHUNK, cellOf(minZ, REGION_SIXTEENTHS));
          const rx1 = Math.min((cx + 1) * REGIONS_PER_CHUNK - 1, cellOf(maxX, REGION_SIXTEENTHS));
          const ry1 = Math.min((cy + 1) * REGIONS_PER_CHUNK - 1, cellOf(maxY, REGION_SIXTEENTHS));
          const rz1 = Math.min((cz + 1) * REGIONS_PER_CHUNK - 1, cellOf(maxZ, REGION_SIXTEENTHS));
          for (let rx = rx0; rx <= rx1; rx++) {
            for (let ry = ry0; ry <= ry1; ry++) {
              for (let rz = rz0; rz <= rz1; rz++) {
                this.cellKey[0] = rx;
                this.cellKey[1] = ry;
                this.cellKey[2] = rz;
                for (
                  let slot = this.regions.get(this.cellKey);
                  slot !== NO_SLOT;
                  slot = this.slotRegionNext[slot] ?? NO_SLOT
                ) {
                  if (!this.reachable(slot, wide, at, reach) || !this.pairsWithTurn(slot, rot))
                    continue;
                  if (count >= limit) {
                    this.gatheredDense[rot] = 1;
                    this.gathered[rot] = list;
                    this.gatheredCount[rot] = 0;
                    return;
                  }
                  if (count === list.length) list = grown(list, new Int32Array(list.length * 2));
                  list[count++] = slot;
                }
              }
            }
          }
        }
      }
    }
    this.gathered[rot] = list;
    this.gatheredCount[rot] = count;
  }

  private matesFromModel(
    model: ModelConnectors,
    pose: LatticePose,
    skipped: number,
    out: MateReport | null,
  ): number {
    const turned = this.turned;
    let n = 0;
    let from = pose.rot * model.count;
    for (
      let g = turned.groupsOfTurn[pose.rot] ?? 0;
      g < (turned.groupsOfTurn[pose.rot + 1] ?? 0);
      g++
    ) {
      const to = turned.groupEnd[g] ?? from;
      if (turned.groupKey[g] !== skipped) {
        for (let k = from; k < to; k++) {
          n += this.connectorMates(model, turned.order[k] ?? 0, pose, out);
        }
      }
      from = to;
    }
    return n;
  }

  private connectorMates(
    model: ModelConnectors,
    m: number,
    pose: LatticePose,
    out: MateReport | null,
  ): number {
    const turned = this.turned;
    const classes = this.classes;
    const i = m % model.count;
    const own = turned.connectorClass[i] ?? UNCLASSED;
    const low = classes.lineLow[own] ?? 0;
    const high = classes.lineHigh[own] ?? 0;
    if (low > high) return 0;
    const ownSource = model.source[i] ?? 0;
    const ownStatus = model.status[i] ?? 0;
    const at = m * VECTOR_FLOATS;
    const x = (turned.position[at + X] ?? 0) + sixteenths(pose.x);
    const y = (turned.position[at + Y] ?? 0) + pose.yPlates * PLATE_SIXTEENTHS;
    const z = (turned.position[at + Z] ?? 0) + sixteenths(pose.z);
    const axis = turned.axis[m] ?? 0;
    const partnerAxis = oppositeAxis(axis);
    const dimension = axisDimension(axis);
    const dx = axisStep(axis, X);
    const dy = axisStep(axis, Y);
    const dz = axisStep(axis, Z);
    const along = x * Math.abs(dx) + y * Math.abs(dy) + z * Math.abs(dz);
    const first = along + Math.min(Math.imul(axisSign(axis), low), Math.imul(axisSign(axis), high));
    const last = along + Math.max(Math.imul(axisSign(axis), low), Math.imul(axisSign(axis), high));
    this.keyOf(x, y, z, CELL_SIXTEENTHS);
    let n = 0;
    for (let c = cellOf(first, CELL_SIXTEENTHS); c <= cellOf(last, CELL_SIXTEENTHS); c++) {
      this.cellKey[dimension] = c;
      for (
        let slot = this.cells.get(this.cellKey);
        slot !== NO_SLOT;
        slot = this.slotNext[slot] ?? NO_SLOT
      ) {
        if (this.slotAxis[slot] !== partnerAxis) continue;
        const sx = (this.slotX[slot] ?? 0) - x;
        const sy = (this.slotY[slot] ?? 0) - y;
        const sz = (this.slotZ[slot] ?? 0) - z;
        const d = Math.imul(sx, dx) + Math.imul(sy, dy) + Math.imul(sz, dz);
        if (sx !== dx * d || sy !== dy * d || sz !== dz * d) continue;
        if (!classes.engagesAt(own, this.slotClass[slot] ?? UNCLASSED, d)) continue;
        if (!out) {
          n += this.sharesLine(i, slot) ? this.newJoint(model, i, slot, axis, x, y, z) : 1;
          continue;
        }
        n++;
        this.engage(model, i, x, y, z, axis, slot, d);
        out.push(
          i,
          model.shape[i] ?? 0,
          model.gender[i] ?? 0,
          classes.shapeOf(this.slotClass[slot] ?? UNCLASSED),
          classes.genderOf(this.slotClass[slot] ?? UNCLASSED),
          ownSource | (this.slotSource[slot] ?? 0),
          Math.max(ownStatus, this.slotStatus[slot] ?? 0),
          this.slotOwner[slot] ?? 0,
          model.instance[i] ?? NO_INSTANCE,
          this.slotInstance[slot] ?? NO_INSTANCE,
          this.engaged,
        );
      }
    }
    return n;
  }

  private slotMates(
    model: ModelConnectors,
    slot: number,
    pose: LatticePose,
    out: MateReport | null,
  ): number {
    const turned = this.turned;
    const classes = this.classes;
    const rot = pose.rot;
    const slotAxis = this.slotAxis[slot] ?? 0;
    const wanted = oppositeAxis(slotAxis);
    if (((turned.axesOfTurn[rot] ?? 0) & (1 << wanted)) === 0) return 0;
    const slotClass = this.slotClass[slot] ?? UNCLASSED;
    const low = classes.lineLow[slotClass] ?? 0;
    const high = classes.lineHigh[slotClass] ?? 0;
    if (low > high) return 0;
    const slotSource = this.slotSource[slot] ?? 0;
    const slotStatus = this.slotStatus[slot] ?? 0;
    const tx = (this.slotX[slot] ?? 0) - sixteenths(pose.x);
    const ty = (this.slotY[slot] ?? 0) - pose.yPlates * PLATE_SIXTEENTHS;
    const tz = (this.slotZ[slot] ?? 0) - sixteenths(pose.z);
    const dimension = axisDimension(slotAxis);
    const sign = axisSign(slotAxis);
    const across = (dimension + 1) % VECTOR_FLOATS;
    const beyond = (dimension + 2) % VECTOR_FLOATS;
    const along = dimension === X ? tx : dimension === Y ? ty : tz;
    const ta = across === X ? tx : across === Y ? ty : tz;
    const tb = beyond === X ? tx : beyond === Y ? ty : tz;
    this.modelKey[0] = rot;
    this.modelKey[1] = dimension;
    this.modelKey[2] = ta;
    this.modelKey[3] = tb;
    const line = turned.exactLines.get(this.modelKey);
    if (line === MISSING) return 0;
    const first = along + Math.min(Math.imul(sign, low), Math.imul(sign, high));
    const last = along + Math.max(Math.imul(sign, low), Math.imul(sign, high));
    const end = turned.exactStart[line + 1] ?? 0;
    const base = rot * model.count;
    let n = 0;
    for (
      let k = firstAtLeast(turned.exactAlong, turned.exactStart[line] ?? 0, end, first);
      k < end && (turned.exactAlong[k] ?? 0) <= last;
      k++
    ) {
      const m = turned.exactOrder[k] ?? 0;
      if (turned.axis[m] !== wanted) continue;
      const i = m - base;
      const d = Math.imul((turned.exactAlong[k] ?? 0) - along, sign);
      if (!classes.engagesAt(slotClass, turned.connectorClass[i] ?? UNCLASSED, d)) continue;
      if (!out && !this.sharesLine(i, slot)) {
        n++;
        continue;
      }
      const at = m * VECTOR_FLOATS;
      const x = (turned.position[at + X] ?? 0) + sixteenths(pose.x);
      const y = (turned.position[at + Y] ?? 0) + pose.yPlates * PLATE_SIXTEENTHS;
      const z = (turned.position[at + Z] ?? 0) + sixteenths(pose.z);
      if (!out) {
        n += this.newJoint(model, i, slot, wanted, x, y, z);
        continue;
      }
      n++;
      this.engage(model, i, x, y, z, wanted, slot, d);
      out.push(
        i,
        model.shape[i] ?? 0,
        model.gender[i] ?? 0,
        classes.shapeOf(slotClass),
        classes.genderOf(slotClass),
        (model.source[i] ?? 0) | slotSource,
        Math.max(model.status[i] ?? 0, slotStatus),
        this.slotOwner[slot] ?? 0,
        model.instance[i] ?? NO_INSTANCE,
        this.slotInstance[slot] ?? NO_INSTANCE,
        this.engaged,
      );
    }
    return n;
  }

  private sharesLine(i: number, slot: number): boolean {
    return this.turned.lineShared[i] === 1 || this.slotLineShared[slot] === 1;
  }

  private newJoint(
    model: ModelConnectors,
    i: number,
    slot: number,
    axis: number,
    x: number,
    y: number,
    z: number,
  ): number {
    const instance = model.instance[i] ?? NO_INSTANCE;
    const partnerInstance = this.slotInstance[slot] ?? NO_INSTANCE;
    if (instance === NO_INSTANCE || partnerInstance === NO_INSTANCE) return 1;
    const along = axisDimension(axis);
    const key = this.jointKey;
    key[0] = this.slotOwner[slot] ?? 0;
    key[1] = instance;
    key[2] = partnerInstance;
    key[3] = along;
    key[4] = along === X ? y : x;
    key[5] = along === Z ? y : z;
    if (this.joints.get(key) !== MISSING) return 0;
    this.joints.set(key, 1);
    return 1;
  }

  private engage(
    model: ModelConnectors,
    i: number,
    x: number,
    y: number,
    z: number,
    axis: number,
    slot: number,
    offset: number,
  ): void {
    const ownMale = model.gender[i] === GENDER_MALE;
    const ownShape = model.shape[i] ?? 0;
    const theirShape = this.slotShape[slot] ?? 0;
    this.mating.engagedSpan(
      ownMale ? ownShape : theirShape,
      ownMale ? theirShape : ownShape,
      offset,
      this.span,
    );
    const maleAxis = ownMale ? axis : oppositeAxis(axis);
    const along = axisDimension(maleAxis);
    const sign = axisSign(maleAxis);
    const maleX = ownMale ? x : (this.slotX[slot] ?? 0);
    const maleY = ownMale ? y : (this.slotY[slot] ?? 0);
    const maleZ = ownMale ? z : (this.slotZ[slot] ?? 0);
    const root = along === X ? maleX : along === Y ? maleY : maleZ;
    const from = root + sign * (this.span[SPAN_FROM] ?? 0);
    const to = root + sign * (this.span[SPAN_TO] ?? 0);
    this.engaged[ENGAGED_AXIS] = along;
    this.engaged[ENGAGED_U] = along === X ? maleY : maleX;
    this.engaged[ENGAGED_V] = along === Z ? maleY : maleZ;
    this.engaged[ENGAGED_FROM] = Math.min(from, to);
    this.engaged[ENGAGED_TO] = Math.max(from, to);
    this.engaged[ENGAGED_RADIUS] = this.span[SPAN_WIDEST] ?? 0;
  }

  private proposeFromSlot(
    slot: number,
    connectors: number,
    rot: number,
    window: SnapWindow,
    travel: number,
    latticeOnly: boolean,
    out: CandidatePoses,
  ): void {
    const turned = this.turned;
    const classes = this.classes;
    const wanted = oppositeAxis(this.slotAxis[slot] ?? 0);
    if (((turned.axesOfTurn[rot] ?? 0) & (1 << wanted)) === 0) return;
    const slotClass = this.slotClass[slot] ?? UNCLASSED;
    const sx = (this.slotX[slot] ?? 0) - sixteenths(window.x);
    const sy = (this.slotY[slot] ?? 0) - window.yPlates * PLATE_SIXTEENTHS;
    const sz = (this.slotZ[slot] ?? 0) - sixteenths(window.z);
    const spanXZ = window.cells * STUD_SIXTEENTHS;
    const spanY = window.plates * PLATE_SIXTEENTHS;
    const ax = Math.abs(axisStep(wanted, X)) * travel;
    const ay = Math.abs(axisStep(wanted, Y)) * travel;
    const az = Math.abs(axisStep(wanted, Z)) * travel;
    const wantedDimension = axisDimension(wanted);
    const wantedSign = axisSign(wanted);
    const sAlong = wantedDimension === X ? sx : wantedDimension === Y ? sy : sz;
    const spanAlong = wantedDimension === Y ? spanY : spanXZ;
    const latticeStep =
      wantedDimension === Y ? PLATE_SIXTEENTHS : latticeOnly ? STUD_SIXTEENTHS : SIXTEENTHS_PER_LDU;
    const planStep = latticeOnly ? STUD_SIXTEENTHS : SIXTEENTHS_PER_LDU;
    const block = this.block;
    block[0] = cellOf(sx - spanXZ - ax, CELL_SIXTEENTHS);
    block[1] = cellOf(sy - spanY - ay, CELL_SIXTEENTHS);
    block[2] = cellOf(sz - spanXZ - az, CELL_SIXTEENTHS);
    block[3] = cellOf(sx + spanXZ + ax, CELL_SIXTEENTHS);
    block[4] = cellOf(sy + spanY + ay, CELL_SIXTEENTHS);
    block[5] = cellOf(sz + spanXZ + az, CELL_SIXTEENTHS);
    const found = latticeOnly
      ? this.inBlockPairing(rot, wanted, block, slotClass)
      : this.inBlock(rot, wanted, block);
    for (let j = 0; j < found; j++) {
      const m = this.candidates[j] ?? 0;
      const i = m - rot * connectors;
      const own = turned.connectorClass[i] ?? UNCLASSED;
      const along = sAlong - (turned.position[m * VECTOR_FLOATS + wantedDimension] ?? 0);
      const lowest = Math.imul(wantedSign, along) - spanAlong;
      const highest = Math.imul(wantedSign, along) + spanAlong;
      for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
        if (classes.pairClass[p] !== slotClass) continue;
        for (
          let r = classes.firstRangeReaching(p, lowest);
          r < (classes.pairRangeStart[p + 1] ?? 0) && (classes.rangeLow[r] ?? 0) <= highest;
          r++
        ) {
          const top = Math.min(classes.rangeHigh[r] ?? 0, highest);
          const from = Math.max(classes.rangeLow[r] ?? 0, lowest);
          const onLattice = Math.imul(wantedSign, along) - from;
          for (
            let d = from + (((onLattice % latticeStep) + latticeStep) % latticeStep);
            d <= top;
            d += latticeStep
          ) {
            const shiftX =
              sx - axisStep(wanted, X) * d - (turned.position[m * VECTOR_FLOATS + X] ?? 0);
            const shiftY =
              sy - axisStep(wanted, Y) * d - (turned.position[m * VECTOR_FLOATS + Y] ?? 0);
            const shiftZ =
              sz - axisStep(wanted, Z) * d - (turned.position[m * VECTOR_FLOATS + Z] ?? 0);
            if (shiftX % planStep !== 0 || shiftZ % planStep !== 0) continue;
            if (shiftY % PLATE_SIXTEENTHS !== 0) continue;
            const plates = shiftY / PLATE_SIXTEENTHS;
            if (
              Math.abs(shiftX) > spanXZ ||
              Math.abs(shiftZ) > spanXZ ||
              Math.abs(plates) > window.plates
            ) {
              continue;
            }
            out.add(
              window.x + shiftX / SIXTEENTHS_PER_LDU,
              window.z + shiftZ / SIXTEENTHS_PER_LDU,
              window.yPlates + plates,
              rot,
            );
          }
        }
      }
    }
  }

  private inBlock(rot: number, wanted: number, block: Int32Array): number {
    const turned = this.turned;
    const dimension = axisDimension(wanted);
    const across = (dimension + 1) % VECTOR_FLOATS;
    const beyond = (dimension + 2) % VECTOR_FLOATS;
    const alongLow = (block[dimension] ?? 0) * CELL_SIXTEENTHS;
    const alongHigh = ((block[dimension + VECTOR_FLOATS] ?? 0) + 1) * CELL_SIXTEENTHS - 1;
    let found = 0;
    for (let a = block[across] ?? 0; a <= (block[across + VECTOR_FLOATS] ?? 0); a++) {
      for (let b = block[beyond] ?? 0; b <= (block[beyond + VECTOR_FLOATS] ?? 0); b++) {
        this.modelKey[0] = rot;
        this.modelKey[1] = dimension;
        this.modelKey[2] = a;
        this.modelKey[3] = b;
        const line = turned.columnLines.get(this.modelKey);
        if (line === MISSING) continue;
        const end = turned.columnStart[line + 1] ?? 0;
        for (
          let k = firstAtLeast(turned.columnAlong, turned.columnStart[line] ?? 0, end, alongLow);
          k < end && (turned.columnAlong[k] ?? 0) <= alongHigh;
          k++
        ) {
          const m = turned.columnOrder[k] ?? 0;
          if (turned.axis[m] !== wanted) continue;
          let j = found++;
          while (j > 0 && this.scansBefore(m, this.candidates[j - 1] ?? 0)) {
            this.candidates[j] = this.candidates[j - 1] ?? 0;
            j--;
          }
          this.candidates[j] = m;
        }
      }
    }
    return found;
  }

  private inBlockPairing(
    rot: number,
    wanted: number,
    block: Int32Array,
    slotClass: number,
  ): number {
    const turned = this.turned;
    const dimension = axisDimension(wanted);
    const across = (dimension + 1) % VECTOR_FLOATS;
    const beyond = (dimension + 2) % VECTOR_FLOATS;
    const alongLow = (block[dimension] ?? 0) * CELL_SIXTEENTHS;
    const alongHigh = ((block[dimension + VECTOR_FLOATS] ?? 0) + 1) * CELL_SIXTEENTHS - 1;
    const connectors = turned.connectorClass.length;
    const classCount = turned.classCount;
    let found = 0;
    for (let a = block[across] ?? 0; a <= (block[across + VECTOR_FLOATS] ?? 0); a++) {
      for (let b = block[beyond] ?? 0; b <= (block[beyond + VECTOR_FLOATS] ?? 0); b++) {
        this.modelKey[0] = rot;
        this.modelKey[1] = dimension;
        this.modelKey[2] = a;
        this.modelKey[3] = b;
        const line = turned.columnLines.get(this.modelKey);
        if (line === MISSING) continue;
        const end = turned.columnStart[line + 1] ?? 0;
        for (
          let k = firstAtLeast(turned.columnAlong, turned.columnStart[line] ?? 0, end, alongLow);
          k < end && (turned.columnAlong[k] ?? 0) <= alongHigh;
          k++
        ) {
          const m = turned.columnOrder[k] ?? 0;
          if (turned.axis[m] !== wanted) continue;
          const own = turned.connectorClass[m - rot * connectors] ?? UNCLASSED;
          if (own < 0 || turned.pairsWith[own * classCount + slotClass] !== 1) continue;
          this.candidates[found++] = m;
        }
      }
    }
    return found;
  }

  private scansBefore(a: number, b: number): boolean {
    const position = this.turned.position;
    for (let d = 0; d < VECTOR_FLOATS; d++) {
      const ca = cellOf(position[a * VECTOR_FLOATS + d] ?? 0, CELL_SIXTEENTHS);
      const cb = cellOf(position[b * VECTOR_FLOATS + d] ?? 0, CELL_SIXTEENTHS);
      if (ca !== cb) return ca < cb;
    }
    return a > b;
  }

  private turn(model: ModelConnectors): TurnedModel {
    return this.turned.model === model ? this.turned : this.switchTurned(model);
  }

  private switchTurned(model: ModelConnectors): TurnedModel {
    const cached = this.turnedModels.get(model);
    if (cached !== undefined && cached.classCount === this.classes.count) {
      this.turned = cached;
    } else {
      this.turned = this.turnModel(model);
      this.turnedModels.set(model, this.turned);
    }
    if (this.nearby.length < model.count) this.nearby = new Int32Array(model.count);
    if (this.candidates.length < model.count) this.candidates = new Int32Array(model.count);
    this.gatheredRevision.fill(-1);
    return this.turned;
  }

  private turnModel(model: ModelConnectors): TurnedModel {
    const turned = new TurnedModel(model);
    const n = model.count;
    turned.connectorClass = this.classes.classesOf(model);
    turned.position = new Int32Array(QUARTER_TURNS * n * VECTOR_FLOATS);
    turned.axis = new Int8Array(QUARTER_TURNS * n);
    turned.classes = Int32Array.from(new Set(turned.connectorClass));
    turned.classCount = this.classes.count;
    turned.axisClasses = new Uint8Array(QUARTER_TURNS * AXIS_CODES * turned.classCount);
    turned.axesOfTurn.fill(0);
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      const cos = turnCos(rot);
      const sin = turnSin(rot);
      const b = rot * BOX_INTS;
      turned.box.fill(0, b, b + BOX_INTS);
      for (let i = 0; i < n; i++) {
        const o = i * VECTOR_FLOATS;
        const m = rot * n + i;
        const mx = model.origin[o + X] ?? 0;
        const mz = model.origin[o + Z] ?? 0;
        const x = cos * mx + sin * mz;
        const y = model.origin[o + Y] ?? 0;
        const z = -sin * mx + cos * mz;
        turned.position[m * VECTOR_FLOATS + X] = x;
        turned.position[m * VECTOR_FLOATS + Y] = y;
        turned.position[m * VECTOR_FLOATS + Z] = z;
        turned.axis[m] = rotatedAxis(model.axis[i] ?? 0, rot);
        turned.axisClasses[
          (rot * AXIS_CODES + (turned.axis[m] ?? 0)) * turned.classCount +
            (turned.connectorClass[i] ?? 0)
        ] = 1;
        turned.axesOfTurn[rot] = (turned.axesOfTurn[rot] ?? 0) | (1 << (turned.axis[m] ?? 0));
        this.grow(turned.box, b, x, y, z, i === 0);
      }
    }
    this.markPairable(turned);
    this.groupByPhase(turned, n);
    this.indexLines(turned, n);
    turned.lineShared = sharedLines(model);
    return turned;
  }

  private markPairable(turned: TurnedModel): void {
    const classes = this.classes;
    const classCount = turned.classCount;
    turned.pairable = new Uint8Array(QUARTER_TURNS * classCount * AXIS_CODES);
    turned.pairsWith = new Uint8Array(classCount * classCount);
    for (const own of turned.classes) {
      if (own < 0) continue;
      for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
        const partner = classes.pairClass[p] ?? UNCLASSED;
        if (partner >= 0) turned.pairsWith[own * classCount + partner] = 1;
      }
    }
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      for (const own of turned.classes) {
        if (own < 0) continue;
        for (let axis = 0; axis < AXIS_CODES; axis++) {
          if (turned.axisClasses[(rot * AXIS_CODES + axis) * classCount + own] !== 1) continue;
          const slotAxis = oppositeAxis(axis);
          for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
            const partner = classes.pairClass[p] ?? UNCLASSED;
            if (partner < 0) continue;
            turned.pairable[(rot * classCount + partner) * AXIS_CODES + slotAxis] = 1;
          }
        }
      }
    }
  }

  private pairableSlot(turned: TurnedModel, slot: number, rot: number): boolean {
    const slotClass = this.slotClass[slot] ?? UNCLASSED;
    if (slotClass < 0 || slotClass >= turned.classCount) return false;
    const slotAxis = this.slotAxis[slot] ?? 0;
    return turned.pairable[(rot * turned.classCount + slotClass) * AXIS_CODES + slotAxis] === 1;
  }

  private indexLines(turned: TurnedModel, n: number): void {
    [turned.exactLines, turned.exactStart, turned.exactOrder, turned.exactAlong] = lineIndex(
      turned.position,
      turned.axis,
      n,
      1,
    );
    [turned.columnLines, turned.columnStart, turned.columnOrder, turned.columnAlong] = lineIndex(
      turned.position,
      turned.axis,
      n,
      CELL_SIXTEENTHS,
    );
  }

  private groupByPhase(turned: TurnedModel, n: number): void {
    const keyOf = new Int32Array(QUARTER_TURNS * n);
    for (let m = 0; m < QUARTER_TURNS * n; m++) {
      const at = m * VECTOR_FLOATS;
      keyOf[m] =
        verticalSign(turned.axis[m] ?? 0) === 0
          ? AXIAL_GROUP
          : phaseKey(turned.position[at + X] ?? 0, turned.position[at + Z] ?? 0);
    }
    turned.order = Int32Array.from({ length: QUARTER_TURNS * n }, (_, m) => m);
    const keys: number[] = [];
    const ends: number[] = [];
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      turned.groupsOfTurn[rot] = keys.length;
      const turn = turned.order.subarray(rot * n, (rot + 1) * n);
      turn.sort((a, b) => (keyOf[a] ?? 0) - (keyOf[b] ?? 0));
      for (let k = 0; k < n; k++) {
        const key = keyOf[turn[k] ?? 0] ?? 0;
        if (k === 0 || key !== keys[keys.length - 1]) {
          keys.push(key);
          ends.push(rot * n + k + 1);
        } else {
          ends[ends.length - 1] = rot * n + k + 1;
        }
      }
    }
    turned.groupsOfTurn[QUARTER_TURNS] = keys.length;
    turned.groupKey = Int32Array.from(keys);
    turned.groupEnd = Int32Array.from(ends);
  }

  private grow(box: Int32Array, b: number, x: number, y: number, z: number, first: boolean): void {
    box[b] = first ? x : Math.min(box[b] ?? 0, x);
    box[b + 1] = first ? y : Math.min(box[b + 1] ?? 0, y);
    box[b + 2] = first ? z : Math.min(box[b + 2] ?? 0, z);
    box[b + 3] = first ? x : Math.max(box[b + 3] ?? 0, x);
    box[b + 4] = first ? y : Math.max(box[b + 4] ?? 0, y);
    box[b + 5] = first ? z : Math.max(box[b + 5] ?? 0, z);
  }

  private keyOf(x: number, y: number, z: number, size: number): Int32Array {
    this.cellKey[0] = cellOf(x, size);
    this.cellKey[1] = cellOf(y, size);
    this.cellKey[2] = cellOf(z, size);
    return this.cellKey;
  }

  private allocate(): number {
    if (this.freeSlot !== NO_SLOT) {
      const slot = this.freeSlot;
      this.freeSlot = this.slotNext[slot] ?? NO_SLOT;
      return slot;
    }
    if (this.slots === this.slotX.length) this.growSlots();
    return this.slots++;
  }

  private unlinkCell(x: number, y: number, z: number, owner: number, connector: number): number {
    const key = this.keyOf(x, y, z, CELL_SIXTEENTHS);
    let previous = NO_SLOT;
    for (let slot = this.cells.get(key); slot !== NO_SLOT; slot = this.slotNext[slot] ?? NO_SLOT) {
      const same = this.slotOwner[slot] === owner && this.slotConnector[slot] === connector;
      if (!same) {
        previous = slot;
        continue;
      }
      const next = this.slotNext[slot] ?? NO_SLOT;
      if (previous === NO_SLOT) this.cells.set(this.keyOf(x, y, z, CELL_SIXTEENTHS), next);
      else this.slotNext[previous] = next;
      return slot;
    }
    throw new RangeError(`no placed connector to remove at ${x}, ${y}, ${z}`);
  }

  private unlinkRegion(target: number): void {
    const previous = this.slotRegionPrev[target] ?? NO_SLOT;
    const next = this.slotRegionNext[target] ?? NO_SLOT;
    if (previous === NO_SLOT) {
      const x = this.slotX[target] ?? 0;
      const y = this.slotY[target] ?? 0;
      const z = this.slotZ[target] ?? 0;
      this.regions.set(this.keyOf(x, y, z, REGION_SIXTEENTHS), next);
    } else this.slotRegionNext[previous] = next;
    if (next !== NO_SLOT) this.slotRegionPrev[next] = previous;
  }

  private countChunk(x: number, y: number, z: number, delta: number): void {
    const key = this.keyOf(x, y, z, CHUNK_SIXTEENTHS);
    this.chunks.set(key, Math.max(0, this.chunks.get(key)) + delta);
  }

  private growSlots(): void {
    const capacity = this.slotX.length * 2;
    this.slotX = grown(this.slotX, new Int32Array(capacity));
    this.slotY = grown(this.slotY, new Int32Array(capacity));
    this.slotZ = grown(this.slotZ, new Int32Array(capacity));
    this.slotAxis = grown(this.slotAxis, new Int8Array(capacity));
    this.slotClass = grown(this.slotClass, new Int32Array(capacity));
    this.slotSource = grown(this.slotSource, new Uint8Array(capacity));
    this.slotStatus = grown(this.slotStatus, new Uint8Array(capacity));
    this.slotNext = grown(this.slotNext, new Int32Array(capacity));
    this.slotRegionNext = grown(this.slotRegionNext, new Int32Array(capacity));
    this.slotRegionPrev = grown(this.slotRegionPrev, new Int32Array(capacity));
    this.slotOwner = grown(this.slotOwner, new Int32Array(capacity));
    this.slotConnector = grown(this.slotConnector, new Int32Array(capacity));
    this.slotInstance = grown(this.slotInstance, new Int32Array(capacity));
    this.slotShape = grown(this.slotShape, new Uint16Array(capacity));
    this.slotLineShared = grown(this.slotLineShared, new Uint8Array(capacity));
  }
}

function sharedLines(model: ModelConnectors): Uint8Array<ArrayBuffer> {
  const key = new Int32Array(LINE_KEY_INTS);
  const counts = new IntKeyMap(LINE_KEY_INTS);
  const lineKey = (i: number): Int32Array | null => {
    const instance = model.instance[i] ?? NO_INSTANCE;
    if (instance === NO_INSTANCE) return null;
    const along = axisDimension(model.axis[i] ?? 0);
    const at = i * VECTOR_FLOATS;
    key[0] = instance;
    key[1] = along;
    key[2] = model.origin[at + ((along + 1) % VECTOR_FLOATS)] ?? 0;
    key[3] = model.origin[at + ((along + 2) % VECTOR_FLOATS)] ?? 0;
    return key;
  };
  for (let i = 0; i < model.count; i++) {
    const line = lineKey(i);
    if (line) counts.set(line, Math.max(0, counts.get(line)) + 1);
  }
  const shared = new Uint8Array(model.count);
  for (let i = 0; i < model.count; i++) {
    const line = lineKey(i);
    if (line && counts.get(line) > 1) shared[i] = 1;
  }
  return shared;
}

function grown<T extends Int32Array | Int8Array | Uint8Array | Uint16Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
