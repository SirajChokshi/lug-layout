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
  type LatticePose,
  type MateReport,
  type OverlapHit,
  type PosedTechnic,
  type TechnicSet,
} from "@brr/domain";
import { SIXTEENTHS_PER_LDU, STUD_LDU } from "@brr/math";
import {
  PART_BOX_FLOATS,
  RANGE_INTS,
  localCellRange,
  posedBox,
  type PartBoxes,
} from "./part-boxes.ts";

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
const DEFERRED_INTS = 3;
const INITIAL_ZONES = 16;
const NO_ZONE = -1;

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

function inCell(box: Float64Array, cellX: number, cellZ: number): boolean {
  const x0 = cellX * STUD_LDU;
  const z0 = cellZ * STUD_LDU;
  return (
    (box[X] ?? 0) < x0 + STUD_LDU &&
    (box[AXES + X] ?? 0) > x0 &&
    (box[Z] ?? 0) < z0 + STUD_LDU &&
    (box[AXES + Z] ?? 0) > z0
  );
}

export class MateZones {
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
  private readonly ownCells = new Int32Array(RANGE_INTS);
  private readonly theirCells = new Int32Array(RANGE_INTS);
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
      posedBox(boxes.boxes, own, pose, this.ownBox);
      posedBox(other.boxes.boxes, theirs, other.pose, this.theirBox);
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

  exempts(owner: number, cellX: number, cellZ: number): boolean {
    for (let z = 0; z < this.zones; z++) {
      const at = z * ZONE_INTS;
      if (
        this.zoneInts[at + PARTNER] === owner &&
        cellX >= (this.zoneInts[at + CELL_X0] ?? 0) &&
        cellX < (this.zoneInts[at + CELL_X1] ?? 0) &&
        cellZ >= (this.zoneInts[at + CELL_Z0] ?? 0) &&
        cellZ < (this.zoneInts[at + CELL_Z1] ?? 0)
      ) {
        this.defer(owner, cellX, cellZ);
        return true;
      }
    }
    return false;
  }

  firstOverlap(out: OverlapHit): boolean {
    const boxes = this.boxes;
    const pose = this.pose;
    const placed = this.placed;
    if (!boxes || !pose || !placed) return false;
    for (let d = 0; d < this.deferred; d++) {
      const owner = this.deferredInts[d * DEFERRED_INTS] ?? 0;
      const cellX = this.deferredInts[d * DEFERRED_INTS + 1] ?? 0;
      const cellZ = this.deferredInts[d * DEFERRED_INTS + 2] ?? 0;
      const other = placed.get(owner);
      if (!other) throw new RangeError(`placement ${owner} has volume but no parts`);
      if (this.firstPartOverlap(boxes, pose, other, owner, cellX, cellZ, out)) return true;
    }
    return false;
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

  private firstPartOverlap(
    boxes: PartBoxes,
    pose: LatticePose,
    other: PlacedParts,
    owner: number,
    cellX: number,
    cellZ: number,
    out: OverlapHit,
  ): boolean {
    const own = localCellRange(boxes, pose, cellX, cellZ, this.ownCells);
    const theirs = localCellRange(other.boxes, other.pose, cellX, cellZ, this.theirCells);
    for (let lz = own[1] ?? 0; lz < (own[3] ?? 0); lz++) {
      for (let lx = own[0] ?? 0; lx < (own[2] ?? 0); lx++) {
        const cell = (lz - boxes.cellZ0) * boxes.width + (lx - boxes.cellX0);
        for (let r = boxes.cellStart[cell] ?? 0; r < (boxes.cellStart[cell + 1] ?? 0); r++) {
          const instance = boxes.cellInstance[r] ?? 0;
          posedBox(boxes.boxes, instance, pose, this.ownBox);
          if (!inCell(this.ownBox, cellX, cellZ)) continue;
          if (!this.clashes(instance, other, owner, theirs, cellX, cellZ)) continue;
          out.owner = owner;
          out.cellX = cellX;
          out.cellZ = cellZ;
          out.bottomLdu = Math.floor(this.theirBox[Y] ?? 0);
          out.topLdu = Math.ceil(this.theirBox[AXES + Y] ?? 0);
          out.candidateBottomLdu = Math.floor(this.ownBox[Y] ?? 0);
          out.candidateTopLdu = Math.ceil(this.ownBox[AXES + Y] ?? 0);
          return true;
        }
      }
    }
    return false;
  }

  private clashes(
    own: number,
    other: PlacedParts,
    owner: number,
    cells: Int32Array,
    cellX: number,
    cellZ: number,
  ): boolean {
    const boxes = other.boxes;
    for (let lz = cells[1] ?? 0; lz < (cells[3] ?? 0); lz++) {
      for (let lx = cells[0] ?? 0; lx < (cells[2] ?? 0); lx++) {
        const cell = (lz - boxes.cellZ0) * boxes.width + (lx - boxes.cellX0);
        for (let r = boxes.cellStart[cell] ?? 0; r < (boxes.cellStart[cell + 1] ?? 0); r++) {
          const theirs = boxes.cellInstance[r] ?? 0;
          posedBox(boxes.boxes, theirs, other.pose, this.theirBox);
          if (!intersect(this.ownBox, this.theirBox, this.region)) continue;
          if (!inCell(this.region, cellX, cellZ)) continue;
          if (!this.excused(owner, own, theirs, other)) return true;
        }
      }
    }
    return false;
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

  private defer(owner: number, cellX: number, cellZ: number): void {
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
