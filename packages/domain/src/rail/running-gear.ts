export type CouplerMount = "body" | "frontBogie" | "rearBogie";

export interface GuideGeometry {
  readonly pivotXLdu: number;
  readonly pivotZLdu: number;
  readonly leadAxleXLdu: number;
  readonly trailAxleXLdu: number;
  readonly axleZLdu: number;
  readonly pivots: boolean;
}

export interface CouplerGeometry {
  readonly xLdu: number;
  readonly zLdu: number;
  readonly mount: CouplerMount;
}

export interface VehicleGeometry {
  readonly front: GuideGeometry;
  readonly rear: GuideGeometry;
  readonly frontCoupler: CouplerGeometry;
  readonly rearCoupler: CouplerGeometry;
}

export const VEHICLE_POSE_FLOATS = 9;

const G_PIVOT_X = 0;
const G_PIVOT_Z = 1;
const G_LEAD = 2;
const G_TRAIL = 3;
const G_AXLE_Z = 4;
const G_PIVOTS = 5;
const GUIDE_FIELDS = 6;
const C_X = 0;
const C_Z = 1;
const C_MOUNT = 2;
const COUPLER_FIELDS = 3;
const FRONT_GUIDE = 0;
const REAR_GUIDE = GUIDE_FIELDS;
const FRONT_COUPLER = 2 * GUIDE_FIELDS;
const REAR_COUPLER = FRONT_COUPLER + COUPLER_FIELDS;
const COUPLED = REAR_COUPLER + COUPLER_FIELDS;
export const GEOMETRY_FIELDS = COUPLED + 1;

const MOUNT_BODY = 0;
const MOUNT_FRONT = 1;
const MOUNT_REAR = 2;

function mountCode(mount: CouplerMount): number {
  switch (mount) {
    case "body":
      return MOUNT_BODY;
    case "frontBogie":
      return MOUNT_FRONT;
    case "rearBogie":
      return MOUNT_REAR;
    default: {
      const unhandled: never = mount;
      throw new Error(`unhandled coupler mount ${String(unhandled)}`);
    }
  }
}

function writeGuide(out: Float64Array, at: number, guide: GuideGeometry): void {
  out[at + G_PIVOT_X] = guide.pivotXLdu;
  out[at + G_PIVOT_Z] = guide.pivotZLdu;
  out[at + G_LEAD] = guide.leadAxleXLdu;
  out[at + G_TRAIL] = guide.trailAxleXLdu;
  out[at + G_AXLE_Z] = guide.axleZLdu;
  out[at + G_PIVOTS] = guide.pivots ? 1 : 0;
}

function writeCoupler(out: Float64Array, at: number, coupler: CouplerGeometry): void {
  out[at + C_X] = coupler.xLdu;
  out[at + C_Z] = coupler.zLdu;
  out[at + C_MOUNT] = mountCode(coupler.mount);
}

function packParts(
  geometry: VehicleGeometry,
  coupled: boolean,
  out: Float64Array,
  at: number,
): void {
  writeGuide(out, at + FRONT_GUIDE, geometry.front);
  writeGuide(out, at + REAR_GUIDE, geometry.rear);
  writeCoupler(out, at + FRONT_COUPLER, geometry.frontCoupler);
  writeCoupler(out, at + REAR_COUPLER, geometry.rearCoupler);
  out[at + COUPLED] = coupled ? 1 : 0;
}

export function packGeometry(geometry: VehicleGeometry, out: Float64Array, at: number): void {
  packParts(geometry, true, out, at);
}

function fixedAt(x: number): GuideGeometry {
  return {
    pivotXLdu: x,
    pivotZLdu: 0,
    leadAxleXLdu: x,
    trailAxleXLdu: x,
    axleZLdu: 0,
    pivots: false,
  };
}

