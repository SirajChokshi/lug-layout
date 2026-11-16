import type { ISceneBackend, WorldBox } from "@brr/render";

const ORBIT_RADIANS_PER_PX = 0.005;
const PAN_FRACTION_PER_PX = 0.0015;
const ZOOM_PER_WHEEL_UNIT = 0.001;
const MIN_PITCH = 0.12;
const MAX_PITCH = 1.5;
const MIN_DISTANCE_LDU = 120;
const MAX_DISTANCE_LDU = 60_000;
const FOCUS_DISTANCE_FACTOR = 2.2;
const INITIAL_DISTANCE_LDU = 2_600;
const INITIAL_YAW = Math.PI / 4;
const INITIAL_PITCH = 0.75;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class OrbitCamera {
  private targetX = 0;
  private targetY = 0;
  private targetZ = 0;
  private distance = INITIAL_DISTANCE_LDU;
  private yaw = INITIAL_YAW;
  private pitch = INITIAL_PITCH;

  orbit(dxPx: number, dyPx: number): void {
    this.yaw += dxPx * ORBIT_RADIANS_PER_PX;
    this.pitch = clamp(this.pitch + dyPx * ORBIT_RADIANS_PER_PX, MIN_PITCH, MAX_PITCH);
  }

  pan(dxPx: number, dyPx: number): void {
    const step = this.distance * PAN_FRACTION_PER_PX;
    const forwardX = -Math.cos(this.yaw);
    const forwardZ = -Math.sin(this.yaw);
    const rightX = -forwardZ;
    const rightZ = forwardX;
    this.targetX += (-rightX * dxPx + forwardX * dyPx) * step;
    this.targetZ += (-rightZ * dxPx + forwardZ * dyPx) * step;
  }

  zoom(wheelDelta: number): void {
    this.distance = clamp(
      this.distance * Math.exp(wheelDelta * ZOOM_PER_WHEEL_UNIT),
      MIN_DISTANCE_LDU,
      MAX_DISTANCE_LDU,
    );
  }

  focus(box: WorldBox): void {
    this.targetX = (box.minX + box.maxX) / 2;
    this.targetY = (box.minY + box.maxY) / 2;
    this.targetZ = (box.minZ + box.maxZ) / 2;
    const extent = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
    this.distance = clamp(extent * FOCUS_DISTANCE_FACTOR, MIN_DISTANCE_LDU, MAX_DISTANCE_LDU);
  }

  centreOn(x: number, z: number): void {
    this.targetX = x;
    this.targetY = 0;
    this.targetZ = z;
  }

  apply(backend: ISceneBackend): void {
    const horizontal = this.distance * Math.cos(this.pitch);
    backend.setView(
      this.targetX + horizontal * Math.cos(this.yaw),
      this.targetY + this.distance * Math.sin(this.pitch),
      this.targetZ + horizontal * Math.sin(this.yaw),
      this.targetX,
      this.targetY,
      this.targetZ,
    );
  }
}
