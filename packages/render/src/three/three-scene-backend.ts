import { injectable } from "inversify";
import {
  BatchedMesh,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
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
  type ChunkInstances,
  type FrameStats,
  type ISceneBackend,
  type InstancingStrategy,
  type PartPalette,
  type SceneBackendConfig,
} from "../scene-backend.ts";
import { fixedColorGeometry, inheritBodyGeometry, inheritStudGeometry } from "./part-geometry.ts";

const MATRIX4_FLOATS = 16;
const CAMERA_FOV_DEGREES = 40;
const CAMERA_NEAR_LDU = 20;
const CAMERA_FAR_LDU = 400_000;
const PLASTIC_ROUGHNESS = 0.3;
const SKY_COLOR = 0xd9e6f2;
const GROUND_BOUNCE_COLOR = 0x4a4a40;
const HEMISPHERE_INTENSITY = 1.4;
const SUN_INTENSITY = 2.4;

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

const CHUNK_LDU = 640;
const SUPER_CHUNK_CHUNKS = 8;
const SUPER_CHUNK_LDU = CHUNK_LDU * SUPER_CHUNK_CHUNKS;

interface SuperChunk {
  readonly originX: number;
  readonly originZ: number;
  readonly chunks: Map<number, ChunkInstances>;
  group: Group | undefined;
  dirty: boolean;
}

interface PartBatch {
  readonly mesh: BatchedMesh;
  readonly geometryIds: Int32Array;
  readonly colored: boolean;
}

type GeometryClass = "body" | "studs" | "fixed";
const GEOMETRY_CLASSES: ReadonlyArray<GeometryClass> = ["body", "studs", "fixed"];

interface PartGeometries {
  readonly body: BufferGeometry | undefined;
  readonly studs: BufferGeometry | undefined;
  readonly fixed: BufferGeometry | undefined;
}

