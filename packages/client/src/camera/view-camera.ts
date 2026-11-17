import { CAMERA_FOV_DEGREES, type ISceneBackend, type WorldBox } from "@brr/render";

export type ViewMode = "orbit" | "plan";

const TAN_HALF_FOV = Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360);
const ORBIT_RADIANS_PER_PX = 0.005;
const MIN_PITCH = 0.12;
const MAX_ORBIT_PITCH = 1.5;
const PLAN_PITCH = Math.PI / 2 - 1e-6;
const PLAN_YAW = Math.PI / 2;
const MIN_DISTANCE_LDU = 60;
const MAX_DISTANCE_LDU = 250_000;
const PLAN_EYE_HEIGHT_LDU = 40_000;
const INITIAL_DISTANCE_LDU = 2_600;
const INITIAL_YAW = Math.PI / 4;
const INITIAL_PITCH = 0.75;
const FRAME_MARGIN = 1.12;
const TWEEN_MS = 420;
const ZOOM_GLIDE_TIME_CONSTANT_MS = 70;
const ZOOM_GLIDE_DONE = 1e-4;
const MAX_FRAME_STEP_MS = 100;
const GRAZING_RAY_Y = -1e-3;
const MAX_GRAB_DISTANCE_FACTOR = 12;
const FULL_TURN = Math.PI * 2;
export const GROUND_Y_LDU = 0;
const MIN_SAFE_SHARE = 0.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function shortestTurn(from: number, to: number): number {
  const turn = (to - from) % FULL_TURN;
  if (turn > Math.PI) return turn - FULL_TURN;
  if (turn < -Math.PI) return turn + FULL_TURN;
  return turn;
}

class Pose {
  targetX = 0;
  targetY = 0;
  targetZ = 0;
  distance = INITIAL_DISTANCE_LDU;
  yaw = INITIAL_YAW;
  pitch = INITIAL_PITCH;

  copy(other: Pose): void {
    this.targetX = other.targetX;
    this.targetY = other.targetY;
    this.targetZ = other.targetZ;
    this.distance = other.distance;
    this.yaw = other.yaw;
    this.pitch = other.pitch;
  }
}

export class ViewCamera {
  private readonly pose = new Pose();
  private readonly from = new Pose();
  private readonly to = new Pose();
  private readonly orbitAngles = new Pose();
  private mode: ViewMode = "orbit";
  private orthographic = false;
  private tweening = false;
  private tweenStartMs = Number.NaN;
  private lastStepMs = Number.NaN;
  private glideLog = 0;
  private glideX = 0;
  private glideY = 0;
  private glideZ = 0;
  private widthPx = 1;
  private heightPx = 1;
  private safeLeftPx = 0;
  private safeTopPx = 0;
  private safeRightPx = 0;
  private safeBottomPx = 0;
  private readonly ray = new Float64Array(6);
  private readonly hit = new Float64Array(2);
  private readonly grabbed = new Float64Array(2);

  targetX(): number {
    return this.pose.targetX;
  }

  targetZ(): number {
    return this.pose.targetZ;
  }

  resize(widthPx: number, heightPx: number): void {
    this.widthPx = Math.max(widthPx, 1);
    this.heightPx = Math.max(heightPx, 1);
  }

  setSafeArea(leftPx: number, topPx: number, rightPx: number, bottomPx: number): void {
    this.safeLeftPx = Math.max(leftPx, 0);
    this.safeTopPx = Math.max(topPx, 0);
    this.safeRightPx = Math.max(rightPx, 0);
    this.safeBottomPx = Math.max(bottomPx, 0);
  }

  private get safeWidthShare(): number {
    return clamp(1 - (this.safeLeftPx + this.safeRightPx) / this.widthPx, MIN_SAFE_SHARE, 1);
  }

  private get safeHeightShare(): number {
    return clamp(1 - (this.safeTopPx + this.safeBottomPx) / this.heightPx, MIN_SAFE_SHARE, 1);
  }

  private get aspect(): number {
    return this.widthPx / this.heightPx;
  }

  private get halfHeight(): number {
    return this.pose.distance * TAN_HALF_FOV;
  }

