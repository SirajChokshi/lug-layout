import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import { ConnectorClasses } from "./connector-classes.ts";
import { VECTOR_FLOATS, axisDimension, axisSign, oppositeAxis } from "./connector-table.ts";
import { IntKeyMap, MISSING } from "./int-key-map.ts";
import {
  QUARTER_TURNS,
  checkPose,
  isLatticeStud,
  phaseOf,
  rotatedAxis,
  verticalSign,
  turnCos,
  turnSin,
} from "./lattice-frame.ts";
import type { MateFinder } from "./mate-finder.ts";
import type { MateReport } from "./mate-report.ts";
import type { SnapMating } from "./mating.ts";
import type { ModelConnectors } from "./model-connectors.ts";

const CELL_LDU = STUD_LDU;
const REGION_LDU = 8 * STUD_LDU;
const NO_SLOT = MISSING;
const CELL_KEY_INTS = 3;
const MODEL_KEY_INTS = 4;
const BOX_INTS = 6;
const INITIAL_SLOTS = 256;
const UNCLASSED = -1;
const SPARSE_AXIS_KEY = 0;
const X = 0;
const Y = 1;
const Z = 2;
const AXIAL_GROUP = -1;
const STUD_CENTRE_LDU = STUD_LDU / 2;

function cellOf(ldu: number, size: number): number {
  return Math.floor(ldu / size);
}

function axisStep(axis: number, dimension: number): number {
  return axisDimension(axis) === dimension ? axisSign(axis) : 0;
}

function phaseKey(x: number, z: number): number {
  return phaseOf(x) * STUD_LDU + phaseOf(z);
}

function latticeKey(pose: LatticePose): number {
  return phaseKey(STUD_CENTRE_LDU - pose.x, STUD_CENTRE_LDU - pose.z);
}

class TurnedModel {
  model: ModelConnectors | null = null;
  order = new Int32Array(0);
  groupKey = new Int32Array(0);
  groupEnd = new Int32Array(0);
  readonly groupsOfTurn = new Int32Array(QUARTER_TURNS + 1);
  readonly axesOfTurn = new Uint8Array(QUARTER_TURNS);
  connectorClass = new Int32Array(0);
  position = new Int32Array(0);
  axis = new Int8Array(0);
  next = new Int32Array(0);
  readonly box = new Int32Array(QUARTER_TURNS * BOX_INTS);
  cells = new IntKeyMap(MODEL_KEY_INTS);
}

export class SparseConnectorFinder implements MateFinder {
  private readonly classes: ConnectorClasses;
  private readonly cells = new IntKeyMap(CELL_KEY_INTS);
  private readonly regions = new IntKeyMap(CELL_KEY_INTS);
  private readonly cellKey = new Int32Array(CELL_KEY_INTS);
  private readonly modelKey = new Int32Array(MODEL_KEY_INTS);
  private readonly turned = new TurnedModel();
  private slotX = new Int32Array(INITIAL_SLOTS);
  private slotY = new Int32Array(INITIAL_SLOTS);
  private slotZ = new Int32Array(INITIAL_SLOTS);
  private slotAxis = new Int8Array(INITIAL_SLOTS);
  private slotClass = new Int32Array(INITIAL_SLOTS);
  private slotNext = new Int32Array(INITIAL_SLOTS);
  private slotRegionNext = new Int32Array(INITIAL_SLOTS);
  private slots = 0;
  private freeSlot = NO_SLOT;

  constructor(private readonly mating: SnapMating) {
    this.classes = new ConnectorClasses(mating);
  }

  insert(model: ModelConnectors, pose: LatticePose): void {
    checkPose(pose);
    const turned = this.turn(model);
    for (let i = 0; i < model.count; i++) {
      const at = (pose.rot * model.count + i) * VECTOR_FLOATS;
      const x = (turned.position[at + X] ?? 0) + pose.x;
      const y = (turned.position[at + Y] ?? 0) + pose.yPlates * PLATE_LDU;
      const z = (turned.position[at + Z] ?? 0) + pose.z;
      const axis = turned.axis[pose.rot * model.count + i] ?? 0;
      if (isLatticeStud(axis, x, z)) continue;
      const slot = this.allocate();
      this.slotX[slot] = x;
      this.slotY[slot] = y;
      this.slotZ[slot] = z;
      this.slotAxis[slot] = axis;
      this.slotClass[slot] = turned.connectorClass[i] ?? UNCLASSED;
      this.slotNext[slot] = this.cells.get(this.keyOf(x, y, z, CELL_LDU));
      this.cells.set(this.cellKey, slot);
      this.slotRegionNext[slot] = this.regions.get(this.keyOf(x, y, z, REGION_LDU));
      this.regions.set(this.cellKey, slot);
    }
  }