function disposeAll(geometries: ReadonlyArray<PartGeometries>): void {
  for (const part of geometries) {
    part.body?.dispose();
    part.studs?.dispose();
    part.fixed?.dispose();
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
  private partGeometries: ReadonlyArray<PartGeometries> = [];
  private strategy: InstancingStrategy = "instanced";
  private readonly superChunks = new Map<string, SuperChunk>();
  private readonly dirtySuperChunks: SuperChunk[] = [];
  private readonly scratchMatrix = new Matrix4();
  private linearColors = new Float32Array(0);
  private readonly chunkGroups = new Map<number, Group>();
  private readonly scratchColor = new Color();
  private readonly readbackPixel = new Uint8Array(4);
  private failure: string | undefined;
  private readonly scratchMatrix4 = new Float32Array(MATRIX4_FLOATS);

  async init(config: SceneBackendConfig): Promise<BackendInfo> {
    this.strategy = config.strategy;
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
      activeApi: this.isWebGpu(renderer) ? "webgpu" : "webgl2",
      adapter: this.describeAdapter(renderer),
      strategy: this.strategy,
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
    disposeAll(this.partGeometries);
    const linearColor = (code: number, out: Float32Array): void => {
      const srgb = palette.ldrawColorsSrgb.get(code);
      if (srgb === undefined) throw new Error(`LDraw colour ${code} is not in LDConfig`);
      this.scratchColor.setHex(srgb, SRGBColorSpace);
      out[0] = this.scratchColor.r;
      out[1] = this.scratchColor.g;
      out[2] = this.scratchColor.b;
    };
    this.partGeometries = palette.parts.map((part) => ({
      body: inheritBodyGeometry(part),
      studs: inheritStudGeometry(part, palette.studPrimitives),
      fixed: fixedColorGeometry(part, palette.studPrimitives, linearColor),
    }));
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
    if (this.strategy === "batched") {
      this.queueBatchedChunk(key, chunk);
      return;
    }
    this.removeChunkGroup(key);
    const group = this.buildInstancedChunk(chunk);
    this.chunkGroups.set(key, group);
    this.scene.add(group);
  }

  private removeChunkGroup(key: number): void {
    const existing = this.chunkGroups.get(key);
    if (!existing) return;
    this.scene.remove(existing);
    for (const child of existing.children) {
      if (child instanceof InstancedMesh) child.dispose();
    }
    this.chunkGroups.delete(key);
  }

  private clearChunks(): void {
    for (const key of this.chunkGroups.keys()) this.removeChunkGroup(key);
    for (const superChunk of this.superChunks.values()) this.removeSuperChunkGroup(superChunk);
    this.superChunks.clear();
    this.dirtySuperChunks.length = 0;
  }

  private queueBatchedChunk(key: number, chunk: ChunkInstances): void {
    const superX = Math.floor(chunk.originX / SUPER_CHUNK_LDU);
    const superZ = Math.floor(chunk.originZ / SUPER_CHUNK_LDU);
    const superKey = `${superX},${superZ}`;
    let superChunk = this.superChunks.get(superKey);
    if (!superChunk) {
      superChunk = {
        originX: superX * SUPER_CHUNK_LDU,
        originZ: superZ * SUPER_CHUNK_LDU,
        chunks: new Map(),
        group: undefined,
        dirty: false,
      };
      this.superChunks.set(superKey, superChunk);
    }
    superChunk.chunks.set(key, chunk);
    if (!superChunk.dirty) this.dirtySuperChunks.push(superChunk);
    superChunk.dirty = true;
  }

  private removeSuperChunkGroup(superChunk: SuperChunk): void {
    if (!superChunk.group) return;
    this.scene.remove(superChunk.group);
    for (const child of superChunk.group.children) {
      if (child instanceof BatchedMesh) child.dispose();
    }
    superChunk.group = undefined;
  }

  private rebuildSuperChunk(superChunk: SuperChunk): void {
    this.removeSuperChunkGroup(superChunk);
    const group = new Group();
    group.position.set(superChunk.originX, 0, superChunk.originZ);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const used = new Uint8Array(this.partGeometries.length);
    let instanceTotal = 0;
    for (const chunk of superChunk.chunks.values()) {
      instanceTotal += chunk.count;
      for (let i = 0; i < chunk.count; i++) used[chunk.partIndex[i] ?? 0] = 1;
    }
    const batches = GEOMETRY_CLASSES.map((kind) => this.batchedMesh(kind, used, instanceTotal));
    for (const chunk of superChunk.chunks.values()) {
      const offsetX = chunk.originX - superChunk.originX;
      const offsetZ = chunk.originZ - superChunk.originZ;
      for (let i = 0; i < chunk.count; i++) {
        const part = chunk.partIndex[i] ?? 0;
        writeMatrix4(chunk.matrices, i, this.scratchMatrix4, 0);
        this.scratchMatrix4[12] = (this.scratchMatrix4[12] ?? 0) + offsetX;
        this.scratchMatrix4[14] = (this.scratchMatrix4[14] ?? 0) + offsetZ;
        this.scratchMatrix.fromArray(this.scratchMatrix4);
        const c = (chunk.colorIndex[i] ?? 0) * COLOR_CHANNELS;
        this.scratchColor.setRGB(
          this.linearColors[c] ?? 0,
          this.linearColors[c + 1] ?? 0,
          this.linearColors[c + 2] ?? 0,
        );
        for (let b = 0; b < batches.length; b++) {
          const batch = batches[b];
          if (batch) this.addBatchInstance(batch, part);
        }
      }
    }
    for (const batch of batches) {
      if (!batch) continue;
      batch.mesh.sortObjects = false;
      batch.mesh.matrixAutoUpdate = false;
      batch.mesh.computeBoundingSphere();
      group.add(batch.mesh);
    }
    for (const child of group.children) child.updateMatrixWorld(true);
    superChunk.group = group;
    superChunk.dirty = false;
    this.scene.add(group);
  }

  private addBatchInstance(batch: PartBatch, part: number): void {
    const geometryId = batch.geometryIds[part] ?? -1;
    if (geometryId < 0) return;
    const instance = batch.mesh.addInstance(geometryId);
    batch.mesh.setMatrixAt(instance, this.scratchMatrix);
    if (batch.colored) batch.mesh.setColorAt(instance, this.scratchColor);
  }

  private batchedMesh(
    kind: GeometryClass,
    used: Uint8Array,
    instanceTotal: number,
  ): PartBatch | undefined {
    let vertexTotal = 0;
    let indexTotal = 0;
    let instances = 0;
    for (let p = 0; p < this.partGeometries.length; p++) {
      const geometry = this.partGeometries[p]?.[kind];
      if (!used[p] || !geometry) continue;
      vertexTotal += geometry.getAttribute("position").count;
      indexTotal += geometry.getIndex()?.count ?? 0;
      instances++;
    }
    if (instances === 0) return undefined;
    const material = kind === "fixed" ? this.fixedColorMaterial : this.material;
    const mesh = new BatchedMesh(instanceTotal, vertexTotal, indexTotal, material);
    const geometryIds = new Int32Array(this.partGeometries.length).fill(-1);
    for (let p = 0; p < this.partGeometries.length; p++) {
      const geometry = this.partGeometries[p]?.[kind];
      if (!used[p] || !geometry) continue;
      geometryIds[p] = mesh.addGeometry(geometry);
    }
    return { mesh, geometryIds, colored: kind !== "fixed" };
  }

  private buildInstancedChunk(chunk: ChunkInstances): Group {
    const group = new Group();
    group.position.set(chunk.originX, 0, chunk.originZ);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const partCount = this.partGeometries.length;
    const counts = new Uint32Array(partCount);
    for (let i = 0; i < chunk.count; i++) {
      const part = chunk.partIndex[i] ?? 0;
      counts[part] = (counts[part] ?? 0) + 1;
    }
    for (let p = 0; p < partCount; p++) {
      const count = counts[p] ?? 0;
      const geometries = this.partGeometries[p];
      if (count === 0 || !geometries) continue;
      const matrices = new Float32Array(count * MATRIX4_FLOATS);
      const colors = new Float32Array(count * COLOR_CHANNELS);
      let slot = 0;
      for (let i = 0; i < chunk.count; i++) {
        if (chunk.partIndex[i] !== p) continue;
        writeMatrix4(chunk.matrices, i, matrices, slot);
        const c = (chunk.colorIndex[i] ?? 0) * COLOR_CHANNELS;
        colors[slot * 3] = this.linearColors[c] ?? 0;
        colors[slot * 3 + 1] = this.linearColors[c + 1] ?? 0;
        colors[slot * 3 + 2] = this.linearColors[c + 2] ?? 0;
        slot++;
      }
      const matrixAttribute = new InstancedBufferAttribute(matrices, MATRIX4_FLOATS);
      const colorAttribute = new InstancedBufferAttribute(colors, COLOR_CHANNELS);
      const { body, studs, fixed } = geometries;
      if (body)
        group.add(this.instancedMesh(body, this.material, count, matrixAttribute, colorAttribute));
      if (studs)
        group.add(this.instancedMesh(studs, this.material, count, matrixAttribute, colorAttribute));
      if (fixed)
        group.add(
          this.instancedMesh(fixed, this.fixedColorMaterial, count, matrixAttribute, undefined),
        );
    }
    for (const child of group.children) child.updateMatrixWorld(true);
    return group;
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
  }

  renderFrame(out: FrameStats): void {
    const renderer = this.renderer;
    if (!renderer) throw new Error("ThreeSceneBackend.renderFrame called before init");
    this.throwIfFailed();
    for (let i = 0; i < this.dirtySuperChunks.length; i++) {
      const superChunk = this.dirtySuperChunks[i];
      if (superChunk) this.rebuildSuperChunk(superChunk);
    }
    this.dirtySuperChunks.length = 0;
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
