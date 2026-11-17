import type { Vec3 } from "@brr/schema/bundle";

export const THUMBNAIL_PX = 112;
export const SUPERSAMPLE = 3;
export const INHERIT_COLOR = 16;
export const MATRIX_FLOATS = 12;

const FOV_DEGREES = 30;
const VIEW_DIRECTION: Vec3 = [0.9, 0.85, 1.15];
const FRAME_MARGIN = 1.04;
const DEPTH_SLACK = 2;
const MIN_NEAR_LDU = 1;

const KEY_DIRECTION: Vec3 = [0.45, 1, 0.3];
const KEY_INTENSITY = 2.4;
const FILL_DIRECTION: Vec3 = [-0.7, 0.35, 0.6];
const FILL_INTENSITY = 0.45;
const SKY_RGB = 0xd9e6f2;
const GROUND_RGB = 0x4a4a40;
const AMBIENT_INTENSITY = 1.4;
const SPECULAR_REFLECTANCE = 0.04;
const SPECULAR_EXPONENT = 160;

const EDGE_DEPTH_PIXELS = 3;
const EDGE_NORMAL_COSINE = 0.75;
const EDGE_DARKEN = 0.45;
const EDGE_STRENGTH = 0.7;

const OPAQUE_ALPHA = 255;
const BYTE_MAX = 255;
const RGB_CHANNEL_BITS = 8;
const RGBA = 4;
const SRGB_LINEAR_CUTOFF = 0.04045;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_GAMMA = 2.4;
const LINEAR_SRGB_CUTOFF = 0.0031308;
const DEGREES_PER_HALF_TURN = 180;

export interface ThumbnailColor {
  readonly code: number;
  readonly rgb: string;
  readonly alpha: number;
}

export interface ColorGroup {
  readonly ldrawColor: number;
  readonly indices: Uint32Array;
}

export interface Mesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly groups: ReadonlyArray<ColorGroup>;
}

export interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface ThumbnailScene {
  readonly meshes: ReadonlyArray<Mesh>;
  readonly count: number;
  readonly mesh: Uint32Array;
  readonly color: Uint16Array;
  readonly matrices: Float32Array;
  readonly box: Box;
}

interface LinearColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly alpha: number;
}