export function packSpecOnlyGeometry(
  lengthLdu: number,
  frontBogieLdu: number,
  rearBogieLdu: number,
  out: Float64Array,
  at: number,
): void {
  packParts(
    {
      front: fixedAt(-frontBogieLdu),
      rear: fixedAt(-rearBogieLdu),
      frontCoupler: { xLdu: 0, zLdu: 0, mount: "body" },
      rearCoupler: { xLdu: -lengthLdu, zLdu: 0, mount: "body" },
    },
    false,
    out,
    at,
  );
}

export interface PathSampler {
  pointBehind(io: Float64Array, at: number): void;
}

const P_LEAD = 0;
const P_TRAIL = 2;
const P_FRONT_PIVOT = 4;
const P_REAR_PIVOT = 6;
const P_BODY = 8;
const P_FRONT_BOGIE_YAW = 10;
const P_REAR_BOGIE_YAW = 11;
const P_BODY_YAW = 12;
const P_FRONT_COUPLER = 13;
const P_REAR_COUPLER = 15;
const P_FRONT_COUPLER_YAW = 17;
const P_REAR_COUPLER_YAW = 18;
const POSE_SCRATCH = 19;
const NEWTON_ITERATIONS = 12;
const NEWTON_TOLERANCE_LDU = 1e-10;
const CHORD_SLOPE_FACTOR = 3;
const HALF = 0.5;
export const PIVOT_POINT_FLOATS = 4;

export class RunningGearPoser {
  private readonly geometry = new Float64Array(GEOMETRY_FIELDS);
  private readonly scratch = new Float64Array(POSE_SCRATCH);
  private readonly halfRatio = Float64Array.of(HALF, HALF);
  private readonly ahead = new Float64Array(3);
  private aheadCoupled = false;
  private frontCouplerDistance = 0;
  private guideSpread = 0;

  load(source: Float64Array, at: number, mirrored: boolean): void {
    const g = this.geometry;
    const sign = mirrored ? -1 : 1;
    for (let side = 0; side < 2; side++) {
      const from = at + (mirrored ? 1 - side : side) * GUIDE_FIELDS;
      const to = side * GUIDE_FIELDS;
      g[to + G_PIVOT_X] = sign * (source[from + G_PIVOT_X] ?? 0);
      g[to + G_PIVOT_Z] = sign * (source[from + G_PIVOT_Z] ?? 0);
      g[to + G_LEAD] = sign * (source[from + (mirrored ? G_TRAIL : G_LEAD)] ?? 0);
      g[to + G_TRAIL] = sign * (source[from + (mirrored ? G_LEAD : G_TRAIL)] ?? 0);
      g[to + G_AXLE_Z] = sign * (source[from + G_AXLE_Z] ?? 0);
      g[to + G_PIVOTS] = source[from + G_PIVOTS] ?? 0;
    }
    for (let end = 0; end < 2; end++) {
      const from = at + FRONT_COUPLER + (mirrored ? 1 - end : end) * COUPLER_FIELDS;
      const to = FRONT_COUPLER + end * COUPLER_FIELDS;
      const mount = source[from + C_MOUNT] ?? MOUNT_BODY;
      g[to + C_X] = sign * (source[from + C_X] ?? 0);
      g[to + C_Z] = sign * (source[from + C_Z] ?? 0);
      g[to + C_MOUNT] = mirrored && mount !== MOUNT_BODY ? MOUNT_FRONT + MOUNT_REAR - mount : mount;
    }
    g[COUPLED] = source[at + COUPLED] ?? 0;
  }

