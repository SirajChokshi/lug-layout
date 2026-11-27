import {
  ArrayCamera,
  Matrix4,
  Sphere,
  Vector4,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type Camera,
  type CoordinateSystem,
} from "three/webgpu";
import { MATRIX4_FLOATS } from "./instance-page.ts";

const RIGHT_PLANE = 0;
const LEFT_PLANE = 1;
const BOTTOM_PLANE = 2;
const TOP_PLANE = 3;
const FAR_PLANE = 4;
const NEAR_PLANE = 5;
const FRUSTUM_PLANES = 6;
const PLANE_FLOATS = 4;

export class ProjectedOpaqueOrder {
  private clipZ = new Float64Array(0);
  private visible = new Uint32Array(0);
  private scratch = new Uint32Array(0);
  private readonly projScreen = new Matrix4();
  private readonly planes = new Float64Array(FRUSTUM_PLANES * PLANE_FLOATS);
  private readonly world = new Matrix4();
  private readonly bounds = new Sphere();
  private readonly clip = new Vector4();

  get visibleItems(): Uint32Array {
    return this.visible;
  }

  reserve(items: number): void {
    if (items <= this.visible.length) return;
    this.clipZ = new Float64Array(items);
    this.visible = new Uint32Array(items);
    this.scratch = new Uint32Array(items);
  }

  project(
    camera: Camera,
    worlds: Float64Array,
    partSpheres: readonly [Sphere, ...Sphere[]],
    items: number,
  ): number {
    if (camera.reversedDepth || camera instanceof ArrayCamera) {
      throw new Error("reversed depth and array cameras aren't reproduced");
    }
    this.reserve(items);
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.setPlanes(camera.coordinateSystem);
    const parts = partSpheres.length;
    let visibleCount = 0;
    for (let first = 0; first < items; first += parts) {
      this.world.fromArray(worlds, (first / parts) * MATRIX4_FLOATS);
      for (let item = first; item < Math.min(first + parts, items); item++) {
        const part = partSpheres[item - first];
        if (!part || !this.inFrustum(this.bounds.copy(part).applyMatrix4(this.world))) continue;
        const centre = part.center;
        this.clipZ[item] = this.clip
          .set(centre.x, centre.y, centre.z, 1)
          .applyMatrix4(this.world)
          .applyMatrix4(this.projScreen).z;
        this.visible[visibleCount++] = item;
      }
    }
    this.sortVisible(visibleCount);
    return visibleCount;
  }

  private setPlanes(coordinateSystem: CoordinateSystem): void {
    const me = this.projScreen.elements;
    const me0 = me[0] ?? 0;
    const me1 = me[1] ?? 0;
    const me2 = me[2] ?? 0;
    const me3 = me[3] ?? 0;
    const me4 = me[4] ?? 0;
    const me5 = me[5] ?? 0;
    const me6 = me[6] ?? 0;
    const me7 = me[7] ?? 0;
    const me8 = me[8] ?? 0;
    const me9 = me[9] ?? 0;
    const me10 = me[10] ?? 0;
    const me11 = me[11] ?? 0;
    const me12 = me[12] ?? 0;
    const me13 = me[13] ?? 0;
    const me14 = me[14] ?? 0;
    const me15 = me[15] ?? 0;
    this.setPlane(RIGHT_PLANE, me3 - me0, me7 - me4, me11 - me8, me15 - me12);
    this.setPlane(LEFT_PLANE, me3 + me0, me7 + me4, me11 + me8, me15 + me12);
    this.setPlane(BOTTOM_PLANE, me3 + me1, me7 + me5, me11 + me9, me15 + me13);
    this.setPlane(TOP_PLANE, me3 - me1, me7 - me5, me11 - me9, me15 - me13);
    this.setPlane(FAR_PLANE, me3 - me2, me7 - me6, me11 - me10, me15 - me14);
    if (coordinateSystem === WebGLCoordinateSystem) {
      this.setPlane(NEAR_PLANE, me3 + me2, me7 + me6, me11 + me10, me15 + me14);
    } else if (coordinateSystem === WebGPUCoordinateSystem) {
      this.setPlane(NEAR_PLANE, me2, me6, me10, me14);
    } else {
      throw new Error(`unknown coordinate system ${String(coordinateSystem)}`);
    }
  }

  private setPlane(index: number, x: number, y: number, z: number, w: number): void {
    const inverseNormalLength = 1.0 / Math.sqrt(x * x + y * y + z * z);
    const o = index * PLANE_FLOATS;
    this.planes[o] = x * inverseNormalLength;
    this.planes[o + 1] = y * inverseNormalLength;
    this.planes[o + 2] = z * inverseNormalLength;
    this.planes[o + 3] = w * inverseNormalLength;
  }

  private inFrustum(sphere: Sphere): boolean {
    const centre = sphere.center;
    const negRadius = -sphere.radius;
    for (let plane = 0; plane < FRUSTUM_PLANES; plane++) {
      const o = plane * PLANE_FLOATS;
      const distance =
        (this.planes[o] ?? 0) * centre.x +
        (this.planes[o + 1] ?? 0) * centre.y +
        (this.planes[o + 2] ?? 0) * centre.z +
        (this.planes[o + 3] ?? 0);
      if (distance < negRadius) return false;
    }
    return true;
  }

  private sortVisible(count: number): void {
    let from = this.visible;
    let to = this.scratch;
    for (let width = 1; width < count; width *= 2) {
      for (let start = 0; start < count; start += 2 * width) {
        const middle = Math.min(start + width, count);
        const end = Math.min(start + 2 * width, count);
        let left = start;
        let right = middle;
        for (let k = start; k < end; k++) {
          const rightFirst =
            right < end &&
            (left >= middle ||
              (this.clipZ[from[right] ?? 0] ?? 0) < (this.clipZ[from[left] ?? 0] ?? 0));
          to[k] = rightFirst ? (from[right++] ?? 0) : (from[left++] ?? 0);
        }
      }
      const swap = from;
      from = to;
      to = swap;
    }
    if (from === this.visible) return;
    for (let i = 0; i < count; i++) this.visible[i] = from[i] ?? 0;
  }
}