  remove(model: ModelConnectors, pose: LatticePose): void {
    checkPose(pose);
    const turned = this.turn(model);
    for (let i = 0; i < model.count; i++) {
      const at = (pose.rot * model.count + i) * VECTOR_FLOATS;
      const x = (turned.position[at + X] ?? 0) + pose.x;
      const y = (turned.position[at + Y] ?? 0) + pose.yPlates * PLATE_LDU;
      const z = (turned.position[at + Z] ?? 0) + pose.z;
      const axis = turned.axis[pose.rot * model.count + i] ?? 0;
      if (isLatticeStud(axis, x, z)) continue;
      const slot = this.unlinkCell(x, y, z, axis, turned.connectorClass[i] ?? UNCLASSED);
      this.unlinkRegion(slot);
      this.slotNext[slot] = this.freeSlot;
      this.freeSlot = slot;
    }
  }

  propose(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void {
    checkPose(window);
    const turned = this.turn(model);
    const reach = this.mating.shapes.longest;
    const spanXZ = window.cells * STUD_LDU + reach;
    const spanY = window.plates * PLATE_LDU + reach;
    const baseY = window.yPlates * PLATE_LDU;
    for (let t = 0; t < window.turns; t++) {
      const rot = (window.rot + t) % QUARTER_TURNS;
      const b = rot * BOX_INTS;
      const fromX = cellOf(window.x + (turned.box[b] ?? 0) - spanXZ, REGION_LDU);
      const toX = cellOf(window.x + (turned.box[b + 3] ?? 0) + spanXZ, REGION_LDU);
      const fromY = cellOf(baseY + (turned.box[b + 1] ?? 0) - spanY, REGION_LDU);
      const toY = cellOf(baseY + (turned.box[b + 4] ?? 0) + spanY, REGION_LDU);
      const fromZ = cellOf(window.z + (turned.box[b + 2] ?? 0) - spanXZ, REGION_LDU);
      const toZ = cellOf(window.z + (turned.box[b + 5] ?? 0) + spanXZ, REGION_LDU);
      for (let rx = fromX; rx <= toX; rx++) {
        for (let ry = fromY; ry <= toY; ry++) {
          for (let rz = fromZ; rz <= toZ; rz++) {
            this.cellKey[0] = rx;
            this.cellKey[1] = ry;
            this.cellKey[2] = rz;
            for (
              let slot = this.regions.get(this.cellKey);
              slot !== NO_SLOT;
              slot = this.slotRegionNext[slot] ?? NO_SLOT
            ) {
              this.proposeFromSlot(slot, model.count, rot, window, reach, out);
            }
          }
        }
      }
    }
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
    const skipped = latticeKey(pose);
    let n = 0;
    let from = pose.rot * model.count;
    for (
      let g = turned.groupsOfTurn[pose.rot] ?? 0;
      g < (turned.groupsOfTurn[pose.rot + 1] ?? 0);
      g++
    ) {
      const to = turned.groupEnd[g] ?? from;
      if (turned.groupKey[g] !== skipped) {
        for (let k = from; k < to; k++)
          n += this.matesOf(turned.order[k] ?? 0, model.count, pose, out);
      }
      from = to;
    }
    return n;
  }

  private matesOf(
    m: number,
    connectors: number,
    pose: LatticePose,
    out: MateReport | null,
  ): number {
    const turned = this.turned;
    const classes = this.classes;
    const i = m % connectors;
    let n = 0;
    const at = m * VECTOR_FLOATS;
    const x = (turned.position[at + X] ?? 0) + pose.x;
    const y = (turned.position[at + Y] ?? 0) + pose.yPlates * PLATE_LDU;
    const z = (turned.position[at + Z] ?? 0) + pose.z;
    const axis = turned.axis[m] ?? 0;
    const own = turned.connectorClass[i] ?? UNCLASSED;
    const partnerAxis = oppositeAxis(axis);
    const dx = axisStep(axis, X);
    const dy = axisStep(axis, Y);
    const dz = axisStep(axis, Z);
    for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
      const partner = classes.pairClass[p] ?? UNCLASSED;
      for (
        let k = classes.pairOffsetStart[p] ?? 0;
        k < (classes.pairOffsetStart[p + 1] ?? 0);
        k++
      ) {
        const d = classes.offsets[k] ?? 0;
        const qx = x + dx * d;
        const qy = y + dy * d;
        const qz = z + dz * d;
        for (
          let slot = this.cells.get(this.keyOf(qx, qy, qz, CELL_LDU));
          slot !== NO_SLOT;
          slot = this.slotNext[slot] ?? NO_SLOT
        ) {
          if (
            this.slotX[slot] === qx &&
            this.slotY[slot] === qy &&
            this.slotZ[slot] === qz &&
            this.slotAxis[slot] === partnerAxis &&
            this.slotClass[slot] === partner
          ) {
            n++;
            out?.push(i, classes.pairSource[p] ?? 0);
          }
        }
      }
    }
    return n;
  }