  writeTrain(
    path: PathSampler,
    source: Float64Array,
    geometryAt: Int32Array,
    first: number,
    count: number,
    mirrored: boolean,
    pivots: Float64Array | null,
    pivotStart: number,
    poses: Float64Array | null,
    poseStart: number,
    lengths: Float64Array,
    lengthAt: number,
  ): void {
    const g = this.geometry;
    this.frontCouplerDistance = 0;
    for (let k = 0; k < count; k++) {
      const v = mirrored ? first + count - 1 - k : first + k;
      this.load(source, geometryAt[v] ?? 0, mirrored);
      const coupled = (g[COUPLED] ?? 0) === 1;
      if (k > 0 && coupled && this.aheadCoupled) this.coupleBehind(path);
      else this.pose(path);
      this.emit(v, mirrored, pivots, pivotStart, poses, poseStart);
      const s = this.scratch;
      this.ahead[0] = s[P_REAR_COUPLER] ?? 0;
      this.ahead[1] = s[P_REAR_COUPLER + 1] ?? 0;
      this.ahead[2] = s[P_REAR_COUPLER_YAW] ?? 0;
      this.aheadCoupled = coupled;
      this.frontCouplerDistance += (g[FRONT_COUPLER + C_X] ?? 0) - (g[REAR_COUPLER + C_X] ?? 0);
    }
    lengths[lengthAt] = this.frontCouplerDistance;
  }

  private emit(
    v: number,
    mirrored: boolean,
    pivots: Float64Array | null,
    pivotStart: number,
    poses: Float64Array | null,
    poseStart: number,
  ): void {
    const s = this.scratch;
    const ownFront = mirrored ? P_REAR_PIVOT : P_FRONT_PIVOT;
    const ownRear = mirrored ? P_FRONT_PIVOT : P_REAR_PIVOT;
    if (pivots) {
      const o = pivotStart + v * PIVOT_POINT_FLOATS;
      pivots[o] = s[ownFront] ?? 0;
      pivots[o + 1] = s[ownFront + 1] ?? 0;
      pivots[o + 2] = s[ownRear] ?? 0;
      pivots[o + 3] = s[ownRear + 1] ?? 0;
    }
    if (!poses) return;
    const o = poseStart + v * VEHICLE_POSE_FLOATS;
    const turn = mirrored ? Math.PI : 0;
    const ownFrontYaw = mirrored ? P_REAR_BOGIE_YAW : P_FRONT_BOGIE_YAW;
    const ownRearYaw = mirrored ? P_FRONT_BOGIE_YAW : P_REAR_BOGIE_YAW;
    poses[o] = s[P_BODY] ?? 0;
    poses[o + 1] = s[P_BODY + 1] ?? 0;
    poses[o + 2] = (s[P_BODY_YAW] ?? 0) + turn;
    poses[o + 3] = s[ownFront] ?? 0;
    poses[o + 4] = s[ownFront + 1] ?? 0;
    poses[o + 5] = (s[ownFrontYaw] ?? 0) + turn;
    poses[o + 6] = s[ownRear] ?? 0;
    poses[o + 7] = s[ownRear + 1] ?? 0;
    poses[o + 8] = (s[ownRearYaw] ?? 0) + turn;
  }