  orbit(dxPx: number, dyPx: number): void {
    if (this.mode === "plan") return;
    this.settle();
    this.pose.yaw += dxPx * ORBIT_RADIANS_PER_PX;
    this.pose.pitch = clamp(
      this.pose.pitch + dyPx * ORBIT_RADIANS_PER_PX,
      MIN_PITCH,
      MAX_ORBIT_PITCH,
    );
  }

  grabPan(fromNdcX: number, fromNdcY: number, toNdcX: number, toNdcY: number): void {
    this.settle();
    if (
      this.groundHit(fromNdcX, fromNdcY, this.grabbed) &&
      this.groundHit(toNdcX, toNdcY, this.hit)
    ) {
      this.pose.targetX += (this.grabbed[0] ?? 0) - (this.hit[0] ?? 0);
      this.pose.targetZ += (this.grabbed[1] ?? 0) - (this.hit[1] ?? 0);
      return;
    }
    this.scrollPan(
      ((fromNdcX - toNdcX) * this.widthPx) / 2,
      ((toNdcY - fromNdcY) * this.heightPx) / 2,
    );
  }

  scrollPan(dxPx: number, dyPx: number): void {
    this.settle();
    const lduPerPx = (2 * this.halfHeight) / this.heightPx;
    const along = lduPerPx / Math.max(Math.sin(this.pose.pitch), Math.sin(MIN_PITCH));
    const sinYaw = Math.sin(this.pose.yaw);
    const cosYaw = Math.cos(this.pose.yaw);
    this.pose.targetX += sinYaw * dxPx * lduPerPx + cosYaw * dyPx * along;
    this.pose.targetZ += -cosYaw * dxPx * lduPerPx + sinYaw * dyPx * along;
  }

  zoomAt(ndcX: number, ndcY: number, logScale: number): void {
    this.settle();
    this.glideLog = 0;
    if (this.groundHit(ndcX, ndcY, this.hit)) {
      this.zoomAbout(this.hit[0] ?? 0, GROUND_Y_LDU, this.hit[1] ?? 0, logScale);
    } else {
      this.zoomAbout(this.pose.targetX, this.pose.targetY, this.pose.targetZ, logScale);
    }
  }

  glideZoomAtSafeCentre(logScale: number): void {
    this.glideZoomAt(
      (this.safeLeftPx - this.safeRightPx) / this.widthPx,
      (this.safeBottomPx - this.safeTopPx) / this.heightPx,
      logScale,
    );
  }

  glideZoomAt(ndcX: number, ndcY: number, logScale: number): void {
    this.settle();
    if (this.groundHit(ndcX, ndcY, this.hit)) {
      this.glideX = this.hit[0] ?? 0;
      this.glideY = GROUND_Y_LDU;
      this.glideZ = this.hit[1] ?? 0;
    } else {
      this.glideX = this.pose.targetX;
      this.glideY = this.pose.targetY;
      this.glideZ = this.pose.targetZ;
    }
    this.glideLog += logScale;
  }

  private zoomAbout(anchorX: number, anchorY: number, anchorZ: number, logScale: number): boolean {
    const before = this.pose.distance;
    const after = clamp(before * Math.exp(logScale), MIN_DISTANCE_LDU, MAX_DISTANCE_LDU);
    const scale = after / before;
    this.pose.distance = after;
    this.pose.targetX = anchorX + (this.pose.targetX - anchorX) * scale;
    this.pose.targetY = anchorY + (this.pose.targetY - anchorY) * scale;
    this.pose.targetZ = anchorZ + (this.pose.targetZ - anchorZ) * scale;
    return after !== before;
  }

  jumpTo(x: number, z: number): void {
    this.settle();
    this.glideLog = 0;
    this.pose.targetX = x;
    this.pose.targetY = GROUND_Y_LDU;
    this.pose.targetZ = z;
  }

  frame(box: WorldBox): void {
    if (!this.tweening) this.to.copy(this.pose);
    this.framePose(box, this.mode, this.to);
    this.startTween();
  }

  centreOn(x: number, z: number): void {
    if (!this.tweening) this.to.copy(this.pose);
    this.to.targetX = x;
    this.to.targetY = GROUND_Y_LDU;
    this.to.targetZ = z;
    this.offsetToSafeCentre(this.to);
    this.startTween();
  }