  private proposeFromSlot(
    slot: number,
    connectors: number,
    rot: number,
    window: SnapWindow,
    reach: number,
    out: CandidatePoses,
  ): void {
    const turned = this.turned;
    const classes = this.classes;
    const wanted = oppositeAxis(this.slotAxis[slot] ?? 0);
    if (((turned.axesOfTurn[rot] ?? 0) & (1 << wanted)) === 0) return;
    const slotClass = this.slotClass[slot] ?? UNCLASSED;
    const sx = (this.slotX[slot] ?? 0) - window.x;
    const sy = (this.slotY[slot] ?? 0) - window.yPlates * PLATE_LDU;
    const sz = (this.slotZ[slot] ?? 0) - window.z;
    const spanXZ = window.cells * STUD_LDU;
    const spanY = window.plates * PLATE_LDU;
    const ax = Math.abs(axisStep(wanted, X)) * reach;
    const ay = Math.abs(axisStep(wanted, Y)) * reach;
    const az = Math.abs(axisStep(wanted, Z)) * reach;
    for (
      let cx = cellOf(sx - spanXZ - ax, CELL_LDU);
      cx <= cellOf(sx + spanXZ + ax, CELL_LDU);
      cx++
    ) {
      for (
        let cy = cellOf(sy - spanY - ay, CELL_LDU);
        cy <= cellOf(sy + spanY + ay, CELL_LDU);
        cy++
      ) {
        for (
          let cz = cellOf(sz - spanXZ - az, CELL_LDU);
          cz <= cellOf(sz + spanXZ + az, CELL_LDU);
          cz++
        ) {
          this.modelKey[0] = rot;
          this.modelKey[1] = cx;
          this.modelKey[2] = cy;
          this.modelKey[3] = cz;
          for (
            let m = turned.cells.get(this.modelKey);
            m !== NO_SLOT;
            m = turned.next[m] ?? NO_SLOT
          ) {
            const i = m - rot * connectors;
            if (turned.axis[m] !== wanted) continue;
            const own = turned.connectorClass[i] ?? UNCLASSED;
            for (let p = classes.pairStart[own] ?? 0; p < (classes.pairStart[own + 1] ?? 0); p++) {
              if (classes.pairClass[p] !== slotClass) continue;
              for (
                let k = classes.pairOffsetStart[p] ?? 0;
                k < (classes.pairOffsetStart[p + 1] ?? 0);
                k++
              ) {
                const d = classes.offsets[k] ?? 0;
                const shiftX =
                  sx - axisStep(wanted, X) * d - (turned.position[m * VECTOR_FLOATS + X] ?? 0);
                const shiftY =
                  sy - axisStep(wanted, Y) * d - (turned.position[m * VECTOR_FLOATS + Y] ?? 0);
                const shiftZ =
                  sz - axisStep(wanted, Z) * d - (turned.position[m * VECTOR_FLOATS + Z] ?? 0);
                if (shiftY % PLATE_LDU !== 0) continue;
                const plates = shiftY / PLATE_LDU;
                if (
                  Math.abs(shiftX) > spanXZ ||
                  Math.abs(shiftZ) > spanXZ ||
                  Math.abs(plates) > window.plates
                ) {
                  continue;
                }
                out.add(window.x + shiftX, window.z + shiftZ, window.yPlates + plates, rot);
              }
            }
          }
        }
      }
    }
  }