function toLinear(channel: number): number {
  const c = channel / BYTE_MAX;
  return c <= SRGB_LINEAR_CUTOFF
    ? c / SRGB_LINEAR_SLOPE
    : ((c + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_GAMMA;
}

function toSrgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const encoded =
    c <= LINEAR_SRGB_CUTOFF
      ? c * SRGB_LINEAR_SLOPE
      : SRGB_SCALE * c ** (1 / SRGB_GAMMA) - SRGB_OFFSET;
  return Math.round(encoded * BYTE_MAX);
}

function channels(rgb: number): Vec3 {
  return [
    toLinear((rgb >> (2 * RGB_CHANNEL_BITS)) & BYTE_MAX),
    toLinear((rgb >> RGB_CHANNEL_BITS) & BYTE_MAX),
    toLinear(rgb & BYTE_MAX),
  ];
}

function linearPalette(colors: ReadonlyArray<ThumbnailColor>): ReadonlyMap<number, LinearColor> {
  return new Map(
    colors.map((color) => {
      const hex = /^#([0-9a-fA-F]{6})$/u.exec(color.rgb)?.[1];
      if (hex === undefined) throw new Error(`LDConfig colour ${color.code} has rgb ${color.rgb}`);
      const [r, g, b] = channels(Number.parseInt(hex, 16));
      return [color.code, { r, g, b, alpha: color.alpha / OPAQUE_ALPHA }];
    }),
  );
}

function normalized([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

interface Camera {
  readonly eye: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
  readonly near: number;
  readonly focal: number;
}

function frameBox(box: Box, size: number): Camera {
  const centre: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const radius =
    Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
  const halfFov = (FOV_DEGREES * Math.PI) / DEGREES_PER_HALF_TURN / 2;
  const distance = (radius * FRAME_MARGIN) / Math.sin(halfFov);
  const view = normalized(VIEW_DIRECTION);
  const eye: Vec3 = [
    centre[0] + view[0] * distance,
    centre[1] + view[1] * distance,
    centre[2] + view[2] * distance,
  ];
  const forward: Vec3 = [-view[0], -view[1], -view[2]];
  const right = normalized(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const focal = size / 2 / Math.tan(halfFov);
  return {
    eye,
    right,
    up,
    forward,
    near: Math.max(MIN_NEAR_LDU, distance - radius * DEPTH_SLACK),
    focal,
  };
}

class Lighting {
  private readonly key = normalized(KEY_DIRECTION);
  private readonly fill = normalized(FILL_DIRECTION);
  private readonly sky = channels(SKY_RGB);
  private readonly ground = channels(GROUND_RGB);
  private readonly half: Vec3;

  constructor(toEye: Vec3) {
    this.half = normalized([
      this.key[0] + toEye[0],
      this.key[1] + toEye[1],
      this.key[2] + toEye[2],
    ]);
  }

  shade(nx: number, ny: number, nz: number, albedo: LinearColor, out: Float32Array, o: number) {
    const keyLight = Math.max(0, nx * this.key[0] + ny * this.key[1] + nz * this.key[2]);
    const fillLight = Math.max(0, nx * this.fill[0] + ny * this.fill[1] + nz * this.fill[2]);
    const direct = (KEY_INTENSITY * keyLight + FILL_INTENSITY * fillLight) / Math.PI;
    const skyWeight = (ny + 1) / 2;
    const ambient = AMBIENT_INTENSITY / Math.PI;
    const facing = Math.max(0, nx * this.half[0] + ny * this.half[1] + nz * this.half[2]);
    const specular =
      keyLight > 0
        ? (SPECULAR_REFLECTANCE *
            KEY_INTENSITY *
            keyLight *
            (SPECULAR_EXPONENT + RGB_CHANNEL_BITS) *
            facing ** SPECULAR_EXPONENT) /
          (RGB_CHANNEL_BITS * Math.PI)
        : 0;
    out[o] =
      albedo.r *
        (direct + ambient * (this.ground[0] + (this.sky[0] - this.ground[0]) * skyWeight)) +
      specular;
    out[o + 1] =
      albedo.g *
        (direct + ambient * (this.ground[1] + (this.sky[1] - this.ground[1]) * skyWeight)) +
      specular;
    out[o + 2] =
      albedo.b *
        (direct + ambient * (this.ground[2] + (this.sky[2] - this.ground[2]) * skyWeight)) +
      specular;
  }
}

interface Translucent {
  readonly instance: number;
  readonly group: number;
  readonly triangle: number;
  readonly depth: number;
}

class Target {
  readonly depth: Float32Array;
  readonly color: Float32Array;
  readonly coverage: Float32Array;
  readonly normal: Float32Array;
  private screen = new Float32Array(0);
  private worldNormal = new Float32Array(0);
  private readonly shaded = new Float32Array(3);
  readonly size: number;
  private readonly camera: Camera;
  private readonly lighting: Lighting;

  constructor(size: number, camera: Camera, lighting: Lighting) {
    this.size = size;
    this.camera = camera;
    this.lighting = lighting;
    const pixels = size * size;
    this.depth = new Float32Array(pixels).fill(Number.POSITIVE_INFINITY);
    this.color = new Float32Array(pixels * 3);
    this.coverage = new Float32Array(pixels);
    this.normal = new Float32Array(pixels * 3);
  }

  project(mesh: Mesh, matrices: Float32Array, instance: number): void {
    const vertices = mesh.positions.length / 3;
    if (this.screen.length < vertices * 3) {
      this.screen = new Float32Array(vertices * 3);
      this.worldNormal = new Float32Array(vertices * 3);
    }
    const m = instance * MATRIX_FLOATS;
    const a = matrices;
    const { eye, right, up, forward, focal } = this.camera;
    const half = this.size / 2;
    const c00 = (a[m + 5] ?? 0) * (a[m + 10] ?? 0) - (a[m + 6] ?? 0) * (a[m + 9] ?? 0);
    const c01 = (a[m + 6] ?? 0) * (a[m + 8] ?? 0) - (a[m + 4] ?? 0) * (a[m + 10] ?? 0);
    const c02 = (a[m + 4] ?? 0) * (a[m + 9] ?? 0) - (a[m + 5] ?? 0) * (a[m + 8] ?? 0);
    const c10 = (a[m + 2] ?? 0) * (a[m + 9] ?? 0) - (a[m + 1] ?? 0) * (a[m + 10] ?? 0);
    const c11 = (a[m] ?? 0) * (a[m + 10] ?? 0) - (a[m + 2] ?? 0) * (a[m + 8] ?? 0);
    const c12 = (a[m + 1] ?? 0) * (a[m + 8] ?? 0) - (a[m] ?? 0) * (a[m + 9] ?? 0);
    const c20 = (a[m + 1] ?? 0) * (a[m + 6] ?? 0) - (a[m + 2] ?? 0) * (a[m + 5] ?? 0);
    const c21 = (a[m + 2] ?? 0) * (a[m + 4] ?? 0) - (a[m] ?? 0) * (a[m + 6] ?? 0);
    const c22 = (a[m] ?? 0) * (a[m + 5] ?? 0) - (a[m + 1] ?? 0) * (a[m + 4] ?? 0);
    const p = mesh.positions;
    const n = mesh.normals;
    for (let v = 0; v < vertices; v++) {
      const lx = p[v * 3] ?? 0;
      const ly = p[v * 3 + 1] ?? 0;
      const lz = p[v * 3 + 2] ?? 0;
      const wx = (a[m] ?? 0) * lx + (a[m + 1] ?? 0) * ly + (a[m + 2] ?? 0) * lz + (a[m + 3] ?? 0);
      const wy =
        (a[m + 4] ?? 0) * lx + (a[m + 5] ?? 0) * ly + (a[m + 6] ?? 0) * lz + (a[m + 7] ?? 0);
      const wz =
        (a[m + 8] ?? 0) * lx + (a[m + 9] ?? 0) * ly + (a[m + 10] ?? 0) * lz + (a[m + 11] ?? 0);
      const dx = wx - eye[0];
      const dy = wy - eye[1];
      const dz = wz - eye[2];
      const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
      const vx = dx * right[0] + dy * right[1] + dz * right[2];
      const vy = dx * up[0] + dy * up[1] + dz * up[2];
      this.screen[v * 3] = half + (vx / depth) * focal;
      this.screen[v * 3 + 1] = half - (vy / depth) * focal;
      this.screen[v * 3 + 2] = depth;
      const nx = n[v * 3] ?? 0;
      const ny = n[v * 3 + 1] ?? 0;
      const nz = n[v * 3 + 2] ?? 0;
      const tx = c00 * nx + c01 * ny + c02 * nz;
      const ty = c10 * nx + c11 * ny + c12 * nz;
      const tz = c20 * nx + c21 * ny + c22 * nz;
      const length = Math.hypot(tx, ty, tz) || 1;
      this.worldNormal[v * 3] = tx / length;
      this.worldNormal[v * 3 + 1] = ty / length;
      this.worldNormal[v * 3 + 2] = tz / length;
    }
  }

  facesCamera(i0: number, i1: number, i2: number, toEye: Vec3): boolean {
    const n = this.worldNormal;
    let facing = 0;
    for (let k = 0; k < 3; k++) {
      facing +=
        ((n[i0 * 3 + k] ?? 0) + (n[i1 * 3 + k] ?? 0) + (n[i2 * 3 + k] ?? 0)) * (toEye[k] ?? 0);
    }
    return facing > 0;
  }

  triangleDepth(i0: number, i1: number, i2: number): number {
    return (
      ((this.screen[i0 * 3 + 2] ?? 0) +
        (this.screen[i1 * 3 + 2] ?? 0) +
        (this.screen[i2 * 3 + 2] ?? 0)) /
      3
    );
  }

  fill(i0: number, i1: number, i2: number, albedo: LinearColor, blend: boolean): void {
    const s = this.screen;
    const z0 = s[i0 * 3 + 2] ?? 0;
    const z1 = s[i1 * 3 + 2] ?? 0;
    const z2 = s[i2 * 3 + 2] ?? 0;
    const near = this.camera.near;
    if (z0 < near || z1 < near || z2 < near) return;
    const x0 = s[i0 * 3] ?? 0;
    const y0 = s[i0 * 3 + 1] ?? 0;
    const x1 = s[i1 * 3] ?? 0;
    const y1 = s[i1 * 3 + 1] ?? 0;
    const x2 = s[i2 * 3] ?? 0;
    const y2 = s[i2 * 3 + 1] ?? 0;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) return;
    const size = this.size;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;
    const sign = area > 0 ? 1 : -1;
    const inverseArea = 1 / Math.abs(area);
    const owns0 = topLeft(x1, y1, x2, y2, sign);
    const owns1 = topLeft(x2, y2, x0, y0, sign);
    const owns2 = topLeft(x0, y0, x1, y1, sign);
    const q0 = 1 / z0;
    const q1 = 1 / z1;
    const q2 = 1 / z2;
    const n = this.worldNormal;
    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const w0 = sign * ((x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1));
        const w1 = sign * ((x0 - x2) * (cy - y2) - (y0 - y2) * (cx - x2));
        const w2 = sign * ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0));
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        if ((w0 === 0 && !owns0) || (w1 === 0 && !owns1) || (w2 === 0 && !owns2)) continue;
        const b0 = w0 * inverseArea * q0;
        const b1 = w1 * inverseArea * q1;
        const b2 = w2 * inverseArea * q2;
        const q = b0 + b1 + b2;
        const depth = 1 / q;
        const pixel = py * size + px;
        if (depth >= (this.depth[pixel] ?? 0)) continue;
        let nx = ((n[i0 * 3] ?? 0) * b0 + (n[i1 * 3] ?? 0) * b1 + (n[i2 * 3] ?? 0) * b2) * depth;
        let ny =
          ((n[i0 * 3 + 1] ?? 0) * b0 + (n[i1 * 3 + 1] ?? 0) * b1 + (n[i2 * 3 + 1] ?? 0) * b2) *
          depth;
        let nz =
          ((n[i0 * 3 + 2] ?? 0) * b0 + (n[i1 * 3 + 2] ?? 0) * b1 + (n[i2 * 3 + 2] ?? 0) * b2) *
          depth;
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
        this.lighting.shade(nx, ny, nz, albedo, this.shaded, 0);
        const c = pixel * 3;
        if (blend) {
          const alpha = albedo.alpha;
          const keep = 1 - alpha;
          this.color[c] = (this.shaded[0] ?? 0) * alpha + (this.color[c] ?? 0) * keep;
          this.color[c + 1] = (this.shaded[1] ?? 0) * alpha + (this.color[c + 1] ?? 0) * keep;
          this.color[c + 2] = (this.shaded[2] ?? 0) * alpha + (this.color[c + 2] ?? 0) * keep;
          this.coverage[pixel] = alpha + (this.coverage[pixel] ?? 0) * keep;
          continue;
        }
        this.depth[pixel] = depth;
        this.color[c] = this.shaded[0] ?? 0;
        this.color[c + 1] = this.shaded[1] ?? 0;
        this.color[c + 2] = this.shaded[2] ?? 0;
        this.coverage[pixel] = 1;
        this.normal[c] = nx;
        this.normal[c + 1] = ny;
        this.normal[c + 2] = nz;
      }
    }
  }

  outline(): void {
    const size = this.size;
    const edge = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const pixel = y * size + x;
        if ((this.coverage[pixel] ?? 0) === 0) continue;
        if (
          this.differs(pixel, x > 0 ? pixel - 1 : -1, x < size - 1 ? pixel + 1 : -1) ||
          this.differs(pixel, y > 0 ? pixel - size : -1, y < size - 1 ? pixel + size : -1)
        ) {
          edge[pixel] = 1;
        }
      }
    }
    const keep = 1 - EDGE_STRENGTH;
    const toward = EDGE_STRENGTH * EDGE_DARKEN;
    for (let pixel = 0; pixel < edge.length; pixel++) {
      if (edge[pixel] === 0) continue;
      for (let k = 0; k < 3; k++) {
        this.color[pixel * 3 + k] = (this.color[pixel * 3 + k] ?? 0) * (keep + toward);
      }
    }
  }

  outlineTranslucent(): void {
    const size = this.size;
    const darken = 1 - EDGE_STRENGTH + EDGE_STRENGTH * EDGE_DARKEN;
    const edge = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const pixel = y * size + x;
        if ((this.coverage[pixel] ?? 0) === 0 || Number.isFinite(this.depth[pixel] ?? 0)) continue;
        const open =
          x === 0 ||
          y === 0 ||
          x === size - 1 ||
          y === size - 1 ||
          (this.coverage[pixel - 1] ?? 0) === 0 ||
          (this.coverage[pixel + 1] ?? 0) === 0 ||
          (this.coverage[pixel - size] ?? 0) === 0 ||
          (this.coverage[pixel + size] ?? 0) === 0;
        if (open) edge[pixel] = 1;
      }
    }
    for (let pixel = 0; pixel < edge.length; pixel++) {
      if (edge[pixel] === 0) continue;
      const coverage = this.coverage[pixel] ?? 0;
      const raised = Math.max(coverage, EDGE_STRENGTH);
      const gain = (raised / coverage) * darken;
      for (let k = 0; k < 3; k++)
        this.color[pixel * 3 + k] = (this.color[pixel * 3 + k] ?? 0) * gain;
      this.coverage[pixel] = raised;
    }
  }

  private bends(pixel: number, other: number): boolean {
    if (other < 0 || (this.coverage[other] ?? 0) === 0) return true;
    const n = this.normal;
    const cosine =
      (n[pixel * 3] ?? 0) * (n[other * 3] ?? 0) +
      (n[pixel * 3 + 1] ?? 0) * (n[other * 3 + 1] ?? 0) +
      (n[pixel * 3 + 2] ?? 0) * (n[other * 3 + 2] ?? 0);
    return cosine < EDGE_NORMAL_COSINE;
  }

  private differs(pixel: number, before: number, after: number): boolean {
    if (this.bends(pixel, before) || this.bends(pixel, after)) return true;
    const d = this.depth[pixel] ?? 0;
    const curvature = (this.depth[before] ?? 0) + (this.depth[after] ?? 0) - 2 * d;
    return Math.abs(curvature) > (EDGE_DEPTH_PIXELS * d) / this.camera.focal;
  }

  resolve(output: number, factor: number): Uint8Array {
    const rgba = new Uint8Array(output * output * RGBA);
    const samples = factor * factor;
    for (let y = 0; y < output; y++) {
      for (let x = 0; x < output; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < factor; sy++) {
          for (let sx = 0; sx < factor; sx++) {
            const pixel = (y * factor + sy) * this.size + x * factor + sx;
            r += this.color[pixel * 3] ?? 0;
            g += this.color[pixel * 3 + 1] ?? 0;
            b += this.color[pixel * 3 + 2] ?? 0;
            a += this.coverage[pixel] ?? 0;
          }
        }
        const o = (y * output + x) * RGBA;
        if (a === 0) continue;
        rgba[o] = toSrgbByte(r / a);
        rgba[o + 1] = toSrgbByte(g / a);
        rgba[o + 2] = toSrgbByte(b / a);
        rgba[o + 3] = Math.round((a / samples) * BYTE_MAX);
      }
    }
    return rgba;
  }
}

