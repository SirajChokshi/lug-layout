import {
  AXIS_NEG_Y,
  GENDER_FEMALE,
  WORLD_TRACK_FRAME,
  type ConnectorTable,
  type PlacementFrame,
  type TrackClearance,
} from "@brr/domain";
import {
  QUARTER_TURN_16,
  STUD_LDU,
  isLatticePose16,
  normalizeHeading16,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import type { TrackPartFrame } from "@brr/schema/bundle";
import { cellKey } from "./track-obstacles.ts";

const SIXTEENTHS_PER_LDU = 16;
const STUD_SIXTEENTHS = STUD_LDU * SIXTEENTHS_PER_LDU;
const STUD_CENTRE_SIXTEENTHS = STUD_SIXTEENTHS / 2;
const HALF_STEPS_PER_QUARTER_TURN = 8;
const QUARTER_TURNS = 4;
const QUARTER_COS = [1, 0, -1, 0] as const;
const QUARTER_SIN = [0, 1, 0, -1] as const;
const HALF_STEP_RADIANS = Math.PI / HALF_STEPS_PER_QUARTER_TURN / 2;
const ORIGIN_FLOATS = 3;

export function antiStudsOf(table: ConnectorTable, undersideLdu: number): Int32Array {
  const underside = undersideLdu * SIXTEENTHS_PER_LDU;
  const origins: number[] = [];
  for (let c = 0; c < table.count; c++) {
    if (table.gender[c] !== GENDER_FEMALE || table.axis[c] !== AXIS_NEG_Y) continue;
    const at = c * ORIGIN_FLOATS;
    if (table.origin[at + 1] !== underside) continue;
    origins.push(table.origin[at] ?? 0, table.origin[at + 2] ?? 0);
  }
  return Int32Array.from(origins);
}

interface PartPose {
  readonly x: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;
  readonly exact: boolean;
}

function quarter(turns: number): number {
  return ((turns % QUARTER_TURNS) + QUARTER_TURNS) % QUARTER_TURNS;
}

function exactPartPose(frame: TrackPartFrame, placement: Pose16): PartPose | null {
  if (!isLatticePose16(placement)) return null;
  if (frame.headingHalfSteps % HALF_STEPS_PER_QUARTER_TURN !== 0) return null;
  const frameX = frame.xLdu * SIXTEENTHS_PER_LDU;
  const frameZ = frame.zLdu * SIXTEENTHS_PER_LDU;
  if (!Number.isInteger(frameX) || !Number.isInteger(frameZ)) return null;
  const pieceQuarter = quarter(normalizeHeading16(placement.heading) / QUARTER_TURN_16);
  const partQuarter = quarter(pieceQuarter + frame.headingHalfSteps / HALF_STEPS_PER_QUARTER_TURN);
  const pieceCos = QUARTER_COS[pieceQuarter] ?? 1;
  const pieceSin = QUARTER_SIN[pieceQuarter] ?? 0;
  const at = zeta16ToStuds(placement.position);
  return {
    x: at.x * STUD_SIXTEENTHS + pieceCos * frameX - pieceSin * frameZ,
    z: at.z * STUD_SIXTEENTHS + pieceSin * frameX + pieceCos * frameZ,
    cos: QUARTER_COS[partQuarter] ?? 1,
    sin: QUARTER_SIN[partQuarter] ?? 0,
    exact: true,
  };
}

function framedPartPose(
  frame: TrackPartFrame,
  placement: Pose16,
  runFrame: PlacementFrame,
): PartPose {
  const part = placedPartPose(frame, placement);
  const offsetX = runFrame.xLdu * SIXTEENTHS_PER_LDU;
  const offsetZ = runFrame.zLdu * SIXTEENTHS_PER_LDU;
  return {
    ...part,
    x: part.x + offsetX,
    z: part.z + offsetZ,
    exact: part.exact && Number.isInteger(offsetX) && Number.isInteger(offsetZ),
  };
}

function placedPartPose(frame: TrackPartFrame, placement: Pose16): PartPose {
  const exact = exactPartPose(frame, placement);
  if (exact) return exact;
  const at = zeta16ToStuds(placement.position);
  const { x: cos, z: sin } = zeta16Direction(placement.heading);
  const angle = Math.atan2(sin, cos) + frame.headingHalfSteps * HALF_STEP_RADIANS;
  return {
    x: (at.x * STUD_LDU + cos * frame.xLdu - sin * frame.zLdu) * SIXTEENTHS_PER_LDU,
    z: (at.z * STUD_LDU + sin * frame.xLdu + cos * frame.zLdu) * SIXTEENTHS_PER_LDU,
    cos: Math.cos(angle),
    sin: Math.sin(angle),
    exact: false,
  };
}

const NO_CELLS = new Int32Array(0);

export class TrackSupport {
  constructor(private readonly antiStuds: ReadonlyMap<number, Int32Array>) {}

  antiStudCells(catalogIndex: number, frame: TrackPartFrame, placement: Pose16): Int32Array {
    const origins = this.antiStuds.get(catalogIndex);
    const part = exactPartPose(frame, placement);
    if (!origins || !part) return NO_CELLS;
    const cells: number[] = [];
    for (let i = 0; i < origins.length; i += 2) {
      const ox = origins[i] ?? 0;
      const oz = origins[i + 1] ?? 0;
      const cellX = studCell(part.x + part.cos * ox - part.sin * oz);
      const cellZ = studCell(part.z + part.sin * ox + part.cos * oz);
      if (Number.isInteger(cellX) && Number.isInteger(cellZ)) cells.push(cellX, cellZ);
    }
    return Int32Array.from(cells);
  }

  supported(
    catalogIndex: number,
    frame: TrackPartFrame,
    placement: Pose16,
    seats: ReadonlySet<number>,
    studlessTops: TrackClearance,
    runFrame: PlacementFrame = WORLD_TRACK_FRAME,
    onTable = true,
  ): boolean {
    const origins = this.antiStuds.get(catalogIndex);
    if (!origins) return false;
    const part = framedPartPose(frame, placement, runFrame);
    for (let i = 0; i < origins.length; i += 2) {
      const ox = origins[i] ?? 0;
      const oz = origins[i + 1] ?? 0;
      const x = part.x + part.cos * ox - part.sin * oz;
      const z = part.z + part.sin * ox + part.cos * oz;
      if (part.exact && onStud(x, z, seats)) return true;
      if (
        onTable &&
        overBareGround(x / SIXTEENTHS_PER_LDU, z / SIXTEENTHS_PER_LDU, seats, studlessTops)
      ) {
        return true;
      }
    }
    return false;
  }
}

function studCell(sixteenths: number): number {
  return (sixteenths - STUD_CENTRE_SIXTEENTHS) / STUD_SIXTEENTHS;
}

function onStud(x: number, z: number, seats: ReadonlySet<number>): boolean {
  const cellX = studCell(x);
  const cellZ = studCell(z);
  return Number.isInteger(cellX) && Number.isInteger(cellZ) && seats.has(cellKey(cellX, cellZ));
}

function overBareGround(
  xLdu: number,
  zLdu: number,
  seats: ReadonlySet<number>,
  studlessTops: TrackClearance,
): boolean {
  if (studlessTops.covers(xLdu, zLdu)) return false;
  return !seats.has(cellKey(Math.floor(xLdu / STUD_LDU), Math.floor(zLdu / STUD_LDU)));
}
