import { injectable } from "inversify";
import {
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGPURenderer,
  type BufferGeometry,
} from "three/webgpu";
import {
  COLOR_CHANNELS,
  INSTANCE_MATRIX_FLOATS,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type GeometrySet,
  type FrameStats,
  type ISceneBackend,
  type PartPalette,
  type SceneBackendConfig,
  type StudInstances,
} from "../scene-backend.ts";
import { fixedColorGeometry, inheritBodyGeometry, primitiveGeometry } from "./part-geometry.ts";

const MATRIX4_FLOATS = 16;
const CAMERA_FOV_DEGREES = 40;
const CAMERA_NEAR_LDU = 20;
const CAMERA_FAR_LDU = 400_000;
const PLASTIC_ROUGHNESS = 0.3;
const SKY_COLOR = 0xd9e6f2;
const GROUND_BOUNCE_COLOR = 0x4a4a40;
const HEMISPHERE_INTENSITY = 1.4;
const SUN_INTENSITY = 2.4;
const STUD_PITCH_LDU = 20;
const NEAR_MIN_STUD_PITCH_PX = 12;
const MID_MIN_STUD_PITCH_PX = 3;
const TIER_NEAR = 0;
const TIER_MID = 1;
const TIER_FAR = 2;
const TIER_UNSET = 255;

function writeMatrix4(
  source: Float32Array,
  sourceIndex: number,
  target: Float32Array,
  targetIndex: number,
): void {
  const s = sourceIndex * INSTANCE_MATRIX_FLOATS;
  const t = targetIndex * MATRIX4_FLOATS;
  target[t] = source[s] ?? 0;
  target[t + 1] = source[s + 4] ?? 0;
  target[t + 2] = source[s + 8] ?? 0;
  target[t + 3] = 0;
  target[t + 4] = source[s + 1] ?? 0;
  target[t + 5] = source[s + 5] ?? 0;
  target[t + 6] = source[s + 9] ?? 0;
  target[t + 7] = 0;
  target[t + 8] = source[s + 2] ?? 0;
  target[t + 9] = source[s + 6] ?? 0;
  target[t + 10] = source[s + 10] ?? 0;
  target[t + 11] = 0;
  target[t + 12] = source[s + 3] ?? 0;
  target[t + 13] = source[s + 7] ?? 0;
  target[t + 14] = source[s + 11] ?? 0;
  target[t + 15] = 1;
}

function webGpuDevice(backend: unknown): GPUDevice | undefined {
  if (typeof backend !== "object" || backend === null || !("device" in backend)) return undefined;
  const device: unknown = backend.device;
  return typeof GPUDevice !== "undefined" && device instanceof GPUDevice ? device : undefined;
}

function webGl2Context(backend: unknown): WebGL2RenderingContext | undefined {
  if (typeof backend !== "object" || backend === null || !("gl" in backend)) return undefined;
  const gl: unknown = backend.gl;
  return typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext
    ? gl
    : undefined;
}

interface PartGeometries {
  readonly body: BufferGeometry | undefined;
  readonly fixed: BufferGeometry | undefined;
}

interface LevelGeometries {
  readonly parts: ReadonlyArray<PartGeometries>;
  readonly studs: ReadonlyArray<BufferGeometry>;
}

const EMPTY_LEVEL: LevelGeometries = { parts: [], studs: [] };

function geometryBytes(geometry: BufferGeometry | undefined): number {
  if (!geometry) return 0;
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const name of Object.keys(geometry.attributes)) {
    bytes += geometry.getAttribute(name).array.byteLength;
  }
  return bytes;
}

function levelBytes(level: LevelGeometries): number {
  let bytes = 0;
  for (const part of level.parts) bytes += geometryBytes(part.body) + geometryBytes(part.fixed);
  for (const stud of level.studs) bytes += geometryBytes(stud);
  return bytes;
}

