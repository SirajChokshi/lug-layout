import {
  HALF_TURN_16,
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  ZETA16_ZERO,
  composePose16,
  normalizeHeading16,
  pose16,
  zeta16,
} from "@brr/math";
import { NEAR_MISS_RADIUS_LDU } from "../track/end-gaps.ts";
import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import { SOURCE_SHADOW, STATUS_VERIFIED } from "./connector-table.ts";
import { IntKeyMap, MISSING } from "./int-key-map.ts";
import { QUARTER_TURNS, checkPose } from "./lattice-frame.ts";
import type { MateFinder } from "./mate-finder.ts";
import { NO_SHAPE, type MateReport } from "./mate-report.ts";
import { NO_INSTANCE, type ModelConnectors } from "./model-connectors.ts";

const COEFFICIENTS = ZETA16_COEFFICIENT_COUNT;
const HEADING_KEY = COEFFICIENTS;
const Y_KEY = COEFFICIENTS + 1;
const KEY_INTS = COEFFICIENTS + 2;
const STEPS_PER_TURN = ZETA16_ORDER / QUARTER_TURNS;
const REAL_AXIS = 0;
const QUARTER_AXIS = COEFFICIENTS / 2;
const INITIAL_SLOTS = 64;
const NO_HOLDER = -1;
const STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const COS16 = Float64Array.from({ length: COEFFICIENTS }, (_, k) => Math.cos(k * STEP_RADIANS));
const SIN16 = Float64Array.from({ length: COEFFICIENTS }, (_, k) => Math.sin(k * STEP_RADIANS));

function headingOfTurn(rot: number): number {
  return normalizeHeading16(-rot * STEPS_PER_TURN);
}

export class TrackEndFinder implements MateFinder {
  readonly namesPartners = true;
  readonly proposesEveryPose = false;
  private readonly index = new IntKeyMap(KEY_INTS);
  private readonly key = new Int32Array(KEY_INTS);
  private slotPosition = new Int32Array(INITIAL_SLOTS * COEFFICIENTS);
  private slotHeading = new Uint8Array(INITIAL_SLOTS);
  private slotY = new Int32Array(INITIAL_SLOTS);
  private slotCount = new Int32Array(INITIAL_SLOTS);
  private slotX = new Float64Array(INITIAL_SLOTS);
  private slotZ = new Float64Array(INITIAL_SLOTS);
  private slotHolder = new Int32Array(INITIAL_SLOTS);
  private holderOwner = new Int32Array(INITIAL_SLOTS);
  private holderEnd = new Int32Array(INITIAL_SLOTS);
  private holderInstance = new Int32Array(INITIAL_SLOTS);
  private holderNext = new Int32Array(INITIAL_SLOTS);
  private holders = 0;
  private freeHolder = NO_HOLDER;
  private slots = 0;
  private turnedModel: ModelConnectors | null = null;
  private turnedPosition = new Int32Array(0);
  private turnedHeading = new Uint8Array(0);

  insert(model: ModelConnectors, pose: LatticePose, owner: number): void {
    checkPose(pose);
    if (!this.onStudGrid(pose)) return;
    this.turn(model);
    for (let e = 0; e < model.trackEndCount; e++) {
      const key = this.placedKey(model, e, pose);
      let slot = this.index.get(key);
      if (slot === MISSING) slot = this.claim(key);
      const holder = this.allocateHolder();
      this.holderOwner[holder] = owner;
      this.holderEnd[holder] = e;
      this.holderInstance[holder] = model.trackInstance[e] ?? NO_INSTANCE;
      this.holderNext[holder] = this.slotHolder[slot] ?? NO_HOLDER;
      this.slotHolder[slot] = holder;
      this.slotCount[slot] = (this.slotCount[slot] ?? 0) + 1;
    }
  }

  remove(model: ModelConnectors, pose: LatticePose, owner: number): void {
    checkPose(pose);
    if (!this.onStudGrid(pose)) return;
    this.turn(model);
    for (let e = 0; e < model.trackEndCount; e++) {
      const slot = this.index.get(this.placedKey(model, e, pose));
      if (slot === MISSING || !this.unlinkHolder(slot, owner, e)) {
        throw new RangeError(`placement ${owner} has no placed track end ${e} to remove`);
      }
      this.slotCount[slot] = (this.slotCount[slot] ?? 0) - 1;
    }
  }