  private coupleBehind(path: PathSampler): void {
    const s = this.scratch;
    const ahead = this.ahead;
    const nominal = this.frontCouplerDistance;
    let shift = 0;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      this.frontCouplerDistance = nominal + shift;
      this.pose(path);
      const frontYaw = s[P_FRONT_COUPLER_YAW] ?? 0;
      const rearYaw = ahead[2] ?? 0;
      const nx = Math.cos(frontYaw) - Math.cos(rearYaw);
      const nz = Math.sin(frontYaw) - Math.sin(rearYaw);
      const gap =
        (((ahead[0] ?? 0) - (s[P_FRONT_COUPLER] ?? 0)) * nx +
          ((ahead[1] ?? 0) - (s[P_FRONT_COUPLER + 1] ?? 0)) * nz) /
        Math.sqrt(nx * nx + nz * nz);
      if (Math.abs(gap) < NEWTON_TOLERANCE_LDU) return;
      shift -= gap;
    }
    this.frontCouplerDistance = nominal + shift;
    this.pose(path);
  }

  private pose(path: PathSampler): void {
    const g = this.geometry;
    const s = this.scratch;
    this.guideSpread = 0;
    if ((g[COUPLED] ?? 0) === 1) this.spreadGuides(path);
    else {
      this.guide(path, FRONT_GUIDE, 0, P_FRONT_PIVOT, P_FRONT_BOGIE_YAW);
      this.guide(path, REAR_GUIDE, 0, P_REAR_PIVOT, P_REAR_BOGIE_YAW);
    }
    const fx = s[P_FRONT_PIVOT] ?? 0;
    const fz = s[P_FRONT_PIVOT + 1] ?? 0;
    const rx = s[P_REAR_PIVOT] ?? 0;
    const rz = s[P_REAR_PIVOT + 1] ?? 0;
    const yaw = Math.atan2(fz - rz, fx - rx);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const midX = ((g[FRONT_GUIDE + G_PIVOT_X] ?? 0) + (g[REAR_GUIDE + G_PIVOT_X] ?? 0)) / 2;
    const midZ = ((g[FRONT_GUIDE + G_PIVOT_Z] ?? 0) + (g[REAR_GUIDE + G_PIVOT_Z] ?? 0)) / 2;
    s[P_BODY_YAW] = yaw;
    s[P_BODY] = (fx + rx) / 2 - (midX * cos - midZ * sin);
    s[P_BODY + 1] = (fz + rz) / 2 - (midX * sin + midZ * cos);
    if ((g[FRONT_GUIDE + G_PIVOTS] ?? 0) === 0) s[P_FRONT_BOGIE_YAW] = yaw;
    if ((g[REAR_GUIDE + G_PIVOTS] ?? 0) === 0) s[P_REAR_BOGIE_YAW] = yaw;
    this.coupler(FRONT_COUPLER, P_FRONT_COUPLER, P_FRONT_COUPLER_YAW, 0);
    this.coupler(REAR_COUPLER, P_REAR_COUPLER, P_REAR_COUPLER_YAW, Math.PI);
  }

  private spreadGuides(path: PathSampler): void {
    const g = this.geometry;
    const s = this.scratch;
    const spanX = (g[FRONT_GUIDE + G_PIVOT_X] ?? 0) - (g[REAR_GUIDE + G_PIVOT_X] ?? 0);
    const spanZ = (g[FRONT_GUIDE + G_PIVOT_Z] ?? 0) - (g[REAR_GUIDE + G_PIVOT_Z] ?? 0);
    const spacing = Math.sqrt(spanX * spanX + spanZ * spanZ);
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      this.guide(path, FRONT_GUIDE, -0.5, P_FRONT_PIVOT, P_FRONT_BOGIE_YAW);
      this.guide(path, REAR_GUIDE, 0.5, P_REAR_PIVOT, P_REAR_BOGIE_YAW);
      const apartX = (s[P_FRONT_PIVOT] ?? 0) - (s[P_REAR_PIVOT] ?? 0);
      const apartZ = (s[P_FRONT_PIVOT + 1] ?? 0) - (s[P_REAR_PIVOT + 1] ?? 0);
      const error = Math.sqrt(apartX * apartX + apartZ * apartZ) - spacing;
      if (Math.abs(error) < NEWTON_TOLERANCE_LDU) return;
      this.guideSpread -= error;
    }
    this.guide(path, FRONT_GUIDE, -0.5, P_FRONT_PIVOT, P_FRONT_BOGIE_YAW);
    this.guide(path, REAR_GUIDE, 0.5, P_REAR_PIVOT, P_REAR_BOGIE_YAW);
  }

  private guide(
    path: PathSampler,
    at: number,
    spread: number,
    pivotOut: number,
    yawOut: number,
  ): void {
    const g = this.geometry;
    const s = this.scratch;
    const pivotX = g[at + G_PIVOT_X] ?? 0;
    const pivotZ = g[at + G_PIVOT_Z] ?? 0;
    const front = this.frontCouplerDistance + (g[FRONT_COUPLER + C_X] ?? 0);
    const spreadShift = spread * this.guideSpread;
    if ((g[at + G_PIVOTS] ?? 0) === 0) {
      s[pivotOut] = front - pivotX + spreadShift;
      path.pointBehind(s, pivotOut);
      return;
    }
    const lead = g[at + G_LEAD] ?? 0;
    const trail = g[at + G_TRAIL] ?? 0;
    this.axlesAbout(
      path,
      front - (lead + trail) / 2 + spreadShift,
      lead - trail,
      at === FRONT_GUIDE ? 0 : 1,
    );
    const ax = s[P_LEAD] ?? 0;
    const az = s[P_LEAD + 1] ?? 0;
    const bx = s[P_TRAIL] ?? 0;
    const bz = s[P_TRAIL + 1] ?? 0;
    const yaw = Math.atan2(az - bz, ax - bx);
    const u = pivotX - (lead + trail) / 2;
    const w = pivotZ - (g[at + G_AXLE_Z] ?? 0);
    s[yawOut] = yaw;
    s[pivotOut] = (ax + bx) / 2 + u * Math.cos(yaw) - w * Math.sin(yaw);
    s[pivotOut + 1] = (az + bz) / 2 + u * Math.sin(yaw) + w * Math.cos(yaw);
  }

  private axlesAbout(path: PathSampler, middle: number, spacing: number, side: number): void {
    const s = this.scratch;
    let half = spacing * (this.halfRatio[side] ?? HALF);
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      s[P_LEAD] = middle - half;
      path.pointBehind(s, P_LEAD);
      s[P_TRAIL] = middle + half;
      path.pointBehind(s, P_TRAIL);
      const dx = (s[P_LEAD] ?? 0) - (s[P_TRAIL] ?? 0);
      const dz = (s[P_LEAD + 1] ?? 0) - (s[P_TRAIL + 1] ?? 0);
      const chord = Math.sqrt(dx * dx + dz * dz);
      const error = spacing - chord;
      if (Math.abs(error) < NEWTON_TOLERANCE_LDU) {
        if (spacing > 0) this.halfRatio[side] = half / spacing;
        return;
      }
      const arc = 2 * half;
      half += error / (2 * (1 - (CHORD_SLOPE_FACTOR * (arc - chord)) / arc));
    }
  }

  private coupler(at: number, out: number, yawOut: number, facing: number): void {
    const g = this.geometry;
    const s = this.scratch;
    const x = g[at + C_X] ?? 0;
    const z = g[at + C_Z] ?? 0;
    const mount = g[at + C_MOUNT] ?? MOUNT_BODY;
    if (mount === MOUNT_BODY) {
      const yaw = s[P_BODY_YAW] ?? 0;
      s[out] = (s[P_BODY] ?? 0) + x * Math.cos(yaw) - z * Math.sin(yaw);
      s[out + 1] = (s[P_BODY + 1] ?? 0) + x * Math.sin(yaw) + z * Math.cos(yaw);
      s[yawOut] = yaw + facing;
      return;
    }
    const guide = mount === MOUNT_FRONT ? FRONT_GUIDE : REAR_GUIDE;
    const pivot = mount === MOUNT_FRONT ? P_FRONT_PIVOT : P_REAR_PIVOT;
    const yaw = s[mount === MOUNT_FRONT ? P_FRONT_BOGIE_YAW : P_REAR_BOGIE_YAW] ?? 0;
    const u = x - (g[guide + G_PIVOT_X] ?? 0);
    const w = z - (g[guide + G_PIVOT_Z] ?? 0);
    s[out] = (s[pivot] ?? 0) + u * Math.cos(yaw) - w * Math.sin(yaw);
    s[out + 1] = (s[pivot + 1] ?? 0) + u * Math.sin(yaw) + w * Math.cos(yaw);
    s[yawOut] = yaw + facing;
  }
}
