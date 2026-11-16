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
  type RebaseEvent,
  type SceneBackendConfig,
  type StudInstances,
} from "../scene-backend.ts";
import { CHUNK_LDU, chunkOf } from "@brr/math";
import { GpuBufferTally } from "./gpu-buffer-tally.ts";
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
const REBASE_DISTANCE_CHUNKS = 8;

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

interface InstanceAttributes {
  readonly matrices: InstancedBufferAttribute;
  readonly colors: InstancedBufferAttribute;
}

function countBy(select: ArrayLike<number>, total: number, keys: number): Uint32Array {
  const counts = new Uint32Array(keys);
  for (let i = 0; i < total; i++) {
    const key = select[i] ?? 0;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

class ChunkRecord {
  tier = TIER_UNSET;

  constructor(
    readonly group: Group,
    readonly detailed: Group,
    readonly shellBodies: Group,
    readonly coarseStuds: Group,
    readonly originX: number,
    readonly originZ: number,
    readonly minX: number,
    readonly maxX: number,
    readonly minZ: number,
    readonly maxZ: number,
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
  private linearColors = new Float32Array(0);
  private readonly chunks = new Map<number, ChunkRecord>();
  private chunkList: ChunkRecord[] = [];
  private tiered = false;
  private readonly bufferTally = new GpuBufferTally();
  private focalLengthPx = 1;
  private renderOriginX = 0;
  private renderOriginZ = 0;
  private eyeX = 0;
  private eyeY = 0;
  private eyeZ = 0;
  private frame = 0;
  private readonly rebases: RebaseEvent[] = [];
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
    this.watchBuffers(renderer);
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

  private watchBuffers(renderer: WebGPURenderer): void {
    const device = webGpuDevice(renderer.backend);
    if (device) {
      this.bufferTally.watchWebGpu(device);
      return;
    }
    const gl = webGl2Context(renderer.backend);
    if (gl) this.bufferTally.watchWebGl2(gl);
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
    if (palette.far) assertSameParts(palette.detailed, palette.far);
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
    this.farLevel = palette.far ? level(palette.far) : EMPTY_LEVEL;
    this.tiered = palette.far !== undefined;
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
  }

  private clearChunks(): void {
    for (const key of this.chunks.keys()) this.removeChunk(key);
  }

  private buildChunk(chunk: ChunkInstances): ChunkRecord {
    const group = new Group();
    group.position.set(chunk.originX - this.renderOriginX, 0, chunk.originZ - this.renderOriginZ);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const detailed = new Group();
    const shellBodies = new Group();
    const coarseStuds = new Group();
    group.add(detailed, shellBodies, coarseStuds);
    const partCount = this.detailedLevel.parts.length;
    const counts = countBy(chunk.partIndex, chunk.count, partCount);
    for (let p = 0; p < partCount; p++) {
      const count = counts[p] ?? 0;
      if (count === 0) continue;
      const attributes = this.instanceAttributes(
        chunk.partIndex,
        chunk.count,
        p,
        count,
        chunk.matrices,
        chunk.colorIndex,
      );
      this.addPartMeshes(detailed, this.detailedLevel.parts[p], count, attributes);
      this.addPartMeshes(shellBodies, this.farLevel.parts[p], count, attributes);
    }
    this.addStudMeshes(chunk.studs, detailed, coarseStuds);
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
      chunk.originX,
      chunk.originZ,
      minX,
      maxX,
      minZ,
      maxZ,
    );
    record.applyTier(TIER_NEAR);
    return record;
  }

  private instanceAttributes(
    select: ArrayLike<number>,
    total: number,
    key: number,
    count: number,
    sourceMatrices: Float32Array,
    colorIndex: Uint16Array,
  ): InstanceAttributes {
    const matrices = new Float32Array(count * MATRIX4_FLOATS);
    const colors = new Float32Array(count * COLOR_CHANNELS);
    let slot = 0;
    for (let i = 0; i < total; i++) {
      if (select[i] !== key) continue;
      writeMatrix4(sourceMatrices, i, matrices, slot);
      const c = (colorIndex[i] ?? 0) * COLOR_CHANNELS;
      colors[slot * COLOR_CHANNELS] = this.linearColors[c] ?? 0;
      colors[slot * COLOR_CHANNELS + 1] = this.linearColors[c + 1] ?? 0;
      colors[slot * COLOR_CHANNELS + 2] = this.linearColors[c + 2] ?? 0;
      slot++;
    }
    return {
      matrices: new InstancedBufferAttribute(matrices, MATRIX4_FLOATS),
      colors: new InstancedBufferAttribute(colors, COLOR_CHANNELS),
    };
  }

  private addPartMeshes(
    layer: Group,
    geometries: PartGeometries | undefined,
    count: number,
    attributes: InstanceAttributes,
  ): void {
    if (geometries?.body) {
      layer.add(
        this.instancedMesh(
          geometries.body,
          this.material,
          count,
          attributes.matrices,
          attributes.colors,
        ),
      );
    }
    if (geometries?.fixed) {
      layer.add(
        this.instancedMesh(
          geometries.fixed,
          this.fixedColorMaterial,
          count,
          attributes.matrices,
          undefined,
        ),
      );
    }
  }

  private addStudMeshes(studs: StudInstances, detailed: Group, coarse: Group): void {
    const primitiveCount = this.detailedLevel.studs.length;
    const counts = countBy(studs.primitiveIndex, studs.count, primitiveCount);
    for (let k = 0; k < primitiveCount; k++) {
      const count = counts[k] ?? 0;
      const detailedGeometry = this.detailedLevel.studs[k];
      if (count === 0 || !detailedGeometry) continue;
      const attributes = this.instanceAttributes(
        studs.primitiveIndex,
        studs.count,
        k,
        count,
        studs.matrices,
        studs.colorIndex,
      );
      detailed.add(
        this.instancedMesh(
          detailedGeometry,
          this.material,
          count,
          attributes.matrices,
          attributes.colors,
        ),
      );
      const coarseGeometry = this.farLevel.studs[k];
      if (coarseGeometry) {
        coarse.add(
          this.instancedMesh(
            coarseGeometry,
            this.material,
            count,
            attributes.matrices,
            attributes.colors,
          ),
        );
      }
    }
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
    this.eyeX = eyeX;
    this.eyeY = eyeY;
    this.eyeZ = eyeZ;
    this.rebaseIfFar();
    this.camera.position.set(eyeX - this.renderOriginX, eyeY, eyeZ - this.renderOriginZ);
    this.camera.lookAt(atX - this.renderOriginX, atY, atZ - this.renderOriginZ);
    this.camera.updateMatrixWorld();
  }

  private rebaseIfFar(): void {
    const chunkX = chunkOf(this.eyeX);
    const chunkZ = chunkOf(this.eyeZ);
    const originChunkX = this.renderOriginX / CHUNK_LDU;
    const originChunkZ = this.renderOriginZ / CHUNK_LDU;
    const nearOrigin =
      Math.abs(chunkX - originChunkX) <= REBASE_DISTANCE_CHUNKS &&
      Math.abs(chunkZ - originChunkZ) <= REBASE_DISTANCE_CHUNKS;
    if (this.rebases.length > 0 && nearOrigin) return;
    this.renderOriginX = chunkX * CHUNK_LDU;
    this.renderOriginZ = chunkZ * CHUNK_LDU;
    for (let i = 0; i < this.chunkList.length; i++) {
      const record = this.chunkList[i];
      if (!record) continue;
      record.group.position.set(
        record.originX - this.renderOriginX,
        0,
        record.originZ - this.renderOriginZ,
      );
      record.group.updateMatrix();
      record.group.updateMatrixWorld(true);
    }
    this.rebases.push({ frame: this.frame, chunkX, chunkZ });
  }

  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return this.rebases;
  }

  resize(width: number, height: number): void {
    this.renderer?.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    const bufferHeight = this.renderer?.domElement.height ?? height;
    this.focalLengthPx = bufferHeight / (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360));
  }

  private assignTiers(out: FrameStats): void {
    if (!this.tiered) {
      out.nearChunks = this.chunkList.length;
      out.midChunks = 0;
      out.farChunks = 0;
      return;
    }
    let near = 0;
    let mid = 0;
    let far = 0;
    for (let i = 0; i < this.chunkList.length; i++) {
      const record = this.chunkList[i];
      if (!record) continue;
      const dx = Math.max(record.minX - this.eyeX, 0, this.eyeX - record.maxX);
      const dz = Math.max(record.minZ - this.eyeZ, 0, this.eyeZ - record.maxZ);
      const distance = Math.max(Math.hypot(dx, this.eyeY, dz), CAMERA_NEAR_LDU);
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
    return this.bufferTally.snapshot();
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
    out.renderOriginChunkX = this.renderOriginX / CHUNK_LDU;
    out.renderOriginChunkZ = this.renderOriginZ / CHUNK_LDU;
    out.rebaseCount = this.rebases.length;
    this.frame++;
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