  setMode(mode: ViewMode, box: WorldBox | null = null): void {
    if (mode === this.mode && box === null) return;
    if (!this.tweening) this.to.copy(this.pose);
    if (mode === "plan") {
      if (this.mode === "orbit") this.orbitAngles.copy(this.to);
      this.to.yaw = PLAN_YAW;
      this.to.pitch = PLAN_PITCH;
      this.to.targetY = 0;
    } else {
      this.orthographic = false;
      this.to.yaw = this.orbitAngles.yaw;
      this.to.pitch = this.orbitAngles.pitch;
    }
    this.mode = mode;
    if (box) this.framePose(box, mode, this.to);
    this.startTween();
  }

  private framePose(box: WorldBox, mode: ViewMode, out: Pose): void {
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    const depth = box.maxZ - box.minZ;
    out.targetX = (box.minX + box.maxX) / 2;
    out.targetZ = (box.minZ + box.maxZ) / 2;
    if (mode === "plan") {
      out.targetY = 0;
      const halfHeight =
        Math.max(depth / 2 / this.safeHeightShare, width / 2 / this.aspect / this.safeWidthShare) *
        FRAME_MARGIN;
      out.distance = clamp(halfHeight / TAN_HALF_FOV, MIN_DISTANCE_LDU, MAX_DISTANCE_LDU);
    } else {
      out.targetY = (box.minY + box.maxY) / 2;
      const radius = Math.hypot(width, height, depth) / 2;
      const halfFov = Math.atan(
        Math.min(
          TAN_HALF_FOV * this.safeHeightShare,
          TAN_HALF_FOV * this.aspect * this.safeWidthShare,
        ),
      );
      out.distance = clamp(
        (radius / Math.sin(halfFov)) * FRAME_MARGIN,
        MIN_DISTANCE_LDU,
        MAX_DISTANCE_LDU,
      );
    }
    this.offsetToSafeCentre(out);
  }

  private offsetToSafeCentre(out: Pose): void {
    const lduPerPx = (2 * out.distance * TAN_HALF_FOV) / this.heightPx;
    const rightPx = ((this.safeLeftPx - this.safeRightPx) / 2) * lduPerPx;
    const downPx = ((this.safeTopPx - this.safeBottomPx) / 2) * lduPerPx;
    const sinPitch = Math.sin(out.pitch);
    const cosYaw = Math.cos(out.yaw);
    const sinYaw = Math.sin(out.yaw);
    out.targetX -= sinYaw * rightPx + sinPitch * cosYaw * downPx;
    out.targetY -= -Math.cos(out.pitch) * downPx;
    out.targetZ -= -cosYaw * rightPx + sinPitch * sinYaw * downPx;
  }

  private startTween(): void {
    this.glideLog = 0;
    this.from.copy(this.pose);
    this.to.yaw = this.from.yaw + shortestTurn(this.from.yaw, this.to.yaw);
    this.tweening = true;
    this.tweenStartMs = Number.NaN;
  }

  private settle(): void {
    if (!this.tweening) return;
    this.tweening = false;
    if (this.mode === "plan") {
      this.pose.yaw = this.to.yaw;
      this.pose.pitch = this.to.pitch;
      this.orthographic = true;
    }
  }

  step(nowMs: number): void {
    const dt = Number.isNaN(this.lastStepMs)
      ? 0
      : clamp(nowMs - this.lastStepMs, 0, MAX_FRAME_STEP_MS);
    this.lastStepMs = nowMs;
    if (this.tweening) this.stepTween(nowMs);
    if (this.glideLog !== 0) this.stepGlide(dt);
  }

  private stepTween(nowMs: number): void {
    if (Number.isNaN(this.tweenStartMs)) this.tweenStartMs = nowMs;
    const t = clamp((nowMs - this.tweenStartMs) / TWEEN_MS, 0, 1);
    const k = easeInOutCubic(t);
    const { from, to, pose } = this;
    pose.targetX = from.targetX + (to.targetX - from.targetX) * k;
    pose.targetY = from.targetY + (to.targetY - from.targetY) * k;
    pose.targetZ = from.targetZ + (to.targetZ - from.targetZ) * k;
    pose.distance = from.distance * (to.distance / from.distance) ** k;
    pose.yaw = from.yaw + (to.yaw - from.yaw) * k;
    pose.pitch = from.pitch + (to.pitch - from.pitch) * k;
    if (t < 1) return;
    this.tweening = false;
    pose.copy(to);
    if (this.mode === "plan") this.orthographic = true;
  }

