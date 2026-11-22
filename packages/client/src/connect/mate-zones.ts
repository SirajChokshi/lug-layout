import {
  ENGAGED_AXIS,
  ENGAGED_FROM,
  ENGAGED_RADIUS,
  ENGAGED_TO,
  ENGAGED_U,
  ENGAGED_V,
  ENGAGEMENT_FLOATS,
  NO_INSTANCE,
  NO_PARTNER,
  NO_TECHNIC_ITEM,
  NOT_ENGAGED,
  TECHNIC_WAIVER_INTS,
  firstOtherAxis,
  placeTechnicInto,
  PosedTechnicBuffer,
  secondOtherAxis,
  technicItemsOverlap,
  technicScratch,
  type CellVolumes,
  type LatticePose,
  type MateReport,
  type OverlapHit,
  type PairExcuse,
  type PosedTechnic,
  type TechnicSet,
  type VolumeIndex,
} from "@brr/domain";
import { PLATE_LDU, SIXTEENTHS_PER_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { PART_BOX_FLOATS, type PartBoxes } from "./part-boxes.ts";

export interface PlacedParts {
  readonly boxes: PartBoxes;
  readonly technic: TechnicSet;
  readonly pose: LatticePose;
}

const AXES = 3;
const X = 0;
const Y = 1;
const Z = 2;
const PARTNER = 0;
const OWN = 1;
const THEIRS = 2;
const CELL_X0 = 3;
const CELL_Z0 = 4;
const CELL_X1 = 5;
const CELL_Z1 = 6;
const WAIVED = 7;
const WAIVER = 8;
const ZONE_INTS = WAIVER + TECHNIC_WAIVER_INTS;
const DEFERRED_INTS = 4;
const INITIAL_ZONES = 16;
const NO_ZONE = -1;

function cosOf(pose: LatticePose): number {
  return isRot90(pose.rot) ? rot90Cos(pose.rot) : 1;
}

function sinOf(pose: LatticePose): number {
  return isRot90(pose.rot) ? rot90Sin(pose.rot) : 0;
}

function poseBox(
  boxes: Float64Array,
  instance: number,
  pose: LatticePose,
  out: Float64Array,
): void {
  const b = instance * PART_BOX_FLOATS;
  const cos = cosOf(pose);
  const sin = sinOf(pose);
  const loX = boxes[b + X] ?? 0;
  const loZ = boxes[b + Z] ?? 0;
  const hiX = boxes[b + AXES + X] ?? 0;
  const hiZ = boxes[b + AXES + Z] ?? 0;
  const yLdu = pose.yPlates * PLATE_LDU;
  out[X] = Math.min(cos * loX, cos * hiX) + Math.min(sin * loZ, sin * hiZ) + pose.x;
  out[AXES + X] = Math.max(cos * loX, cos * hiX) + Math.max(sin * loZ, sin * hiZ) + pose.x;
  out[Z] = Math.min(-sin * loX, -sin * hiX) + Math.min(cos * loZ, cos * hiZ) + pose.z;
  out[AXES + Z] = Math.max(-sin * loX, -sin * hiX) + Math.max(cos * loZ, cos * hiZ) + pose.z;
  out[Y] = (boxes[b + Y] ?? 0) + yLdu;
  out[AXES + Y] = (boxes[b + AXES + Y] ?? 0) + yLdu;
}

function intersect(a: Float64Array, b: Float64Array, out: Float64Array): boolean {
  for (let k = 0; k < AXES; k++) {
    out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
    out[AXES + k] = Math.min(a[AXES + k] ?? 0, b[AXES + k] ?? 0);
    if ((out[k] ?? 0) >= (out[AXES + k] ?? 0)) return false;
  }
  return true;
}

function within(inner: Float64Array, outer: Float64Array, at: number): boolean {
  for (let k = 0; k < AXES; k++) {
    if ((inner[k] ?? 0) < (outer[at + k] ?? 0)) return false;
    if ((inner[AXES + k] ?? 0) > (outer[at + AXES + k] ?? 0)) return false;
  }
  return true;
}

export class MateZones implements PairExcuse {
  private zones = 0;
  private zoneInts = new Int32Array(INITIAL_ZONES * ZONE_INTS);
  private zoneBoxes = new Float64Array(INITIAL_ZONES * PART_BOX_FLOATS);
  private deferred = 0;
  private deferredInts = new Int32Array(INITIAL_ZONES * DEFERRED_INTS);
  private waivers = new Int32Array(INITIAL_ZONES * TECHNIC_WAIVER_INTS);
  private zoneOfJoint = new Int32Array(INITIAL_ZONES);
  private readonly ownBox = new Float64Array(PART_BOX_FLOATS);
  private readonly theirBox = new Float64Array(PART_BOX_FLOATS);
  private readonly region = new Float64Array(PART_BOX_FLOATS);
  private readonly cylinder = new Float64Array(PART_BOX_FLOATS);
  private boxes: PartBoxes | null = null;
  private technic: TechnicSet | null = null;
  private pose: LatticePose | null = null;
  private placed: ReadonlyMap<number, PlacedParts> | null = null;
  private posedTechnic: PosedTechnic | null = null;
  private posedTechnicOf: TechnicSet | null = null;
  private readonly theirTechnic = new PosedTechnicBuffer();

  clear(): void {
    this.zones = 0;
    this.deferred = 0;
  }

  collect(
    report: MateReport,
    boxes: PartBoxes,
    technic: TechnicSet,
    pose: LatticePose,
    placed: ReadonlyMap<number, PlacedParts>,
  ): number {
    this.clear();
    this.boxes = boxes;
    this.technic = technic;
    this.pose = pose;
    this.placed = placed;
    this.reserveZones(report.count, report.jointCount);
    this.zoneOfJoint.fill(NO_ZONE, 0, report.jointCount);
    for (let k = 0; k < report.count; k++) {
      const partner = report.partner[k] ?? NO_PARTNER;
      const own = report.instance[k] ?? NO_INSTANCE;
      const theirs = report.partnerInstance[k] ?? NO_INSTANCE;
      const other = partner === NO_PARTNER ? undefined : placed.get(partner);
      if (!other || own === NO_INSTANCE || theirs === NO_INSTANCE) continue;
      poseBox(boxes.boxes, own, pose, this.ownBox);
      poseBox(other.boxes.boxes, theirs, other.pose, this.theirBox);
      if (!intersect(this.ownBox, this.theirBox, this.region)) continue;
      const engaged = report.engagement[k * ENGAGEMENT_FLOATS + ENGAGED_AXIS] ?? NOT_ENGAGED;
      if (engaged !== NOT_ENGAGED && !this.cutToEngagement(report, k)) continue;
      const joint = report.joint[k] ?? 0;
      const zone = this.zoneOfJoint[joint] ?? NO_ZONE;
      if (zone === NO_ZONE) {
        this.zoneOfJoint[joint] = this.addZone(
          partner,
          own,
          theirs,
          engaged !== NOT_ENGAGED,
          report,
          k,
        );
      } else {
        this.widenZone(zone, report, k);
      }
    }
    this.reserveDeferred(this.zoneCells());
    if (this.zones > 0 && technic.count > 0) placeTechnicInto(technic, pose, this.posed(technic));
    return this.zones;
  }

  exempts(owner: number, cellX: number, cellZ: number, heldCell: number): boolean {
    for (let z = 0; z < this.zones; z++) {
      const at = z * ZONE_INTS;
      if (
        this.zoneInts[at + PARTNER] === owner &&
        cellX >= (this.zoneInts[at + CELL_X0] ?? 0) &&
        cellX < (this.zoneInts[at + CELL_X1] ?? 0) &&
        cellZ >= (this.zoneInts[at + CELL_Z0] ?? 0) &&
        cellZ < (this.zoneInts[at + CELL_Z1] ?? 0)
      ) {
        this.defer(owner, cellX, cellZ, heldCell);
        return true;
      }
    }
    return false;
  }

  firstOverlap(index: VolumeIndex, held: CellVolumes, out: OverlapHit): boolean {
    const placed = this.placed;
    if (!placed) return false;
    for (let d = 0; d < this.deferred; d++) {
      const at = d * DEFERRED_INTS;
      const owner = this.deferredInts[at] ?? 0;
      const cellX = this.deferredInts[at + 1] ?? 0;
      const cellZ = this.deferredInts[at + 2] ?? 0;
      const heldCell = this.deferredInts[at + 3] ?? 0;
      if (!placed.has(owner)) throw new RangeError(`placement ${owner} has volume but no parts`);
      if (!index.firstUnexcusedOverlap(cellX, cellZ, held, heldCell, owner, this, out)) continue;
      out.cellX = cellX;
      out.cellZ = cellZ;
      return true;
    }
    return false;
  }

  excuses(owner: number, own: number, theirs: number, region: Float64Array): boolean {
    const other = this.placed?.get(owner);
    if (!other) return false;
    this.region.set(region);
    return this.excused(owner, own, theirs, other);
  }

  private cutToEngagement(report: MateReport, k: number): boolean {
    const at = k * ENGAGEMENT_FLOATS;
    const along = report.engagement[at + ENGAGED_AXIS] ?? 0;
    const u = firstOtherAxis(along);
    const v = secondOtherAxis(along);
    const atU = (report.engagement[at + ENGAGED_U] ?? 0) / SIXTEENTHS_PER_LDU;
    const atV = (report.engagement[at + ENGAGED_V] ?? 0) / SIXTEENTHS_PER_LDU;
    const radius = (report.engagement[at + ENGAGED_RADIUS] ?? 0) / SIXTEENTHS_PER_LDU;
    this.cylinder[along] = (report.engagement[at + ENGAGED_FROM] ?? 0) / SIXTEENTHS_PER_LDU;
    this.cylinder[AXES + along] = (report.engagement[at + ENGAGED_TO] ?? 0) / SIXTEENTHS_PER_LDU;
    this.cylinder[u] = atU - radius;
    this.cylinder[AXES + u] = atU + radius;
    this.cylinder[v] = atV - radius;
    this.cylinder[AXES + v] = atV + radius;
    return intersect(this.region, this.cylinder, this.region);
  }

  private addZone(
    partner: number,
    own: number,
    theirs: number,
    engaged: boolean,
    report: MateReport,
    k: number,
  ): number {
    const z = this.zones++;
    const at = z * ZONE_INTS;
    const e = k * ENGAGEMENT_FLOATS;
    const lineU = report.engagement[e + ENGAGED_U] ?? 0;
    const lineV = report.engagement[e + ENGAGED_V] ?? 0;
    const onWholeLine = lineU % SIXTEENTHS_PER_LDU === 0 && lineV % SIXTEENTHS_PER_LDU === 0;
    const waived = engaged && onWholeLine;
    this.zoneInts[at + PARTNER] = partner;
    this.zoneInts[at + OWN] = own;
    this.zoneInts[at + THEIRS] = theirs;
    this.zoneInts[at + WAIVED] = waived ? 1 : 0;
    this.zoneInts[at + WAIVER] = waived ? (report.engagement[e + ENGAGED_AXIS] ?? 0) : 0;
    this.zoneInts[at + WAIVER + 1] = waived ? lineU / SIXTEENTHS_PER_LDU : 0;
    this.zoneInts[at + WAIVER + 2] = waived ? lineV / SIXTEENTHS_PER_LDU : 0;
    this.zoneInts[at + WAIVER + 3] = waived
      ? Math.floor((report.engagement[e + ENGAGED_FROM] ?? 0) / SIXTEENTHS_PER_LDU)
      : 0;
    this.zoneInts[at + WAIVER + 4] = waived
      ? Math.ceil((report.engagement[e + ENGAGED_TO] ?? 0) / SIXTEENTHS_PER_LDU)
      : 0;
    this.zoneBoxes.set(this.region, z * PART_BOX_FLOATS);
    this.coverCells(z);
    return z;
  }

  private widenZone(z: number, report: MateReport, k: number): void {
    const at = z * PART_BOX_FLOATS;
    for (let a = 0; a < AXES; a++) {
      this.zoneBoxes[at + a] = Math.min(this.zoneBoxes[at + a] ?? 0, this.region[a] ?? 0);
      this.zoneBoxes[at + AXES + a] = Math.max(
        this.zoneBoxes[at + AXES + a] ?? 0,
        this.region[AXES + a] ?? 0,
      );
    }
    this.coverCells(z);
    const zi = z * ZONE_INTS;
    if (this.zoneInts[zi + WAIVED] !== 1) return;
    const e = k * ENGAGEMENT_FLOATS;
    this.zoneInts[zi + WAIVER + 3] = Math.min(
      this.zoneInts[zi + WAIVER + 3] ?? 0,
      Math.floor((report.engagement[e + ENGAGED_FROM] ?? 0) / SIXTEENTHS_PER_LDU),
    );
    this.zoneInts[zi + WAIVER + 4] = Math.max(
      this.zoneInts[zi + WAIVER + 4] ?? 0,
      Math.ceil((report.engagement[e + ENGAGED_TO] ?? 0) / SIXTEENTHS_PER_LDU),
    );
  }

  private coverCells(z: number): void {
    const box = z * PART_BOX_FLOATS;
    const at = z * ZONE_INTS;
    this.zoneInts[at + CELL_X0] = Math.floor((this.zoneBoxes[box + X] ?? 0) / STUD_LDU);
    this.zoneInts[at + CELL_Z0] = Math.floor((this.zoneBoxes[box + Z] ?? 0) / STUD_LDU);
    this.zoneInts[at + CELL_X1] = Math.ceil((this.zoneBoxes[box + AXES + X] ?? 0) / STUD_LDU);
    this.zoneInts[at + CELL_Z1] = Math.ceil((this.zoneBoxes[box + AXES + Z] ?? 0) / STUD_LDU);
  }

  private zoneCells(): number {
    let cells = 0;
    for (let z = 0; z < this.zones; z++) {
      const at = z * ZONE_INTS;
      cells +=
        ((this.zoneInts[at + CELL_X1] ?? 0) - (this.zoneInts[at + CELL_X0] ?? 0)) *
        ((this.zoneInts[at + CELL_Z1] ?? 0) - (this.zoneInts[at + CELL_Z0] ?? 0));
    }
    return cells;
  }

  private excused(owner: number, own: number, theirs: number, other: PlacedParts): boolean {
    let mated = false;
    let contained = false;
    let waivers = 0;
    for (let z = 0; z < this.zones; z++) {
      const at = z * ZONE_INTS;
      if (
        this.zoneInts[at + PARTNER] !== owner ||
        this.zoneInts[at + OWN] !== own ||
        this.zoneInts[at + THEIRS] !== theirs
      ) {
        continue;
      }
      mated = true;
      contained ||= within(this.region, this.zoneBoxes, z * PART_BOX_FLOATS);
      if (this.zoneInts[at + WAIVED] !== 1) continue;
      for (let w = 0; w < TECHNIC_WAIVER_INTS; w++) {
        this.waivers[waivers * TECHNIC_WAIVER_INTS + w] = this.zoneInts[at + WAIVER + w] ?? 0;
      }
      waivers++;
    }
    if (!mated) return false;
    const ownItem = this.technic?.itemOfInstance[own] ?? NO_TECHNIC_ITEM;
    const theirItem = other.technic.itemOfInstance[theirs] ?? NO_TECHNIC_ITEM;
    const posed = this.posedTechnic;
    if (ownItem === NO_TECHNIC_ITEM || theirItem === NO_TECHNIC_ITEM || !posed) return contained;
    const theirPosed = this.theirTechnic.placeItem(other.technic, theirItem, other.pose);
    return !technicItemsOverlap(posed, ownItem, theirPosed, theirItem, this.waivers, waivers);
  }

  private defer(owner: number, cellX: number, cellZ: number, heldCell: number): void {
    for (let d = 0; d < this.deferred; d++) {
      const at = d * DEFERRED_INTS;
      if (
        this.deferredInts[at] === owner &&
        this.deferredInts[at + 1] === cellX &&
        this.deferredInts[at + 2] === cellZ
      ) {
        return;
      }
    }
    const at = this.deferred++ * DEFERRED_INTS;
    this.deferredInts[at] = owner;
    this.deferredInts[at + 1] = cellX;
    this.deferredInts[at + 2] = cellZ;
    this.deferredInts[at + 3] = heldCell;
  }

  private reserveZones(zones: number, joints: number): void {
    if (joints > this.zoneOfJoint.length) this.zoneOfJoint = new Int32Array(joints);
    if (zones * ZONE_INTS <= this.zoneInts.length) return;
    this.zoneInts = new Int32Array(zones * ZONE_INTS);
    this.zoneBoxes = new Float64Array(zones * PART_BOX_FLOATS);
    this.waivers = new Int32Array(zones * TECHNIC_WAIVER_INTS);
  }

  private reserveDeferred(cells: number): void {
    if (cells * DEFERRED_INTS <= this.deferredInts.length) return;
    this.deferredInts = new Int32Array(cells * DEFERRED_INTS);
  }

  private posed(local: TechnicSet): PosedTechnic {
    if (!this.posedTechnic || this.posedTechnicOf !== local) {
      this.posedTechnic = technicScratch(local);
      this.posedTechnicOf = local;
    }
    return this.posedTechnic;
  }
}