function disposeLevel(level: LevelGeometries): void {
  for (const part of level.parts) {
    part.body?.dispose();
    part.fixed?.dispose();
  }
  for (const stud of level.studs) stud.dispose();
}

function assertSameParts(detailed: GeometrySet, other: GeometrySet): void {
  const sameParts =
    detailed.parts.length === other.parts.length &&
    detailed.parts.every((part, i) => part.id === other.parts[i]?.id);
  if (!sameParts || detailed.studPrimitives.length !== other.studPrimitives.length) {
    throw new Error("the palette's geometry sets do not list the same parts and studs");
  }
}

class ChunkRecord {
  tier = TIER_UNSET;

  constructor(
    readonly group: Group,
    readonly detailed: Group,
    readonly shellBodies: Group,
    readonly coarseStuds: Group,
    readonly minX: number,
    readonly maxX: number,
    readonly minZ: number,
    readonly maxZ: number,
    readonly instanceBytes: number,
  ) {}

  applyTier(tier: number): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.detailed.visible = tier === TIER_NEAR;
    this.shellBodies.visible = tier !== TIER_NEAR;
    this.coarseStuds.visible = tier === TIER_MID;
  }
}

@injectable()
export class ThreeSceneBackend implements ISceneBackend {
  private renderer: WebGPURenderer | undefined;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    1,
    CAMERA_NEAR_LDU,
    CAMERA_FAR_LDU,
  );
  private readonly material = new MeshStandardNodeMaterial({
    roughness: PLASTIC_ROUGHNESS,
    metalness: 0,
  });
  private readonly fixedColorMaterial = new MeshStandardNodeMaterial({
    roughness: PLASTIC_ROUGHNESS,
    metalness: 0,
    vertexColors: true,
  });
  private detailedLevel: LevelGeometries = EMPTY_LEVEL;
  private farLevel: LevelGeometries = EMPTY_LEVEL;
  private paletteGeometryBytes = 0;
  private linearColors = new Float32Array(0);
  private readonly chunks = new Map<number, ChunkRecord>();
  private chunkList: ChunkRecord[] = [];
  private chunkInstanceBytes = 0;
  private focalLengthPx = 1;
  private readonly scratchColor = new Color();
  private readonly readbackPixel = new Uint8Array(4);
  private failure: string | undefined;

  async init(config: SceneBackendConfig): Promise<BackendInfo> {
    const renderer = new WebGPURenderer({
      canvas: config.canvas,
      antialias: config.antialias,
      forceWebGL: config.api === "webgl2",
    });
    await renderer.init();
    this.watchForFailure(renderer, config.canvas);
    renderer.info.autoReset = false;
    renderer.setPixelRatio(config.pixelRatio);
    renderer.setSize(config.canvas.clientWidth, config.canvas.clientHeight, false);
    this.renderer = renderer;
    this.scene.background = new Color(SKY_COLOR);
    this.scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_INTENSITY));
    const sun = new DirectionalLight(0xffffff, SUN_INTENSITY);
    sun.position.set(0.45, 1, 0.3);
    this.scene.add(sun);
    this.resize(config.canvas.clientWidth, config.canvas.clientHeight);
    return {
      requestedApi: config.api,
      backgroundSrgb: SKY_COLOR,
      activeApi: this.isWebGpu(renderer) ? "webgpu" : "webgl2",
      adapter: this.describeAdapter(renderer),
    };
  }

  private watchForFailure(renderer: WebGPURenderer, canvas: HTMLCanvasElement): void {
    const device = webGpuDevice(renderer.backend);
    if (device) {
      void device.lost.then((info) =>
        this.fail(`WebGPU device lost (${info.reason}): ${info.message}`),
      );
      device.addEventListener("uncapturederror", (event) =>
        this.fail(`WebGPU error: ${event.error.message}`),
      );
      return;
    }
    canvas.addEventListener("webglcontextlost", () => this.fail("WebGL2 context lost"));
  }

  private fail(reason: string): void {
    this.failure ??= reason;
  }

  private throwIfFailed(): void {
    if (this.failure !== undefined)
      throw new Error(`Rendering failed, frames are not valid: ${this.failure}`);
  }

  private isWebGpu(renderer: WebGPURenderer): boolean {
    return webGpuDevice(renderer.backend) !== undefined;
  }

  private describeAdapter(renderer: WebGPURenderer): string {
    const device = webGpuDevice(renderer.backend);
    if (device) {
      const info = device.adapterInfo;
      return [info.vendor, info.architecture, info.device, info.description]
        .filter((s) => s !== "")
        .join(" / ");
    }
    const gl = webGl2Context(renderer.backend);
    if (!gl) return "unknown WebGL2 context";
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = debug
      ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR);
    const name = debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return `${String(vendor)} / ${String(name)}`;
  }

  setPalette(palette: PartPalette): void {
    this.clearChunks();
    disposeLevel(this.detailedLevel);
    disposeLevel(this.farLevel);
    assertSameParts(palette.detailed, palette.far);
    const linearColor = (code: number, out: Float32Array): void => {
      const srgb = palette.ldrawColorsSrgb.get(code);
      if (srgb === undefined) throw new Error(`LDraw colour ${code} is not in LDConfig`);
      this.scratchColor.setHex(srgb, SRGBColorSpace);
      out[0] = this.scratchColor.r;
      out[1] = this.scratchColor.g;
      out[2] = this.scratchColor.b;
    };
    const level = (set: GeometrySet): LevelGeometries => ({
      parts: set.parts.map((part) => ({
        body: inheritBodyGeometry(part),
        fixed: fixedColorGeometry(part, linearColor),
      })),
      studs: set.studPrimitives.map((primitive) => primitiveGeometry(primitive.mesh)),
    });
    this.detailedLevel = level(palette.detailed);
    this.farLevel = level(palette.far);
    this.paletteGeometryBytes = levelBytes(this.detailedLevel) + levelBytes(this.farLevel);
    const colorCount = palette.colorsSrgb.length / COLOR_CHANNELS;
    this.linearColors = new Float32Array(colorCount * COLOR_CHANNELS);
    for (let c = 0; c < colorCount; c++) {
      const o = c * COLOR_CHANNELS;
      this.scratchColor.setRGB(
        (palette.colorsSrgb[o] ?? 0) / 255,
        (palette.colorsSrgb[o + 1] ?? 0) / 255,
        (palette.colorsSrgb[o + 2] ?? 0) / 255,
        SRGBColorSpace,
      );
      this.linearColors[o] = this.scratchColor.r;
      this.linearColors[o + 1] = this.scratchColor.g;
      this.linearColors[o + 2] = this.scratchColor.b;
    }
  }

  setChunk(key: number, chunk: ChunkInstances): void {
    this.removeChunk(key);
    const record = this.buildChunk(chunk);
    this.chunks.set(key, record);
    this.chunkList.push(record);
    this.chunkInstanceBytes += record.instanceBytes;
    this.scene.add(record.group);
  }

  private removeChunk(key: number): void {
    const existing = this.chunks.get(key);
    if (!existing) return;
    this.scene.remove(existing.group);
    for (const layer of [existing.detailed, existing.shellBodies, existing.coarseStuds]) {
      for (const child of layer.children) {
        if (child instanceof InstancedMesh) child.dispose();
      }
    }
    this.chunks.delete(key);
    this.chunkList = this.chunkList.filter((record) => record !== existing);
    this.chunkInstanceBytes -= existing.instanceBytes;
  }

  private clearChunks(): void {
    for (const key of this.chunks.keys()) this.removeChunk(key);
  }

  private buildChunk(chunk: ChunkInstances): ChunkRecord {
    const group = new Group();
    group.position.set(chunk.originX, 0, chunk.originZ);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const detailed = new Group();
    const shellBodies = new Group();
    const coarseStuds = new Group();
    group.add(detailed, shellBodies, coarseStuds);
    let instanceBytes = 0;
    const partCount = this.detailedLevel.parts.length;
    const counts = new Uint32Array(partCount);
    for (let i = 0; i < chunk.count; i++) {
      const part = chunk.partIndex[i] ?? 0;
      counts[part] = (counts[part] ?? 0) + 1;
    }
    for (let p = 0; p < partCount; p++) {
      const count = counts[p] ?? 0;
      if (count === 0) continue;
      const matrices = new Float32Array(count * MATRIX4_FLOATS);
      const colors = new Float32Array(count * COLOR_CHANNELS);
      let slot = 0;
      for (let i = 0; i < chunk.count; i++) {
        if (chunk.partIndex[i] !== p) continue;
        writeMatrix4(chunk.matrices, i, matrices, slot);
        this.writeColor(chunk.colorIndex[i] ?? 0, colors, slot);
        slot++;
      }
      instanceBytes += matrices.byteLength + colors.byteLength;
      const matrixAttribute = new InstancedBufferAttribute(matrices, MATRIX4_FLOATS);
      const colorAttribute = new InstancedBufferAttribute(colors, COLOR_CHANNELS);
      this.addPartMeshes(
        detailed,
        this.detailedLevel.parts[p],
        count,
        matrixAttribute,
        colorAttribute,
      );
      this.addPartMeshes(
        shellBodies,
        this.farLevel.parts[p],
        count,
        matrixAttribute,
        colorAttribute,
      );
    }
    instanceBytes += this.addStudMeshes(chunk.studs, detailed, coarseStuds);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < chunk.count; i++) {
      const x = chunk.originX + (chunk.matrices[i * INSTANCE_MATRIX_FLOATS + 3] ?? 0);
      const z = chunk.originZ + (chunk.matrices[i * INSTANCE_MATRIX_FLOATS + 11] ?? 0);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    group.updateMatrixWorld(true);
    const record = new ChunkRecord(
      group,
      detailed,
      shellBodies,
      coarseStuds,
      minX,
      maxX,
      minZ,
      maxZ,
      instanceBytes,
    );
    record.applyTier(TIER_NEAR);
    return record;
  }

  private writeColor(colorIndex: number, target: Float32Array, slot: number): void {
    const c = colorIndex * COLOR_CHANNELS;
    target[slot * COLOR_CHANNELS] = this.linearColors[c] ?? 0;
    target[slot * COLOR_CHANNELS + 1] = this.linearColors[c + 1] ?? 0;
    target[slot * COLOR_CHANNELS + 2] = this.linearColors[c + 2] ?? 0;
  }

  private addPartMeshes(
    layer: Group,
    geometries: PartGeometries | undefined,
    count: number,
    matrices: InstancedBufferAttribute,
    colors: InstancedBufferAttribute,
  ): void {
    if (geometries?.body) {
      layer.add(this.instancedMesh(geometries.body, this.material, count, matrices, colors));
    }
    if (geometries?.fixed) {
      layer.add(
        this.instancedMesh(geometries.fixed, this.fixedColorMaterial, count, matrices, undefined),
      );
    }
  }

  private addStudMeshes(studs: StudInstances, detailed: Group, coarse: Group): number {
    let bytes = 0;
    const primitiveCount = this.detailedLevel.studs.length;
    const counts = new Uint32Array(primitiveCount);
    for (let s = 0; s < studs.count; s++) {
      const k = studs.primitiveIndex[s] ?? 0;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (let k = 0; k < primitiveCount; k++) {
      const count = counts[k] ?? 0;
      const detailedGeometry = this.detailedLevel.studs[k];
      const coarseGeometry = this.farLevel.studs[k];
      if (count === 0 || !detailedGeometry || !coarseGeometry) continue;
      const matrices = new Float32Array(count * MATRIX4_FLOATS);
      const colors = new Float32Array(count * COLOR_CHANNELS);
      let slot = 0;
      for (let s = 0; s < studs.count; s++) {
        if (studs.primitiveIndex[s] !== k) continue;
        writeMatrix4(studs.matrices, s, matrices, slot);
        this.writeColor(studs.colorIndex[s] ?? 0, colors, slot);
        slot++;
      }
      bytes += matrices.byteLength + colors.byteLength;
      const matrixAttribute = new InstancedBufferAttribute(matrices, MATRIX4_FLOATS);
      const colorAttribute = new InstancedBufferAttribute(colors, COLOR_CHANNELS);
      detailed.add(
        this.instancedMesh(detailedGeometry, this.material, count, matrixAttribute, colorAttribute),
      );
      coarse.add(
        this.instancedMesh(coarseGeometry, this.material, count, matrixAttribute, colorAttribute),
      );
    }
    return bytes;
  }

  private instancedMesh(
    geometry: BufferGeometry,
    material: MeshStandardNodeMaterial,
    count: number,
    matrices: InstancedBufferAttribute,
    colors: InstancedBufferAttribute | undefined,
  ): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, count);
    mesh.instanceMatrix = matrices;
    if (colors) mesh.instanceColor = colors;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingSphere();
    return mesh;
  }

  setView(eyeX: number, eyeY: number, eyeZ: number, atX: number, atY: number, atZ: number): void {
    this.camera.position.set(eyeX, eyeY, eyeZ);
    this.camera.lookAt(atX, atY, atZ);
    this.camera.updateMatrixWorld();
  }

  resize(width: number, height: number): void {
    this.renderer?.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    const bufferHeight = this.renderer?.domElement.height ?? height;
    this.focalLengthPx = bufferHeight / (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360));
  }

  private assignTiers(out: FrameStats): void {
    const eye = this.camera.position;
    let near = 0;
    let mid = 0;
    let far = 0;
    for (let i = 0; i < this.chunkList.length; i++) {
      const record = this.chunkList[i];
      if (!record) continue;
      const dx = Math.max(record.minX - eye.x, 0, eye.x - record.maxX);
      const dz = Math.max(record.minZ - eye.z, 0, eye.z - record.maxZ);
      const distance = Math.max(Math.hypot(dx, eye.y, dz), CAMERA_NEAR_LDU);
      const studPitchPx = (STUD_PITCH_LDU * this.focalLengthPx) / distance;
      if (studPitchPx >= NEAR_MIN_STUD_PITCH_PX) {
        record.applyTier(TIER_NEAR);
        near++;
      } else if (studPitchPx >= MID_MIN_STUD_PITCH_PX) {
        record.applyTier(TIER_MID);
        mid++;
      } else {
        record.applyTier(TIER_FAR);
        far++;
      }
    }
    out.nearChunks = near;
    out.midChunks = mid;
    out.farChunks = far;
  }

  bufferMemory(): BufferMemory {
    return { geometryBytes: this.paletteGeometryBytes, instanceBytes: this.chunkInstanceBytes };
  }

  renderFrame(out: FrameStats): void {
    const renderer = this.renderer;
    if (!renderer) throw new Error("ThreeSceneBackend.renderFrame called before init");
    this.throwIfFailed();
    this.assignTiers(out);
    renderer.info.reset();
    renderer.render(this.scene, this.camera);
    out.drawCalls = renderer.info.render.drawCalls;
    out.triangles = renderer.info.render.triangles;
  }

  async waitForGpu(): Promise<void> {
    const renderer = this.renderer;
    if (!renderer) return;
    const device = webGpuDevice(renderer.backend);
    if (device) {
      await device.queue.onSubmittedWorkDone();
    } else {
      const gl = webGl2Context(renderer.backend);
      gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.readbackPixel);
    }
    this.throwIfFailed();
  }
}