function topLeft(ax: number, ay: number, bx: number, by: number, sign: number): boolean {
  const dx = (bx - ax) * sign;
  const dy = (by - ay) * sign;
  return (dy === 0 && dx > 0) || dy < 0;
}

function colorOf(palette: ReadonlyMap<number, LinearColor>, code: number): LinearColor {
  const color = palette.get(code);
  if (!color) throw new Error(`LDConfig has no colour ${code}`);
  return color;
}

export function renderThumbnail(
  scene: ThumbnailScene,
  colors: ReadonlyArray<ThumbnailColor>,
  output = THUMBNAIL_PX,
  factor = SUPERSAMPLE,
): Uint8Array {
  const palette = linearPalette(colors);
  const size = output * factor;
  const camera = frameBox(scene.box, size);
  const toEye: Vec3 = [-camera.forward[0], -camera.forward[1], -camera.forward[2]];
  const target = new Target(size, camera, new Lighting(toEye));
  const translucent: Translucent[] = [];
  for (let instance = 0; instance < scene.count; instance++) {
    const mesh = scene.meshes[scene.mesh[instance] ?? 0];
    if (!mesh || mesh.groups.length === 0) continue;
    target.project(mesh, scene.matrices, instance);
    const instanceColor = scene.color[instance] ?? INHERIT_COLOR;
    for (let group = 0; group < mesh.groups.length; group++) {
      const { ldrawColor, indices } = mesh.groups[group] ?? { ldrawColor: 0, indices: [] };
      const albedo = colorOf(palette, ldrawColor === INHERIT_COLOR ? instanceColor : ldrawColor);
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const i0 = indices[t] ?? 0;
        const i1 = indices[t + 1] ?? 0;
        const i2 = indices[t + 2] ?? 0;
        if (albedo.alpha < 1) {
          if (!target.facesCamera(i0, i1, i2, toEye)) continue;
          translucent.push({
            instance,
            group,
            triangle: t,
            depth: target.triangleDepth(i0, i1, i2),
          });
          continue;
        }
        target.fill(i0, i1, i2, albedo, false);
      }
    }
  }
  target.outline();
  translucent.sort(
    (a, b) =>
      b.depth - a.depth || a.instance - b.instance || a.group - b.group || a.triangle - b.triangle,
  );
  let projected = -1;
  for (const { instance, group, triangle } of translucent) {
    const mesh = scene.meshes[scene.mesh[instance] ?? 0];
    const entry = mesh?.groups[group];
    if (!mesh || !entry) continue;
    if (instance !== projected) {
      target.project(mesh, scene.matrices, instance);
      projected = instance;
    }
    const instanceColor = scene.color[instance] ?? INHERIT_COLOR;
    const albedo = colorOf(
      palette,
      entry.ldrawColor === INHERIT_COLOR ? instanceColor : entry.ldrawColor,
    );
    target.fill(
      entry.indices[triangle] ?? 0,
      entry.indices[triangle + 1] ?? 0,
      entry.indices[triangle + 2] ?? 0,
      albedo,
      true,
    );
  }
  target.outlineTranslucent();
  return target.resolve(output, factor);
}