  private stepGlide(dtMs: number): void {
    const share = 1 - Math.exp(-dtMs / ZOOM_GLIDE_TIME_CONSTANT_MS);
    let part = this.glideLog * share;
    if (Math.abs(this.glideLog - part) < ZOOM_GLIDE_DONE) part = this.glideLog;
    const moved = this.zoomAbout(this.glideX, this.glideY, this.glideZ, part);
    this.glideLog = moved ? this.glideLog - part : 0;
  }

  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    const { pose } = this;
    const cosPitch = Math.cos(pose.pitch);
    const sinPitch = Math.sin(pose.pitch);
    const cosYaw = Math.cos(pose.yaw);
    const sinYaw = Math.sin(pose.yaw);
    const forwardX = -cosPitch * cosYaw;
    const forwardY = -sinPitch;
    const forwardZ = -cosPitch * sinYaw;
    const rightX = sinYaw;
    const rightZ = -cosYaw;
    const upX = -sinPitch * cosYaw;
    const upY = cosPitch;
    const upZ = -sinPitch * sinYaw;
    const eyeDistance = this.eyeDistance();
    const eyeX = pose.targetX - forwardX * eyeDistance;
    const eyeY = pose.targetY - forwardY * eyeDistance;
    const eyeZ = pose.targetZ - forwardZ * eyeDistance;
    if (this.orthographic) {
      const across = ndcX * this.halfHeight * this.aspect;
      const along = ndcY * this.halfHeight;
      out[0] = eyeX + rightX * across + upX * along;
      out[1] = eyeY + upY * along;
      out[2] = eyeZ + rightZ * across + upZ * along;
      out[3] = forwardX;
      out[4] = forwardY;
      out[5] = forwardZ;
      return;
    }
    const across = ndcX * TAN_HALF_FOV * this.aspect;
    const along = ndcY * TAN_HALF_FOV;
    const dirX = forwardX + rightX * across + upX * along;
    const dirY = forwardY + upY * along;
    const dirZ = forwardZ + rightZ * across + upZ * along;
    const length = Math.hypot(dirX, dirY, dirZ);
    out[0] = eyeX;
    out[1] = eyeY;
    out[2] = eyeZ;
    out[3] = dirX / length;
    out[4] = dirY / length;
    out[5] = dirZ / length;
  }

  groundHit(ndcX: number, ndcY: number, out: Float64Array): boolean {
    const ray = this.ray;
    this.rayThrough(ndcX, ndcY, ray);
    const dirY = ray[4] ?? 0;
    if (dirY > GRAZING_RAY_Y) return false;
    const t = (GROUND_Y_LDU - (ray[1] ?? 0)) / dirY;
    if (!this.orthographic && t > this.pose.distance * MAX_GRAB_DISTANCE_FACTOR) return false;
    out[0] = (ray[0] ?? 0) + (ray[3] ?? 0) * t;
    out[1] = (ray[2] ?? 0) + (ray[5] ?? 0) * t;
    return true;
  }

  private eyeDistance(): number {
    return this.orthographic ? PLAN_EYE_HEIGHT_LDU : this.pose.distance;
  }

  apply(backend: ISceneBackend): void {
    const { pose } = this;
    const eyeDistance = this.eyeDistance();
    const horizontal = eyeDistance * Math.cos(pose.pitch);
    const eyeX = pose.targetX + horizontal * Math.cos(pose.yaw);
    const eyeY = pose.targetY + eyeDistance * Math.sin(pose.pitch);
    const eyeZ = pose.targetZ + horizontal * Math.sin(pose.yaw);
    if (this.orthographic) {
      backend.setView(eyeX, eyeY, eyeZ, pose.targetX, pose.targetY, pose.targetZ, this.halfHeight);
      return;
    }
    backend.setView(eyeX, eyeY, eyeZ, pose.targetX, pose.targetY, pose.targetZ);
  }
}