  private turn(model: ModelConnectors): TurnedModel {
    const turned = this.turned;
    if (turned.model === model) return turned;
    const n = model.count;
    turned.connectorClass = new Int32Array(n);
    turned.position = new Int32Array(QUARTER_TURNS * n * VECTOR_FLOATS);
    turned.axis = new Int8Array(QUARTER_TURNS * n);
    turned.next = new Int32Array(QUARTER_TURNS * n);
    turned.cells = new IntKeyMap(MODEL_KEY_INTS);
    for (let i = 0; i < n; i++) {
      turned.connectorClass[i] = this.classes.classOf(model, i, SPARSE_AXIS_KEY);
    }
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
        turned.axesOfTurn[rot] = (turned.axesOfTurn[rot] ?? 0) | (1 << (turned.axis[m] ?? 0));
        this.grow(turned.box, b, x, y, z, i === 0);
        this.modelKey[0] = rot;
        this.modelKey[1] = cellOf(x, CELL_LDU);
        this.modelKey[2] = cellOf(y, CELL_LDU);
        this.modelKey[3] = cellOf(z, CELL_LDU);
        turned.next[m] = turned.cells.get(this.modelKey);
        turned.cells.set(this.modelKey, m);
      }
    }
    this.groupByPhase(turned, n);
    turned.model = model;
    return turned;
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

  private unlinkCell(x: number, y: number, z: number, axis: number, own: number): number {
    const key = this.keyOf(x, y, z, CELL_LDU);
    let previous = NO_SLOT;
    for (let slot = this.cells.get(key); slot !== NO_SLOT; slot = this.slotNext[slot] ?? NO_SLOT) {
      const same =
        this.slotX[slot] === x &&
        this.slotY[slot] === y &&
        this.slotZ[slot] === z &&
        this.slotAxis[slot] === axis &&
        this.slotClass[slot] === own;
      if (!same) {
        previous = slot;
        continue;
      }
      const next = this.slotNext[slot] ?? NO_SLOT;
      if (previous === NO_SLOT) this.cells.set(this.keyOf(x, y, z, CELL_LDU), next);
      else this.slotNext[previous] = next;
      return slot;
    }
    throw new RangeError(`no placed connector to remove at ${x}, ${y}, ${z}`);
  }

  private unlinkRegion(target: number): void {
    const x = this.slotX[target] ?? 0;
    const y = this.slotY[target] ?? 0;
    const z = this.slotZ[target] ?? 0;
    let previous = NO_SLOT;
    const key = this.keyOf(x, y, z, REGION_LDU);
    for (
      let slot = this.regions.get(key);
      slot !== NO_SLOT;
      slot = this.slotRegionNext[slot] ?? NO_SLOT
    ) {
      if (slot !== target) {
        previous = slot;
        continue;
      }
      const next = this.slotRegionNext[slot] ?? NO_SLOT;
      if (previous === NO_SLOT) this.regions.set(this.keyOf(x, y, z, REGION_LDU), next);
      else this.slotRegionNext[previous] = next;
      return;
    }
  }

  private growSlots(): void {
    const capacity = this.slotX.length * 2;
    this.slotX = grown(this.slotX, new Int32Array(capacity));
    this.slotY = grown(this.slotY, new Int32Array(capacity));
    this.slotZ = grown(this.slotZ, new Int32Array(capacity));
    this.slotAxis = grown(this.slotAxis, new Int8Array(capacity));
    this.slotClass = grown(this.slotClass, new Int32Array(capacity));
    this.slotNext = grown(this.slotNext, new Int32Array(capacity));
    this.slotRegionNext = grown(this.slotRegionNext, new Int32Array(capacity));
  }
}

function grown<T extends Int32Array | Int8Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