  propose(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void {
    checkPose(window);
    this.turn(model);
    const radius = (window.cells * STUD_LDU + NEAR_MISS_RADIUS_LDU) / STUD_LDU;
    for (let t = 0; t < window.turns; t++) {
      const rot = (window.rot + t) % QUARTER_TURNS;
      for (let e = 0; e < model.trackEndCount; e++) {
        const at = (rot * model.trackEndCount + e) * COEFFICIENTS;
        const facing = (this.turnedHeading[rot * model.trackEndCount + e] ?? 0) + HALF_TURN_16;
        const x = this.studsX(this.turnedPosition, at) + window.x / STUD_LDU;
        const z = this.studsZ(this.turnedPosition, at) + window.z / STUD_LDU;
        for (let slot = 0; slot < this.slots; slot++) {
          if (this.slotCount[slot] === 0) continue;
          if (this.slotHeading[slot] !== facing % ZETA16_ORDER) continue;
          const dx = (this.slotX[slot] ?? 0) - x;
          const dz = (this.slotZ[slot] ?? 0) - z;
          if (dx * dx + dz * dz > radius * radius) continue;
          this.proposeJoin(slot, at, model.trackYPlates[e] ?? 0, rot, out);
        }
      }
    }
  }

  count(model: ModelConnectors, pose: LatticePose): number {
    checkPose(pose);
    if (!this.onStudGrid(pose)) return 0;
    this.turn(model);
    let n = 0;
    for (let e = 0; e < model.trackEndCount; e++) {
      const slot = this.index.get(this.facingKey(model, e, pose));
      if (slot !== MISSING) n += this.slotCount[slot] ?? 0;
    }
    return n;
  }

  mates(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    checkPose(pose);
    if (!this.onStudGrid(pose)) return;
    this.turn(model);
    for (let e = 0; e < model.trackEndCount; e++) {
      const slot = this.index.get(this.facingKey(model, e, pose));
      if (slot === MISSING) continue;
      for (
        let holder = this.slotHolder[slot] ?? NO_HOLDER;
        holder !== NO_HOLDER;
        holder = this.holderNext[holder] ?? NO_HOLDER
      ) {
        out.push(
          e,
          NO_SHAPE,
          0,
          NO_SHAPE,
          0,
          SOURCE_SHADOW,
          STATUS_VERIFIED,
          this.holderOwner[holder] ?? 0,
          model.trackInstance[e] ?? NO_INSTANCE,
          this.holderInstance[holder] ?? NO_INSTANCE,
          null,
        );
      }
    }
  }

  private allocateHolder(): number {
    if (this.freeHolder !== NO_HOLDER) {
      const holder = this.freeHolder;
      this.freeHolder = this.holderNext[holder] ?? NO_HOLDER;
      return holder;
    }
    if (this.holders === this.holderOwner.length) {
      const capacity = this.holderOwner.length * 2;
      this.holderOwner = grown(this.holderOwner, new Int32Array(capacity));
      this.holderEnd = grown(this.holderEnd, new Int32Array(capacity));
      this.holderInstance = grown(this.holderInstance, new Int32Array(capacity));
      this.holderNext = grown(this.holderNext, new Int32Array(capacity));
    }
    return this.holders++;
  }

  private unlinkHolder(slot: number, owner: number, end: number): boolean {
    let previous = NO_HOLDER;
    for (
      let holder = this.slotHolder[slot] ?? NO_HOLDER;
      holder !== NO_HOLDER;
      holder = this.holderNext[holder] ?? NO_HOLDER
    ) {
      if (this.holderOwner[holder] !== owner || this.holderEnd[holder] !== end) {
        previous = holder;
        continue;
      }
      const next = this.holderNext[holder] ?? NO_HOLDER;
      if (previous === NO_HOLDER) this.slotHolder[slot] = next;
      else this.holderNext[previous] = next;
      this.holderNext[holder] = this.freeHolder;
      this.freeHolder = holder;
      return true;
    }
    return false;
  }

  private placedKey(model: ModelConnectors, end: number, pose: LatticePose): Int32Array {
    const at = (pose.rot * model.trackEndCount + end) * COEFFICIENTS;
    for (let k = 0; k < COEFFICIENTS; k++) this.key[k] = this.turnedPosition[at + k] ?? 0;
    this.key[REAL_AXIS] = (this.key[REAL_AXIS] ?? 0) + pose.x / STUD_LDU;
    this.key[QUARTER_AXIS] = (this.key[QUARTER_AXIS] ?? 0) + pose.z / STUD_LDU;
    this.key[HEADING_KEY] = this.turnedHeading[pose.rot * model.trackEndCount + end] ?? 0;
    this.key[Y_KEY] = (model.trackYPlates[end] ?? 0) + pose.yPlates;
    return this.key;
  }

  private facingKey(model: ModelConnectors, end: number, pose: LatticePose): Int32Array {
    const key = this.placedKey(model, end, pose);
    key[HEADING_KEY] = ((key[HEADING_KEY] ?? 0) + HALF_TURN_16) % ZETA16_ORDER;
    return key;
  }

  private proposeJoin(
    slot: number,
    turnedAt: number,
    endYPlates: number,
    rot: number,
    out: CandidatePoses,
  ): void {
    const from = slot * COEFFICIENTS;
    for (let k = 0; k < COEFFICIENTS; k++) {
      if (k === REAL_AXIS || k === QUARTER_AXIS) continue;
      if (this.slotPosition[from + k] !== this.turnedPosition[turnedAt + k]) return;
    }
    const x =
      (this.slotPosition[from + REAL_AXIS] ?? 0) - (this.turnedPosition[turnedAt + REAL_AXIS] ?? 0);
    const z =
      (this.slotPosition[from + QUARTER_AXIS] ?? 0) -
      (this.turnedPosition[turnedAt + QUARTER_AXIS] ?? 0);
    out.add(x * STUD_LDU, z * STUD_LDU, (this.slotY[slot] ?? 0) - endYPlates, rot);
  }

  private onStudGrid(pose: LatticePose): boolean {
    return pose.x % STUD_LDU === 0 && pose.z % STUD_LDU === 0;
  }

  private claim(key: Int32Array): number {
    if (this.slots === this.slotCount.length) this.growSlots();
    const slot = this.slots++;
    this.slotPosition.set(key.subarray(0, COEFFICIENTS), slot * COEFFICIENTS);
    this.slotHeading[slot] = key[HEADING_KEY] ?? 0;
    this.slotY[slot] = key[Y_KEY] ?? 0;
    this.slotHolder[slot] = NO_HOLDER;
    this.slotX[slot] = this.studsX(this.slotPosition, slot * COEFFICIENTS);
    this.slotZ[slot] = this.studsZ(this.slotPosition, slot * COEFFICIENTS);
    this.index.set(key, slot);
    return slot;
  }

  private studsX(position: Int32Array, at: number): number {
    let x = 0;
    for (let k = 0; k < COEFFICIENTS; k++) x += (position[at + k] ?? 0) * (COS16[k] ?? 0);
    return x;
  }

  private studsZ(position: Int32Array, at: number): number {
    let z = 0;
    for (let k = 0; k < COEFFICIENTS; k++) z += (position[at + k] ?? 0) * (SIN16[k] ?? 0);
    return z;
  }

  private turn(model: ModelConnectors): void {
    if (this.turnedModel === model) return;
    const ends = model.trackEndCount;
    this.turnedPosition = new Int32Array(QUARTER_TURNS * ends * COEFFICIENTS);
    this.turnedHeading = new Uint8Array(QUARTER_TURNS * ends);
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      const frame = pose16(ZETA16_ZERO, headingOfTurn(rot));
      for (let e = 0; e < ends; e++) {
        const coefficients: bigint[] = [];
        for (let k = 0; k < COEFFICIENTS; k++) {
          coefficients.push(BigInt(model.trackPosition[e * COEFFICIENTS + k] ?? 0));
        }
        const local = pose16(zeta16(coefficients), model.trackHeading[e] ?? 0);
        const turned = composePose16(frame, local);
        const at = (rot * ends + e) * COEFFICIENTS;
        for (let k = 0; k < COEFFICIENTS; k++) {
          this.turnedPosition[at + k] = Number(turned.position[k] ?? 0n);
        }
        this.turnedHeading[rot * ends + e] = turned.heading;
      }
    }
    this.turnedModel = model;
  }

  private growSlots(): void {
    const capacity = this.slotCount.length * 2;
    this.slotPosition = grown(this.slotPosition, new Int32Array(capacity * COEFFICIENTS));
    this.slotHeading = grown(this.slotHeading, new Uint8Array(capacity));
    this.slotY = grown(this.slotY, new Int32Array(capacity));
    this.slotCount = grown(this.slotCount, new Int32Array(capacity));
    this.slotX = grown(this.slotX, new Float64Array(capacity));
    this.slotZ = grown(this.slotZ, new Float64Array(capacity));
    this.slotHolder = grown(this.slotHolder, new Int32Array(capacity));
  }
}

function grown<T extends Int32Array | Uint8Array | Float64Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
