import { injectable } from "inversify";
import {
  Box3,
  BoxGeometry,
  BufferGeometry as LineGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  DirectionalLight,
  EdgesGeometry,
  Frustum,
  Group,
  HemisphereLight,
  BufferAttribute,
  BufferGeometry,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGPURenderer,
  MeshStandardNodeMaterial,
  type Object3DEventMap,
} from "three/webgpu";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import {
  CAMERA_FOV_DEGREES,
  COLOR_CHANNELS,
  INSTANCE_MATRIX_FLOATS,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type EdgeMarker,
  type MarkerKind,
  type ChunkTier,
  type FarModelPlacement,
  type GeometrySet,
  type FrameStats,
  type ISceneBackend,
  type LookSettings,
  type PartPalette,
  type PlanOverlay,
  type RebaseEvent,
  type SceneBackendConfig,
  type TrackEndKind,
  type TrackEndMarker,
  type SuperChunkMesh,
  type WorldBox,
} from "../scene-backend.ts";
import { CHUNK_LDU, chunkKey, chunkOf } from "@brr/math";
import { GpuBufferTally } from "./gpu-buffer-tally.ts";
import {
  BatchSet,
  EMPTY_GROUP,
  GroupBuilder,
  RegionBatches,
  type BatchStyle,
  type InstanceGroup,
} from "./instance-batches.ts";
import { LookPipeline } from "./look-pipeline.ts";
import {
  fixedColorGeometries,
  inheritBodyGeometry,
  primitiveGeometry,
  type FixedColorGeometry,
} from "./part-geometry.ts";
import { OPAQUE_ALPHA, PlasticMaterials } from "./plastic-materials.ts";
import { skyEnvironment } from "./sky-environment.ts";

const MATRIX4_FLOATS = 16;
const REBASE_DISTANCE_CHUNKS = 8;
const SETTLED_EYE_MS = 250;
const REBASE_LOG_LIMIT = 256;
const CAMERA_NEAR_LDU = 20;
const CAMERA_FAR_LDU = 400_000;
const SKY_COLOR = 0xd9e6f2;
const GROUND_BOUNCE_COLOR = 0x4a4a40;
const HEMISPHERE_INTENSITY = 1.4;
const SUN_INTENSITY = 2.4;
const PLASTIC_SUN_INTENSITY = 1.6;
const ENVIRONMENT_INTENSITY = 0.33;
const FILL_SKY_COLOR = 0xffffff;
const FILL_GROUND_COLOR = 0x8a8478;
const FILL_INTENSITY = 0.7;
const SUN_DIRECTION = new Vector3(0.45, 1, 0.3);
const SHADOW_LAYER = 1;
const BOUNDS_FLOATS = 6;
const SHADOW_MAP_SIZE = 2048;
const SHADOW_CASCADES = 3;
const SHADOW_LIGHT_MARGIN_LDU = 4000;
const SHADOW_BIAS = -0.0005;
const SHADOW_NORMAL_BIAS = 1.5;
const SHADOW_MIN_FAR_LDU = 2000;
const SHADOW_FAR_HYSTERESIS = 1.25;
const STUD_PITCH_LDU = 20;
const NEAR_MIN_STUD_PITCH_PX = 12;
const MID_MIN_STUD_PITCH_PX = 3;
const TIER_NEAR = 0;
const TIER_MID = 1;
const TIER_FAR = 2;
const TIER_UNSET = 255;
const TIER_BY_NAME: Readonly<Record<ChunkTier, number>> = {
  near: TIER_NEAR,
  mid: TIER_MID,
  far: TIER_FAR,
};
const UPRIGHT_TOLERANCE = 1e-6;
const REGION_CHUNKS = 4;
const GHOST_OPACITY = 0.55;
const SELECTION_COLOR = 0xff8c00;
const QUARTER_TURN_RADIANS = Math.PI / 2;
const MARKER_COLORS: Readonly<Record<MarkerKind, number>> = {
  joined: 0x1fbf4a,
  open: 0xffb000,
  mismatch: 0xe0202a,
};
const TRACK_END_COLORS: Readonly<Record<TrackEndKind, number>> = {
  open: 0xffb000,
  gap: 0xe0202a,
  target: 0x1fbf4a,
};
const TRACK_END_ARROW_RADIUS_LDU = 16;
const TRACK_END_ARROW_LENGTH_LDU = 30;
const TRACK_END_ARROW_LIFT_LDU = 44;
const TRACK_END_ARROW_SEGMENTS = 12;
const TRACK_END_POST_WIDTH_LDU = 8;
const TRACK_END_POST_HEIGHT_LDU = 96;
const FLOOR_COLOR = 0xd8d2c8;
const INACTIVE_FLOOR_COLOR = 0xe6e2dc;
const ROOM_OUTLINE_COLOR = 0x3a3a3a;
const TABLE_COLOR = 0xb58b5a;
const TABLE_GRID_COLOR = 0x6b4f2e;
const OBSTACLE_COLOR = 0xc0392b;
const OBSTACLE_OPACITY = 0.45;
const ISSUE_COLOR = 0xe0115f;
const FLOOR_THICKNESS_LDU = 10;
const GRID_LIFT_LDU = 0.5;

interface Anchored {
  readonly object: Group | LineSegments;
  readonly x: number;
  readonly z: number;
}

function gridLines(
  table: WorldBox,
  anchorX: number,
  anchorZ: number,
  gridOriginX: number,
  gridOriginZ: number,
  step: number,
): number[] {
  const out: number[] = [];
  const y = table.maxY + GRID_LIFT_LDU;
  const firstX = gridOriginX + Math.ceil((table.minX - gridOriginX) / step) * step;
  for (let x = firstX; x <= table.maxX; x += step) {
    out.push(x - anchorX, y, table.minZ - anchorZ, x - anchorX, y, table.maxZ - anchorZ);
  }
  const firstZ = gridOriginZ + Math.ceil((table.minZ - gridOriginZ) / step) * step;
  for (let z = firstZ; z <= table.maxZ; z += step) {
    out.push(table.minX - anchorX, y, z - anchorZ, table.maxX - anchorX, y, z - anchorZ);
  }
  return out;
}

function trackEndArrowGeometry(): ConeGeometry {
  const cone = new ConeGeometry(
    TRACK_END_ARROW_RADIUS_LDU,
    TRACK_END_ARROW_LENGTH_LDU,
    TRACK_END_ARROW_SEGMENTS,
  );
  cone.rotateZ(-Math.PI / 2);
  cone.translate(TRACK_END_ARROW_LENGTH_LDU / 2, TRACK_END_ARROW_LIFT_LDU, 0);
  return cone;
}

function trackEndPostGeometry(): BoxGeometry {
  const post = new BoxGeometry(
    TRACK_END_POST_WIDTH_LDU,
    TRACK_END_POST_HEIGHT_LDU,
    TRACK_END_POST_WIDTH_LDU,
  );
  post.translate(0, TRACK_END_POST_HEIGHT_LDU / 2, 0);
  return post;
}

function lineSegments(positions: number[], color: number): LineSegments {
  const geometry = new LineGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return new LineSegments(geometry, new LineBasicNodeMaterial({ color }));
}

function boxMesh(
  box: WorldBox,
  anchorX: number,
  anchorZ: number,
  material: MeshStandardNodeMaterial,
): Mesh {
  const mesh = new Mesh(
    new BoxGeometry(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ),
    material,
  );
  mesh.position.set(
    (box.minX + box.maxX) / 2 - anchorX,
    (box.minY + box.maxY) / 2,
    (box.minZ + box.maxZ) / 2 - anchorZ,
  );
  return mesh;
}

function disposeTree(root: Group | LineSegments): void {
  root.traverse((child) => {
    if (child instanceof Mesh || child instanceof LineSegments) {
      child.geometry.dispose();
      const material: unknown = child.material;
      if (material instanceof MeshStandardNodeMaterial || material instanceof LineBasicNodeMaterial)
        material.dispose();
    }
  });
}
const VECTOR_FLOATS = 3;
const VERTICES_PER_TRIANGLE = 3;
const UINT16_VERTEX_LIMIT = 65_536;
const RGBA_CHANNELS = 4;
const UNORM8_MAX = 255;

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
  readonly fixed: ReadonlyArray<FixedColorGeometry>;
}

interface LevelGeometries {
  readonly parts: ReadonlyArray<PartGeometries>;
  readonly studs: ReadonlyArray<BufferGeometry>;
}

const EMPTY_LEVEL: LevelGeometries = { parts: [], studs: [] };

function disposeLevel(level: LevelGeometries): void {
  for (const part of level.parts) {
    part.body?.dispose();
    for (const fixed of part.fixed) fixed.geometry.dispose();
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

function isUpright(matrices: Float32Array, instance: number): boolean {
  const o = instance * INSTANCE_MATRIX_FLOATS;
  return (
    Math.abs(matrices[o + 1] ?? 0) < UPRIGHT_TOLERANCE &&
    Math.abs(matrices[o + 9] ?? 0) < UPRIGHT_TOLERANCE &&
    Math.abs(matrices[o + 4] ?? 0) < UPRIGHT_TOLERANCE &&
    Math.abs(matrices[o + 6] ?? 0) < UPRIGHT_TOLERANCE &&
    Math.abs((matrices[o + 5] ?? 0) - 1) < UPRIGHT_TOLERANCE
  );
}

function partOrder(select: ArrayLike<number>, total: number, keys: number): Uint32Array {
  const starts = new Uint32Array(keys + 1);
  for (let i = 0; i < total; i++) {
    const key = (select[i] ?? 0) + 1;
    starts[key] = (starts[key] ?? 0) + 1;
  }
  for (let k = 1; k <= keys; k++) starts[k] = (starts[k] ?? 0) + (starts[k - 1] ?? 0);
  const order = new Uint32Array(total);
  for (let i = 0; i < total; i++) {
    const key = select[i] ?? 0;
    const slot = starts[key] ?? 0;
    order[slot] = i;
    starts[key] = slot + 1;
  }
  return order;
}

interface ShellGroups {
  readonly shell: InstanceGroup;
  readonly midShell: InstanceGroup;
}

const NO_SHELLS: ShellGroups = { shell: EMPTY_GROUP, midShell: EMPTY_GROUP };

class BatchedChunk {
  tier = TIER_UNSET;
  culled = false;

  constructor(
    readonly region: RegionBatches,
    readonly shellSet: BatchSet | null,
    readonly casterSet: BatchSet | null,
    readonly detailed: InstanceGroup,
    readonly shells: ShellGroups,
    readonly coarse: InstanceGroup,
    readonly casters: InstanceGroup,
    readonly minX: number,
    readonly maxX: number,
    readonly minZ: number,
    readonly maxZ: number,
    readonly bounds: Box3,
  ) {}

  private get showsNear(): boolean {
    return !this.culled && this.tier === TIER_NEAR;
  }

  show(tier: number, culled: boolean): void {
    if (tier === this.tier && culled === this.culled) return;
    const wasNear = this.showsNear;
    this.tier = tier;
    this.culled = culled;
    const shown = !culled;
    this.region.near.setGroupVisible(this.detailed, shown && tier === TIER_NEAR);
    const shell = this.shellSet;
    if (shell) {
      shell.setGroupVisible(this.shells.shell, shown && tier !== TIER_NEAR);
      shell.setGroupVisible(this.shells.midShell, shown && tier === TIER_MID);
      shell.setGroupVisible(this.coarse, shown && tier === TIER_MID);
    }
    this.region.countNear((this.showsNear ? 1 : 0) - (wasNear ? 1 : 0));
  }

  dispose(): void {
    this.region.near.releaseGroup(this.detailed);
    const shell = this.shellSet;
    if (shell) {
      shell.releaseGroup(this.shells.shell);
      shell.releaseGroup(this.shells.midShell);
      shell.releaseGroup(this.coarse);
    }
    this.casterSet?.releaseGroup(this.casters);
    if (this.showsNear) this.region.countNear(-1);
  }
}

const VEHICLE_EULER_ORDER = "YZX";

class VehicleRecord {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  roll = 0;

  constructor(
    readonly group: Group,
    readonly sets: ReadonlyArray<BatchSet>,
  ) {}
}

interface DisposableMeshEvents extends Object3DEventMap {
  dispose: object;
}

type DisposableMesh = Mesh<BufferGeometry, MeshStandardNodeMaterial, DisposableMeshEvents>;

function releaseRenderObjects(mesh: DisposableMesh): void {
  mesh.dispatchEvent({ type: "dispose" });
}

class FarModelNode {
  constructor(
    readonly group: Group,
    readonly meshes: ReadonlyArray<DisposableMesh>,
    readonly originX: number,
    readonly originZ: number,
    readonly chunkKeys: ReadonlyArray<number>,
  ) {}
}

class SuperChunkRecord {
  constructor(
    readonly group: Group,
    readonly meshes: ReadonlyArray<DisposableMesh>,
    readonly originX: number,
    readonly originZ: number,
  ) {}
}

interface AlphaGeometry {
  readonly alpha: number;
  readonly geometry: BufferGeometry;
}

@injectable()
export class ThreeSceneBackend implements ISceneBackend {
  private renderer: WebGPURenderer | undefined;
  private readonly scene = new Scene();
  private readonly perspective = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    1,
    CAMERA_NEAR_LDU,
    CAMERA_FAR_LDU,
  );
  private materials = new PlasticMaterials(false, 1);
  private ghostMaterials = new PlasticMaterials(false, GHOST_OPACITY);
  private look: LookSettings = {
    plastic: false,
    gtao: false,
    outlines: false,
    bevel: false,
    shadows: false,
    oit: false,
  };
  private pipeline: LookPipeline | undefined;
  private readonly sun = new DirectionalLight(0xffffff, SUN_INTENSITY);
  private shadowNode: CSMShadowNode | undefined;
  private shadowFar = 0;
  private readonly orthographic = new OrthographicCamera(
    -1,
    1,
    1,
    -1,
    CAMERA_NEAR_LDU,
    CAMERA_FAR_LDU,
  );
  private camera: PerspectiveCamera | OrthographicCamera = this.perspective;
  private aspect = 1;
  private orthoHalfHeight = 0;
  private readonly superLayer = new Group();
  private readonly superChunks = new Map<number, SuperChunkRecord>();
  private superList: SuperChunkRecord[] = [];
  private ghost: Group | undefined;
  private ghostSet: BatchSet | undefined;
  private ghostGroup = EMPTY_GROUP;
  private ghostX = 0;
  private ghostZ = 0;
  private readonly selection = new LineSegments(
    new EdgesGeometry(new BoxGeometry(1, 1, 1)),
    new LineBasicNodeMaterial({ color: SELECTION_COLOR, depthTest: false }),
  );
  private selectionCentreX = 0;
  private selectionCentreZ = 0;
  private readonly markerBox = new BoxGeometry(1, 1, 1);
  private readonly markerMaterials: Readonly<Record<MarkerKind, MeshBasicNodeMaterial>> = {
    joined: new MeshBasicNodeMaterial({ color: MARKER_COLORS.joined }),
    open: new MeshBasicNodeMaterial({ color: MARKER_COLORS.open }),
    mismatch: new MeshBasicNodeMaterial({ color: MARKER_COLORS.mismatch }),
  };
  private readonly markerGroup = new Group();
  private markers: ReadonlyArray<EdgeMarker> = [];
  private readonly trackEndArrow = trackEndArrowGeometry();
  private readonly trackEndPost = trackEndPostGeometry();
  private readonly trackEndMaterials: Readonly<Record<TrackEndKind, MeshBasicNodeMaterial>> = {
    open: new MeshBasicNodeMaterial({ color: TRACK_END_COLORS.open, depthTest: false }),
    gap: new MeshBasicNodeMaterial({ color: TRACK_END_COLORS.gap, depthTest: false }),
    target: new MeshBasicNodeMaterial({ color: TRACK_END_COLORS.target, depthTest: false }),
  };
  private readonly trackEndGroup = new Group();
  private trackEnds: ReadonlyArray<TrackEndMarker> = [];
  private planObjects: Anchored[] = [];
  private issueObjects: Anchored[] = [];
  private readonly issueEdges = new EdgesGeometry(new BoxGeometry(1, 1, 1));
  private readonly issueMaterial = new LineBasicNodeMaterial({
    color: ISSUE_COLOR,
    depthTest: false,
  });
  private readonly rayPoint = new Vector3();
  private detailedLevel: LevelGeometries = EMPTY_LEVEL;
  private farLevel: LevelGeometries = EMPTY_LEVEL;
  private farModelGeometries: ReadonlyArray<ReadonlyArray<FixedColorGeometry>> = [];
  private forcedTier: number | null = null;
  private readonly farModelNodes = new Map<number, FarModelNode>();
  private farModelList: FarModelNode[] = [];
  private readonly farModelMatrix = new Float32Array(MATRIX4_FLOATS);
  private linearColors = new Float32Array(0);
  private alphaSlots: number[] = [OPAQUE_ALPHA];
  private colorAlphaSlot = new Uint8Array(0);
  private readonly chunks = new Map<number, BatchedChunk>();
  private readonly regions = new Map<number, RegionBatches>();
  private regionList: RegionBatches[] = [];
  private readonly scratchMatrix = new Matrix4();
  private readonly scratchElements = new Float32Array(MATRIX4_FLOATS);
  private readonly frustum = new Frustum();
  private readonly viewProjection = new Matrix4();
  private readonly cullBox = new Box3();
  private readonly vehicles = new Map<number, VehicleRecord>();
  private chunkList: BatchedChunk[] = [];
  private tiered = false;
  private partBounds = new Float32Array(0);
  private readonly unitBox = new BoxGeometry(1, 1, 1);
  private readonly bufferTally = new GpuBufferTally();
  private focalLengthPx = 1;
  private renderOriginX = 0;
  private renderOriginZ = 0;
  private eyeX = 0;
  private eyeY = 0;
  private eyeZ = 0;
  private sceneMinX = Number.POSITIVE_INFINITY;
  private sceneMaxX = Number.NEGATIVE_INFINITY;
  private sceneMinZ = Number.POSITIVE_INFINITY;
  private sceneMaxZ = Number.NEGATIVE_INFINITY;
  private frame = 0;
  private readonly rebases: RebaseEvent[] = [];
  private rebaseCount = 0;
  private eyeMovedAt = 0;
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
    this.look = config.look;
    this.materials = new PlasticMaterials(config.look.plastic, 1);
    this.ghostMaterials = new PlasticMaterials(config.look.plastic, GHOST_OPACITY);
    this.scene.background = new Color(SKY_COLOR);
    this.light(renderer, config.look);
    if (config.look.gtao || config.look.outlines || config.look.bevel || config.look.oit) {
      this.pipeline = new LookPipeline(
        renderer,
        this.scene,
        this.perspective,
        config.look,
        SUN_DIRECTION,
        config.pixelRatio,
      );
    }
    this.selection.visible = false;
    this.selection.matrixAutoUpdate = false;
    this.selection.renderOrder = 1;
    this.scene.add(this.selection);
    this.markerGroup.matrixAutoUpdate = false;
    this.scene.add(this.markerGroup);
    this.trackEndGroup.matrixAutoUpdate = false;
    this.scene.add(this.trackEndGroup);
    this.scene.add(this.superLayer);
    this.resize(config.canvas.clientWidth, config.canvas.clientHeight);
    return {
      requestedApi: config.api,
      backgroundSrgb: SKY_COLOR,
      activeApi: this.isWebGpu(renderer) ? "webgpu" : "webgl2",
      adapter: this.describeAdapter(renderer),
      look: config.look,
    };
  }

  private light(renderer: WebGPURenderer, look: LookSettings): void {
    const sun = this.sun;
    sun.intensity = look.plastic ? PLASTIC_SUN_INTENSITY : SUN_INTENSITY;
    sun.position.copy(SUN_DIRECTION);
    this.scene.add(sun);
    if (look.plastic) {
      this.scene.environment = skyEnvironment(renderer);
      this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
      this.scene.add(new HemisphereLight(FILL_SKY_COLOR, FILL_GROUND_COLOR, FILL_INTENSITY));
    } else {
      this.scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_INTENSITY));
    }
    if (!look.shadows) return;
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.bias = SHADOW_BIAS;
    sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
    sun.shadow.camera.layers.set(SHADOW_LAYER);
    sun.shadow.camera.near = 1;
    const shadowNode = new CSMShadowNode(sun, {
      cascades: SHADOW_CASCADES,
      maxFar: SHADOW_MIN_FAR_LDU,
      mode: "practical",
      lightMargin: SHADOW_LIGHT_MARGIN_LDU,
    });
    sun.shadow.shadowNode = shadowNode;
    this.shadowNode = shadowNode;
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
    for (const node of this.farModelList) {
      this.scene.remove(node.group);
      for (const mesh of node.meshes) releaseRenderObjects(mesh);
    }
    this.farModelNodes.clear();
    this.farModelList = [];
    for (const key of this.superChunks.keys()) this.deleteSuperChunk(key);
    this.disposeGhostSet();
    disposeLevel(this.detailedLevel);
    disposeLevel(this.farLevel);
    for (const geometries of this.farModelGeometries) {
      for (const fixed of geometries) fixed.geometry.dispose();
    }
    if (palette.far) assertSameParts(palette.detailed, palette.far);
    const ldrawColor = (code: number) => {
      const color = palette.ldrawColors.get(code);
      if (color === undefined) throw new Error(`LDraw colour ${code} is not in LDConfig`);
      return color;
    };
    const linearColor = (code: number, out: Float32Array): void => {
      this.scratchColor.setHex(ldrawColor(code).srgb, SRGBColorSpace);
      out[0] = this.scratchColor.r;
      out[1] = this.scratchColor.g;
      out[2] = this.scratchColor.b;
    };
    const alphaOf = (code: number): number => ldrawColor(code).alpha;
    const level = (set: GeometrySet): LevelGeometries => ({
      parts: set.parts.map((part) => ({
        body: inheritBodyGeometry(part),
        fixed: fixedColorGeometries(part.mesh, linearColor, alphaOf),
      })),
      studs: set.studPrimitives.map((primitive) => primitiveGeometry(primitive.mesh)),
    });
    this.detailedLevel = level(palette.detailed);
    this.farLevel = palette.far ? level(palette.far) : EMPTY_LEVEL;
    this.farModelGeometries = (palette.farModels ?? []).map((mesh) =>
      fixedColorGeometries(mesh, linearColor, alphaOf),
    );
    this.tiered = palette.far !== undefined;
    this.partBounds = new Float32Array(palette.detailed.parts.length * BOUNDS_FLOATS);
    palette.detailed.parts.forEach((part, p) => {
      this.partBounds.set([...part.boundsMin, ...part.boundsMax], p * BOUNDS_FLOATS);
    });
    const colorCount = palette.colorsSrgb.length / COLOR_CHANNELS;
    this.linearColors = new Float32Array(colorCount * COLOR_CHANNELS);
    this.alphaSlots = [OPAQUE_ALPHA];
    this.colorAlphaSlot = new Uint8Array(colorCount);
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
      const alpha = palette.colorsAlpha[c] ?? OPAQUE_ALPHA;
      let slot = this.alphaSlots.indexOf(alpha);
      if (slot < 0) slot = this.alphaSlots.push(alpha) - 1;
      this.colorAlphaSlot[c] = slot;
    }
  }

  setChunk(key: number, chunk: ChunkInstances): void {
    this.removeChunk(key);
    const record = this.batchChunk(key, chunk);
    this.chunks.set(key, record);
    this.chunkList.push(record);
    this.sceneMinX = Math.min(this.sceneMinX, record.minX);
    this.sceneMaxX = Math.max(this.sceneMaxX, record.maxX);
    this.sceneMinZ = Math.min(this.sceneMinZ, record.minZ);
    this.sceneMaxZ = Math.max(this.sceneMaxZ, record.maxZ);
  }

  setVehicle(vehicle: number, model: ChunkInstances): void {
    this.removeVehicle(vehicle);
    const parts = partOrder(model.partIndex, model.count, this.detailedLevel.parts.length);
    const studs = partOrder(
      model.studs.primitiveIndex,
      model.studs.count,
      this.detailedLevel.studs.length,
    );
    const body = new BatchSet(this.visibleStyle());
    this.fillDetailed(body, model, parts, studs, 0, 0, this.materials);
    const sets = [body];
    if (this.look.shadows) {
      const casters = new BatchSet(this.casterStyle());
      this.fillCasters(casters, model, parts, 0, 0);
      sets.push(casters);
    }
    const group = new Group();
    for (const set of sets) group.add(set.root);
    const record = new VehicleRecord(group, sets);
    this.vehicles.set(vehicle, record);
    this.scene.add(group);
    this.placeVehicle(record);
  }

  setVehiclePose(
    vehicle: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch = 0,
    roll = 0,
  ): void {
    const record = this.vehicles.get(vehicle);
    if (!record) throw new Error(`vehicle ${vehicle} has no model`);
    record.x = x;
    record.y = y;
    record.z = z;
    record.yaw = yaw;
    record.pitch = pitch;
    record.roll = roll;
    this.placeVehicle(record);
  }

  private placeVehicle(record: VehicleRecord): void {
    record.group.position.set(
      record.x - this.renderOriginX,
      record.y,
      record.z - this.renderOriginZ,
    );
    record.group.rotation.set(record.roll, -record.yaw, record.pitch, VEHICLE_EULER_ORDER);
  }

  deleteVehicle(vehicle: number): void {
    this.removeVehicle(vehicle);
  }

  private removeVehicle(vehicle: number): void {
    const existing = this.vehicles.get(vehicle);
    if (!existing) return;
    this.scene.remove(existing.group);
    for (const set of existing.sets) set.dispose();
    this.vehicles.delete(vehicle);
  }

  deleteChunk(key: number): void {
    this.removeChunk(key);
  }

  setSuperChunk(key: number, mesh: SuperChunkMesh): void {
    const visible = this.superChunks.get(key)?.group.visible ?? false;
    this.deleteSuperChunk(key);
    const group = new Group();
    group.matrixAutoUpdate = false;
    group.visible = visible;
    const meshes: DisposableMesh[] = [];
    for (const { alpha, geometry } of this.superChunkGeometries(mesh)) {
      const material = this.materials.vertexColored(alpha);
      const object: DisposableMesh = new Mesh(geometry, material);
      object.matrixAutoUpdate = false;
      object.receiveShadow = this.look.shadows && !material.transparent;
      group.add(object);
      meshes.push(object);
    }
    const record = new SuperChunkRecord(group, meshes, mesh.originX, mesh.originZ);
    this.placeSuperChunk(record);
    this.superChunks.set(key, record);
    this.superList.push(record);
    this.superLayer.add(group);
  }

  private superChunkGeometries(mesh: SuperChunkMesh): AlphaGeometry[] {
    const slotOfVertex = new Uint8Array(mesh.vertexCount);
    for (let v = 0; v < mesh.vertexCount; v++) {
      slotOfVertex[v] = this.colorAlphaSlot[mesh.colorIndex[v] ?? 0] ?? 0;
    }
    const triangles = mesh.indexCount / VERTICES_PER_TRIANGLE;
    const trianglesInSlot = new Uint32Array(this.alphaSlots.length);
    for (let t = 0; t < triangles; t++) {
      const slot = slotOfVertex[mesh.indices[t * VERTICES_PER_TRIANGLE] ?? 0] ?? 0;
      trianglesInSlot[slot] = (trianglesInSlot[slot] ?? 0) + 1;
    }
    const result: AlphaGeometry[] = [];
    for (let slot = 0; slot < trianglesInSlot.length; slot++) {
      const count = trianglesInSlot[slot] ?? 0;
      if (count === 0) continue;
      const alpha = this.alphaSlots[slot] ?? OPAQUE_ALPHA;
      if (count === triangles) {
        result.push({
          alpha,
          geometry: this.voxelGeometry(mesh.positions, mesh.normals, mesh.colorIndex, mesh.indices),
        });
        continue;
      }
      result.push({ alpha, geometry: this.voxelSlotGeometry(mesh, slotOfVertex, slot, count) });
    }
    return result;
  }

  private voxelSlotGeometry(
    mesh: SuperChunkMesh,
    slotOfVertex: Uint8Array,
    slot: number,
    triangles: number,
  ): BufferGeometry {
    const remap = new Int32Array(mesh.vertexCount).fill(-1);
    let vertices = 0;
    const indexCount = triangles * VERTICES_PER_TRIANGLE;
    const local = new Uint32Array(indexCount);
    let written = 0;
    for (let i = 0; i < mesh.indexCount; i += VERTICES_PER_TRIANGLE) {
      if (slotOfVertex[mesh.indices[i] ?? 0] !== slot) continue;
      for (let k = 0; k < VERTICES_PER_TRIANGLE; k++) {
        const vertex = mesh.indices[i + k] ?? 0;
        if ((remap[vertex] ?? -1) < 0) remap[vertex] = vertices++;
        local[written++] = remap[vertex] ?? 0;
      }
    }
    const positions = new Float32Array(vertices * VECTOR_FLOATS);
    const normals = new Int8Array(vertices * VECTOR_FLOATS);
    const colorIndex = new Uint16Array(vertices);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const target = remap[v] ?? -1;
      if (target < 0) continue;
      for (let axis = 0; axis < VECTOR_FLOATS; axis++) {
        positions[target * VECTOR_FLOATS + axis] = mesh.positions[v * VECTOR_FLOATS + axis] ?? 0;
        normals[target * VECTOR_FLOATS + axis] = mesh.normals[v * VECTOR_FLOATS + axis] ?? 0;
      }
      colorIndex[target] = mesh.colorIndex[v] ?? 0;
    }
    const indices = vertices <= UINT16_VERTEX_LIMIT ? Uint16Array.from(local) : local;
    return this.voxelGeometry(positions, normals, colorIndex, indices);
  }

  private voxelGeometry(
    positions: Float32Array,
    normals: Int8Array,
    colorIndex: Uint16Array,
    indices: Uint16Array | Uint32Array,
  ): BufferGeometry {
    const vertexCount = colorIndex.length;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, VECTOR_FLOATS));
    geometry.setAttribute("normal", new BufferAttribute(normals, VECTOR_FLOATS, true));
    const colors = new Uint8Array(vertexCount * RGBA_CHANNELS);
    for (let v = 0; v < vertexCount; v++) {
      const c = (colorIndex[v] ?? 0) * COLOR_CHANNELS;
      const o = v * RGBA_CHANNELS;
      colors[o] = Math.round((this.linearColors[c] ?? 0) * UNORM8_MAX);
      colors[o + 1] = Math.round((this.linearColors[c + 1] ?? 0) * UNORM8_MAX);
      colors[o + 2] = Math.round((this.linearColors[c + 2] ?? 0) * UNORM8_MAX);
      colors[o + 3] = UNORM8_MAX;
    }
    geometry.setAttribute("color", new BufferAttribute(colors, RGBA_CHANNELS, true));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }

  setSuperChunkVisible(key: number, visible: boolean): void {
    const record = this.superChunks.get(key);
    if (record) record.group.visible = visible;
  }

  deleteSuperChunk(key: number): void {
    const record = this.superChunks.get(key);
    if (!record) return;
    this.superLayer.remove(record.group);
    for (const mesh of record.meshes) {
      releaseRenderObjects(mesh);
      mesh.geometry.dispose();
    }
    this.superChunks.delete(key);
    this.superList = this.superList.filter((existing) => existing !== record);
  }

  private placeSuperChunk(record: SuperChunkRecord): void {
    record.group.position.set(
      record.originX - this.renderOriginX,
      0,
      record.originZ - this.renderOriginZ,
    );
    record.group.updateMatrix();
    record.group.updateMatrixWorld(true);
  }

  studPitchesPx(distancesLdu: Float64Array, count: number, out: Float64Array): void {
    if (this.camera === this.orthographic) {
      out.fill(this.orthoStudPitchPx(), 0, count);
      return;
    }
    const pitchLdu = STUD_PITCH_LDU * this.focalLengthPx;
    for (let i = 0; i < count; i++) {
      out[i] = pitchLdu / Math.max(distancesLdu[i] ?? 0, CAMERA_NEAR_LDU);
    }
  }

  private orthoStudPitchPx(): number {
    return (
      (STUD_PITCH_LDU * this.focalLengthPx * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360)) /
      Math.max(this.orthoHalfHeight, CAMERA_NEAR_LDU)
    );
  }

  private removeChunk(key: number): void {
    const existing = this.chunks.get(key);
    if (!existing) return;
    existing.dispose();
    this.chunks.delete(key);
    this.chunkList = this.chunkList.filter((record) => record !== existing);
    const region = existing.region;
    region.chunks.delete(key);
    region.showSets();
    if (region.chunks.size === 0) {
      this.scene.remove(region.root, region.casterRoot);
      region.dispose();
      for (const [regionKey, candidate] of this.regions) {
        if (candidate === region) this.regions.delete(regionKey);
      }
      this.regionList = this.regionList.filter((candidate) => candidate !== region);
      return;
    }
    region.bounds.makeEmpty();
    for (const remainingKey of region.chunks) {
      const remaining = this.chunks.get(remainingKey);
      if (remaining) region.bounds.union(remaining.bounds);
    }
  }

  private visibleStyle(): BatchStyle {
    return { layer: null, castShadow: false, receiveShadow: this.look.shadows };
  }

  private casterStyle(): BatchStyle {
    return { layer: SHADOW_LAYER, castShadow: true, receiveShadow: false };
  }

  private regionFor(originX: number, originZ: number): RegionBatches {
    const regionX = Math.floor(chunkOf(originX) / REGION_CHUNKS);
    const regionZ = Math.floor(chunkOf(originZ) / REGION_CHUNKS);
    const key = chunkKey(regionX, regionZ);
    let region = this.regions.get(key);
    if (!region) {
      region = new RegionBatches(
        regionX * REGION_CHUNKS * CHUNK_LDU,
        regionZ * REGION_CHUNKS * CHUNK_LDU,
        this.visibleStyle(),
        this.casterStyle(),
      );
      this.regions.set(key, region);
      this.regionList.push(region);
      this.placeRegion(region);
      this.scene.add(region.root, region.casterRoot);
    }
    return region;
  }

  private placeRegion(region: RegionBatches): void {
    for (const root of [region.root, region.casterRoot]) {
      root.position.set(
        region.originX - this.renderOriginX,
        0,
        region.originZ - this.renderOriginZ,
      );
      root.updateMatrix();
      root.updateMatrixWorld(true);
    }
  }

  private batchChunk(key: number, chunk: ChunkInstances): BatchedChunk {
    const region = this.regionFor(chunk.originX, chunk.originZ);
    region.chunks.add(key);
    const parts = partOrder(chunk.partIndex, chunk.count, this.detailedLevel.parts.length);
    const studs = partOrder(
      chunk.studs.primitiveIndex,
      chunk.studs.count,
      this.detailedLevel.studs.length,
    );
    const offsetX = chunk.originX - region.originX;
    const offsetZ = chunk.originZ - region.originZ;
    const detailed = this.fillDetailed(
      region.near,
      chunk,
      parts,
      studs,
      offsetX,
      offsetZ,
      this.materials,
    );
    const shellSet = this.tiered ? region.shell() : null;
    const shells = shellSet ? this.fillShells(shellSet, chunk, parts, offsetX, offsetZ) : NO_SHELLS;
    const coarse = shellSet
      ? this.fillStuds(shellSet, chunk, this.farLevel, studs, offsetX, offsetZ, this.materials)
      : EMPTY_GROUP;
    const casterSet = this.look.shadows ? region.casters() : null;
    const casters = casterSet
      ? this.fillCasters(casterSet, chunk, parts, offsetX, offsetZ)
      : EMPTY_GROUP;
    const bounds = this.chunkBounds(chunk);
    region.bounds.union(bounds);
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
    const record = new BatchedChunk(
      region,
      shellSet,
      casterSet,
      detailed,
      shells,
      coarse,
      casters,
      minX,
      maxX,
      minZ,
      maxZ,
      bounds,
    );
    record.show(TIER_NEAR, false);
    return record;
  }

  private chunkBounds(chunk: ChunkInstances): Box3 {
    const bounds = new Box3();
    const grow = (matrices: Float32Array, i: number, radius: number): void => {
      const o = i * INSTANCE_MATRIX_FLOATS;
      const x = chunk.originX + (matrices[o + 3] ?? 0);
      const y = matrices[o + 7] ?? 0;
      const z = chunk.originZ + (matrices[o + 11] ?? 0);
      bounds.expandByPoint(this.rayPoint.set(x - radius, y - radius, z - radius));
      bounds.expandByPoint(this.rayPoint.set(x + radius, y + radius, z + radius));
    };
    for (let i = 0; i < chunk.count; i++) {
      grow(chunk.matrices, i, this.partReach(chunk.partIndex[i] ?? 0));
    }
    for (let i = 0; i < chunk.studs.count; i++) {
      const stud = this.detailedLevel.studs[chunk.studs.primitiveIndex[i] ?? 0];
      grow(chunk.studs.matrices, i, stud?.boundingSphere?.radius ?? 0);
    }
    return bounds;
  }

  private partReach(part: number): number {
    const o = part * BOUNDS_FLOATS;
    let reach = 0;
    for (let axis = 0; axis < 3; axis++) {
      const extent = Math.max(
        Math.abs(this.partBounds[o + axis] ?? 0),
        Math.abs(this.partBounds[o + 3 + axis] ?? 0),
      );
      reach += extent * extent;
    }
    return Math.sqrt(reach);
  }

  private offsetMatrix(
    matrices: Float32Array,
    i: number,
    offsetX: number,
    offsetZ: number,
  ): Matrix4 {
    writeMatrix4(matrices, i, this.scratchElements, 0);
    this.scratchElements[12] = (this.scratchElements[12] ?? 0) + offsetX;
    this.scratchElements[14] = (this.scratchElements[14] ?? 0) + offsetZ;
    return this.scratchMatrix.fromArray(this.scratchElements);
  }

  private linearColor(colorIndex: number): Color {
    const c = colorIndex * COLOR_CHANNELS;
    return this.scratchColor.setRGB(
      this.linearColors[c] ?? 0,
      this.linearColors[c + 1] ?? 0,
      this.linearColors[c + 2] ?? 0,
    );
  }

  private alphaOf(colorIndex: number): number {
    return this.alphaSlots[this.colorAlphaSlot[colorIndex] ?? 0] ?? OPAQUE_ALPHA;
  }

  private addPart(
    set: BatchSet,
    geometries: PartGeometries | undefined,
    chunk: ChunkInstances,
    i: number,
    offsetX: number,
    offsetZ: number,
    materials: PlasticMaterials,
    out: GroupBuilder,
  ): void {
    if (!geometries) return;
    const colorIndex = chunk.colorIndex[i] ?? 0;
    if (geometries.body) {
      set.add(
        materials.instanceColored(this.alphaOf(colorIndex)),
        geometries.body,
        this.offsetMatrix(chunk.matrices, i, offsetX, offsetZ),
        this.linearColor(colorIndex),
        out,
      );
    }
    for (const fixed of geometries.fixed) {
      set.add(
        materials.vertexColored(fixed.alpha),
        fixed.geometry,
        this.offsetMatrix(chunk.matrices, i, offsetX, offsetZ),
        null,
        out,
      );
    }
  }

  private fillDetailed(
    set: BatchSet,
    chunk: ChunkInstances,
    parts: Uint32Array,
    studs: Uint32Array,
    offsetX: number,
    offsetZ: number,
    materials: PlasticMaterials,
  ): InstanceGroup {
    set.prepare();
    const out = new GroupBuilder();
    for (let n = 0; n < chunk.count; n++) {
      const i = parts[n] ?? 0;
      const geometries = this.detailedLevel.parts[chunk.partIndex[i] ?? 0];
      this.addPart(set, geometries, chunk, i, offsetX, offsetZ, materials, out);
    }
    this.addStuds(set, chunk, this.detailedLevel, studs, offsetX, offsetZ, materials, out);
    return out.build();
  }

  private fillShells(
    set: BatchSet,
    chunk: ChunkInstances,
    parts: Uint32Array,
    offsetX: number,
    offsetZ: number,
  ): ShellGroups {
    set.prepare();
    const shell = new GroupBuilder();
    const midShell = new GroupBuilder();
    for (let n = 0; n < chunk.count; n++) {
      const i = parts[n] ?? 0;
      const level = isUpright(chunk.matrices, i) ? this.farLevel : this.detailedLevel;
      const out = (chunk.voxelized?.[i] ?? 0) !== 0 ? midShell : shell;
      const geometries = level.parts[chunk.partIndex[i] ?? 0];
      this.addPart(set, geometries, chunk, i, offsetX, offsetZ, this.materials, out);
    }
    return { shell: shell.build(), midShell: midShell.build() };
  }

  private fillStuds(
    set: BatchSet,
    chunk: ChunkInstances,
    level: LevelGeometries,
    studs: Uint32Array,
    offsetX: number,
    offsetZ: number,
    materials: PlasticMaterials,
  ): InstanceGroup {
    set.prepare();
    const out = new GroupBuilder();
    this.addStuds(set, chunk, level, studs, offsetX, offsetZ, materials, out);
    return out.build();
  }

  private addStuds(
    set: BatchSet,
    chunk: ChunkInstances,
    level: LevelGeometries,
    studs: Uint32Array,
    offsetX: number,
    offsetZ: number,
    materials: PlasticMaterials,
    out: GroupBuilder,
  ): void {
    const source = chunk.studs;
    for (let n = 0; n < source.count; n++) {
      const i = studs[n] ?? 0;
      const geometry = level.studs[source.primitiveIndex[i] ?? 0];
      if (!geometry) continue;
      const colorIndex = source.colorIndex[i] ?? 0;
      set.add(
        materials.instanceColored(this.alphaOf(colorIndex)),
        geometry,
        this.offsetMatrix(source.matrices, i, offsetX, offsetZ),
        this.linearColor(colorIndex),
        out,
      );
    }
  }

  private fillCasters(
    set: BatchSet,
    chunk: ChunkInstances,
    parts: Uint32Array,
    offsetX: number,
    offsetZ: number,
  ): InstanceGroup {
    set.prepare();
    const out = new GroupBuilder();
    const opaque = this.materials.instanceColored(OPAQUE_ALPHA);
    const opaqueFixed = this.materials.vertexColored(OPAQUE_ALPHA);
    for (let n = 0; n < chunk.count; n++) {
      const i = parts[n] ?? 0;
      if (this.alphaOf(chunk.colorIndex[i] ?? 0) !== OPAQUE_ALPHA) continue;
      if (this.tiered) {
        set.add(
          opaque,
          this.unitBox,
          this.boundsProxyMatrix(chunk, i, offsetX, offsetZ),
          null,
          out,
        );
        continue;
      }
      const geometries = this.detailedLevel.parts[chunk.partIndex[i] ?? 0];
      if (!geometries) continue;
      if (geometries.body) {
        set.add(
          opaque,
          geometries.body,
          this.offsetMatrix(chunk.matrices, i, offsetX, offsetZ),
          null,
          out,
        );
      }
      for (const fixed of geometries.fixed) {
        if (fixed.alpha !== OPAQUE_ALPHA) continue;
        set.add(
          opaqueFixed,
          fixed.geometry,
          this.offsetMatrix(chunk.matrices, i, offsetX, offsetZ),
          null,
          out,
        );
      }
    }
    return out.build();
  }

  private boundsProxyMatrix(
    chunk: ChunkInstances,
    i: number,
    offsetX: number,
    offsetZ: number,
  ): Matrix4 {
    const m = chunk.matrices;
    const b = this.partBounds;
    const s = i * INSTANCE_MATRIX_FLOATS;
    const o = (chunk.partIndex[i] ?? 0) * BOUNDS_FLOATS;
    const t = this.scratchElements;
    for (let axis = 0; axis < 3; axis++) {
      const size = (b[o + 3 + axis] ?? 0) - (b[o + axis] ?? 0);
      t[axis * 4] = (m[s + axis] ?? 0) * size;
      t[axis * 4 + 1] = (m[s + 4 + axis] ?? 0) * size;
      t[axis * 4 + 2] = (m[s + 8 + axis] ?? 0) * size;
      t[axis * 4 + 3] = 0;
    }
    for (let row = 0; row < 3; row++) {
      let centre = m[s + row * 4 + 3] ?? 0;
      for (let axis = 0; axis < 3; axis++) {
        const mid = ((b[o + axis] ?? 0) + (b[o + 3 + axis] ?? 0)) / 2;
        centre += (m[s + row * 4 + axis] ?? 0) * mid;
      }
      t[12 + row] = centre;
    }
    t[12] = (t[12] ?? 0) + offsetX;
    t[14] = (t[14] ?? 0) + offsetZ;
    t[15] = 1;
    return this.scratchMatrix.fromArray(t);
  }

  setGhost(model: ChunkInstances | null): void {
    const set = this.ghostSet;
    if (set) {
      set.releaseGroup(this.ghostGroup);
      this.ghostGroup = EMPTY_GROUP;
      set.root.visible = false;
    }
    this.ghost = undefined;
    if (!model) return;
    const ghost = set ?? this.createGhostSet();
    const parts = partOrder(model.partIndex, model.count, this.detailedLevel.parts.length);
    const studs = partOrder(
      model.studs.primitiveIndex,
      model.studs.count,
      this.detailedLevel.studs.length,
    );
    this.ghostGroup = this.fillDetailed(ghost, model, parts, studs, 0, 0, this.ghostMaterials);
    this.ghost = ghost.root;
  }

  private createGhostSet(): BatchSet {
    const set = new BatchSet({ layer: null, castShadow: false, receiveShadow: false });
    set.root.visible = false;
    this.ghostSet = set;
    this.scene.add(set.root);
    return set;
  }

  private disposeGhostSet(): void {
    const set = this.ghostSet;
    if (!set) return;
    this.scene.remove(set.root);
    set.dispose();
    this.ghostSet = undefined;
    this.ghostGroup = EMPTY_GROUP;
    this.ghost = undefined;
  }

  placeGhost(x: number, yLdu: number, z: number, rot: number): void {
    const ghost = this.ghost;
    if (!ghost) return;
    this.ghostX = x;
    this.ghostZ = z;
    ghost.position.set(x - this.renderOriginX, yLdu, z - this.renderOriginZ);
    ghost.rotation.set(0, rot * QUARTER_TURN_RADIANS, 0);
    ghost.updateMatrix();
    ghost.updateMatrixWorld(true);
    ghost.visible = true;
  }

  setSelectionBox(box: WorldBox | null): void {
    if (!box) {
      this.selection.visible = false;
      return;
    }
    this.selectionCentreX = (box.minX + box.maxX) / 2;
    this.selectionCentreZ = (box.minZ + box.maxZ) / 2;
    this.selection.position.set(
      this.selectionCentreX - this.renderOriginX,
      (box.minY + box.maxY) / 2,
      this.selectionCentreZ - this.renderOriginZ,
    );
    this.selection.scale.set(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
    this.selection.updateMatrix();
    this.selection.updateMatrixWorld(true);
    this.selection.visible = true;
  }

  setMarkers(markers: ReadonlyArray<EdgeMarker>): void {
    this.markerGroup.clear();
    this.markers = markers;
    for (const marker of markers) {
      const mesh = new Mesh(this.markerBox, this.markerMaterials[marker.kind]);
      mesh.matrixAutoUpdate = false;
      this.markerGroup.add(mesh);
    }
    this.positionMarkers();
  }

  private positionMarkers(): void {
    const meshes = this.markerGroup.children;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      const marker = this.markers[i];
      if (!mesh || !marker) continue;
      const { box } = marker;
      mesh.position.set(
        (box.minX + box.maxX) / 2 - this.renderOriginX,
        (box.minY + box.maxY) / 2,
        (box.minZ + box.maxZ) / 2 - this.renderOriginZ,
      );
      mesh.scale.set(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
      mesh.updateMatrix();
    }
    this.markerGroup.updateMatrixWorld(true);
  }

  setTrackEnds(markers: ReadonlyArray<TrackEndMarker>): void {
    this.trackEndGroup.clear();
    this.trackEnds = markers;
    for (const marker of markers) {
      const material = this.trackEndMaterials[marker.kind];
      const arrow = new Group();
      arrow.matrixAutoUpdate = false;
      arrow.renderOrder = 3;
      const head = new Mesh(this.trackEndArrow, material);
      const post = new Mesh(this.trackEndPost, material);
      head.renderOrder = 3;
      post.renderOrder = 3;
      arrow.add(head, post);
      this.trackEndGroup.add(arrow);
    }
    this.positionTrackEnds();
  }

  private positionTrackEnds(): void {
    const arrows = this.trackEndGroup.children;
    for (let i = 0; i < arrows.length; i++) {
      const arrow = arrows[i];
      const marker = this.trackEnds[i];
      if (!arrow || !marker) continue;
      arrow.position.set(
        marker.xLdu - this.renderOriginX,
        marker.yLdu,
        marker.zLdu - this.renderOriginZ,
      );
      arrow.rotation.set(0, -marker.headingRadians, 0);
      arrow.updateMatrix();
    }
    this.trackEndGroup.updateMatrixWorld(true);
  }

  setPlanOverlays(overlays: ReadonlyArray<PlanOverlay>): void {
    for (const anchored of this.planObjects) {
      this.scene.remove(anchored.object);
      disposeTree(anchored.object);
    }
    this.planObjects = overlays.map((overlay) => this.planGroup(overlay));
    for (const anchored of this.planObjects) {
      this.positionAnchored(anchored);
      this.scene.add(anchored.object);
    }
  }

  private planGroup(overlay: PlanOverlay): Anchored {
    const { room } = overlay;
    const x = room.minX;
    const z = room.minZ;
    const group = new Group();
    group.matrixAutoUpdate = false;
    const floor = boxMesh(
      { ...room, minY: room.minY - FLOOR_THICKNESS_LDU },
      x,
      z,
      new MeshStandardNodeMaterial({
        color: overlay.active ? FLOOR_COLOR : INACTIVE_FLOOR_COLOR,
        roughness: 1,
      }),
    );
    const outlineY = room.maxY + GRID_LIFT_LDU;
    const w = room.maxX - x;
    const d = room.maxZ - z;
    group.add(
      floor,
      lineSegments(
        [
          0,
          outlineY,
          0,
          w,
          outlineY,
          0,
          w,
          outlineY,
          0,
          w,
          outlineY,
          d,
          w,
          outlineY,
          d,
          0,
          outlineY,
          d,
          0,
          outlineY,
          d,
          0,
          outlineY,
          0,
        ],
        ROOM_OUTLINE_COLOR,
      ),
    );
    const tableMaterial = new MeshStandardNodeMaterial({ color: TABLE_COLOR, roughness: 0.8 });
    const grid: number[] = [];
    for (const table of overlay.tables) {
      group.add(boxMesh(table, x, z, tableMaterial));
      grid.push(...gridLines(table, x, z, room.minX, room.minZ, overlay.gridStepLdu));
    }
    if (grid.length > 0) group.add(lineSegments(grid, TABLE_GRID_COLOR));
    const obstacleMaterial = new MeshStandardNodeMaterial({
      color: OBSTACLE_COLOR,
      transparent: true,
      opacity: OBSTACLE_OPACITY,
      depthWrite: false,
    });
    for (const obstacle of overlay.obstacles) group.add(boxMesh(obstacle, x, z, obstacleMaterial));
    for (const child of group.children) child.updateMatrix();
    return { object: group, x, z };
  }

  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void {
    for (const anchored of this.issueObjects) this.scene.remove(anchored.object);
    this.issueObjects = boxes.map((box) => {
      const lines = new LineSegments(this.issueEdges, this.issueMaterial);
      lines.matrixAutoUpdate = false;
      lines.renderOrder = 2;
      lines.scale.set(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
      lines.position.y = (box.minY + box.maxY) / 2;
      return { object: lines, x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2 };
    });
    for (const anchored of this.issueObjects) {
      this.positionAnchored(anchored);
      this.scene.add(anchored.object);
    }
  }

  private positionAnchored(anchored: Anchored): void {
    const { object } = anchored;
    object.position.set(
      anchored.x - this.renderOriginX,
      object.position.y,
      anchored.z - this.renderOriginZ,
    );
    object.updateMatrix();
    object.updateMatrixWorld(true);
  }

  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    const camera = this.camera;
    if (camera === this.orthographic) {
      this.rayPoint.set(ndcX, ndcY, -1).unproject(camera);
      out[0] = this.rayPoint.x + this.renderOriginX;
      out[1] = this.rayPoint.y;
      out[2] = this.rayPoint.z + this.renderOriginZ;
      camera.getWorldDirection(this.rayPoint);
    } else {
      this.rayPoint.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
      out[0] = camera.position.x + this.renderOriginX;
      out[1] = camera.position.y;
      out[2] = camera.position.z + this.renderOriginZ;
    }
    out[3] = this.rayPoint.x;
    out[4] = this.rayPoint.y;
    out[5] = this.rayPoint.z;
  }

  private clearChunks(): void {
    for (const key of this.chunks.keys()) this.removeChunk(key);
    for (const vehicle of this.vehicles.keys()) this.removeVehicle(vehicle);
  }

  setView(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    atX: number,
    atY: number,
    atZ: number,
    orthoHalfHeightLdu?: number,
  ): void {
    if (eyeX !== this.eyeX || eyeY !== this.eyeY || eyeZ !== this.eyeZ) {
      this.eyeMovedAt = performance.now();
    }
    this.eyeX = eyeX;
    this.eyeY = eyeY;
    this.eyeZ = eyeZ;
    this.followEye();
    this.camera = orthoHalfHeightLdu === undefined ? this.perspective : this.orthographic;
    if (orthoHalfHeightLdu !== undefined && orthoHalfHeightLdu !== this.orthoHalfHeight) {
      this.orthoHalfHeight = orthoHalfHeightLdu;
      this.fitOrthographic();
    }
    this.aim(this.perspective, eyeX, eyeY, eyeZ, atX, atY, atZ);
    this.aim(this.orthographic, eyeX, eyeY, eyeZ, atX, atY, atZ);
    this.fitShadowRange();
  }

  private aim(
    camera: PerspectiveCamera | OrthographicCamera,
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    atX: number,
    atY: number,
    atZ: number,
  ): void {
    camera.position.set(eyeX - this.renderOriginX, eyeY, eyeZ - this.renderOriginZ);
    camera.lookAt(atX - this.renderOriginX, atY, atZ - this.renderOriginZ);
    camera.updateMatrixWorld();
  }

  private fitShadowRange(): void {
    const shadowNode = this.shadowNode;
    if (!shadowNode || this.chunkList.length === 0) return;
    const dx = Math.max(Math.abs(this.sceneMinX - this.eyeX), Math.abs(this.sceneMaxX - this.eyeX));
    const dz = Math.max(Math.abs(this.sceneMinZ - this.eyeZ), Math.abs(this.sceneMaxZ - this.eyeZ));
    const needed = Math.max(Math.hypot(dx, dz, this.eyeY), SHADOW_MIN_FAR_LDU);
    const fits = needed <= this.shadowFar && needed * SHADOW_FAR_HYSTERESIS >= this.shadowFar;
    if (fits) return;
    this.shadowFar = needed * SHADOW_FAR_HYSTERESIS;
    shadowNode.maxFar = this.shadowFar;
    const depthRange = SHADOW_LIGHT_MARGIN_LDU + 2 * this.shadowFar;
    this.sun.shadow.camera.far = depthRange;
    for (const cascade of shadowNode.lights) {
      if (cascade.shadow) cascade.shadow.camera.far = depthRange;
    }
    if (shadowNode.camera !== null) shadowNode.updateFrustums();
  }

  private fitOrthographic(): void {
    const camera = this.orthographic;
    camera.top = this.orthoHalfHeight;
    camera.bottom = -this.orthoHalfHeight;
    camera.right = this.orthoHalfHeight * this.aspect;
    camera.left = -camera.right;
    camera.updateProjectionMatrix();
  }

  private followEye(): void {
    const chunkX = chunkOf(this.eyeX);
    const chunkZ = chunkOf(this.eyeZ);
    const originChunkX = this.renderOriginX / CHUNK_LDU;
    const originChunkZ = this.renderOriginZ / CHUNK_LDU;
    const atEye = chunkX === originChunkX && chunkZ === originChunkZ;
    const far =
      Math.abs(chunkX - originChunkX) > REBASE_DISTANCE_CHUNKS ||
      Math.abs(chunkZ - originChunkZ) > REBASE_DISTANCE_CHUNKS;
    const settled = performance.now() - this.eyeMovedAt >= SETTLED_EYE_MS;
    if (this.rebaseCount > 0 && !far && (atEye || !settled)) return;
    const started = performance.now();
    this.renderOriginX = chunkX * CHUNK_LDU;
    this.renderOriginZ = chunkZ * CHUNK_LDU;
    for (let r = 0; r < this.regionList.length; r++) {
      const region = this.regionList[r];
      if (region) this.placeRegion(region);
    }
    for (let i = 0; i < this.farModelList.length; i++) {
      const node = this.farModelList[i];
      if (!node) continue;
      node.group.position.set(
        node.originX - this.renderOriginX,
        0,
        node.originZ - this.renderOriginZ,
      );
      node.group.updateMatrix();
      node.group.updateMatrixWorld(true);
    }
    for (let i = 0; i < this.superList.length; i++) {
      const record = this.superList[i];
      if (record) this.placeSuperChunk(record);
    }
    const ghost = this.ghost;
    if (ghost) {
      ghost.position.set(
        this.ghostX - this.renderOriginX,
        ghost.position.y,
        this.ghostZ - this.renderOriginZ,
      );
      ghost.updateMatrix();
      ghost.updateMatrixWorld(true);
    }
    this.selection.position.set(
      this.selectionCentreX - this.renderOriginX,
      this.selection.position.y,
      this.selectionCentreZ - this.renderOriginZ,
    );
    this.selection.updateMatrix();
    this.selection.updateMatrixWorld(true);
    for (const record of this.vehicles.values()) this.placeVehicle(record);
    this.positionMarkers();
    this.positionTrackEnds();
    for (const anchored of this.planObjects) this.positionAnchored(anchored);
    for (const anchored of this.issueObjects) this.positionAnchored(anchored);
    if (this.rebases.length === REBASE_LOG_LIMIT) this.rebases.shift();
    this.rebaseCount++;
    this.rebases.push({
      frame: this.frame,
      chunkX,
      chunkZ,
      chunks: this.chunkList.length,
      ms: performance.now() - started,
    });
  }

  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return this.rebases;
  }

  resize(width: number, height: number): void {
    this.renderer?.setSize(width, height, false);
    this.aspect = width / Math.max(height, 1);
    this.perspective.aspect = this.aspect;
    this.perspective.updateProjectionMatrix();
    this.fitOrthographic();
    const bufferWidth = this.renderer?.domElement.width ?? width;
    const bufferHeight = this.renderer?.domElement.height ?? height;
    this.focalLengthPx = bufferHeight / (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360));
    this.pipeline?.resize(bufferWidth, bufferHeight, this.focalLengthPx);
    if (this.shadowNode?.camera) this.shadowNode.updateFrustums();
  }

  setFarModel(id: number, placement: FarModelPlacement | null): void {
    const existing = this.farModelNodes.get(id);
    if (existing) {
      this.scene.remove(existing.group);
      for (const mesh of existing.meshes) releaseRenderObjects(mesh);
      this.farModelNodes.delete(id);
      this.farModelList = this.farModelList.filter((node) => node !== existing);
    }
    if (!placement) return;
    const geometries = this.farModelGeometries[placement.modelIndex];
    if (!geometries) throw new Error(`far model ${placement.modelIndex} is not in the palette`);
    const group = new Group();
    group.matrixAutoUpdate = false;
    group.position.set(
      placement.originX - this.renderOriginX,
      0,
      placement.originZ - this.renderOriginZ,
    );
    group.updateMatrix();
    const meshes: DisposableMesh[] = [];
    writeMatrix4(placement.matrix, 0, this.farModelMatrix, 0);
    for (const fixed of geometries) {
      const material = this.materials.vertexColored(fixed.alpha);
      const mesh: DisposableMesh = new Mesh(fixed.geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(this.farModelMatrix);
      mesh.receiveShadow = this.look.shadows && !material.transparent;
      group.add(mesh);
      meshes.push(mesh);
    }
    group.updateMatrixWorld(true);
    group.visible = false;
    const node = new FarModelNode(group, meshes, placement.originX, placement.originZ, [
      ...placement.chunkKeys,
    ]);
    this.farModelNodes.set(id, node);
    this.farModelList.push(node);
    this.scene.add(group);
  }

  private showFarModels(): void {
    for (let n = 0; n < this.farModelList.length; n++) {
      const node = this.farModelList[n];
      if (!node) continue;
      let anyFar = false;
      for (let k = 0; k < node.chunkKeys.length; k++) {
        const record = this.chunks.get(node.chunkKeys[k] ?? 0);
        if (record?.tier === TIER_FAR) anyFar = true;
      }
      node.group.visible = this.tiered && anyFar;
    }
  }

  forceTier(tier: ChunkTier | null): void {
    this.forcedTier = tier === null ? null : TIER_BY_NAME[tier];
  }

  private assignTiers(out: FrameStats): void {
    let near = 0;
    let mid = 0;
    let far = 0;
    const orthographic = this.camera === this.orthographic;
    const orthoStudPitchPx = this.orthoStudPitchPx();
    let nearestStudPitchPx = 0;
    for (let i = 0; i < this.chunkList.length; i++) {
      const record = this.chunkList[i];
      if (!record) continue;
      const dx = Math.max(record.minX - this.eyeX, 0, this.eyeX - record.maxX);
      const dz = Math.max(record.minZ - this.eyeZ, 0, this.eyeZ - record.maxZ);
      const distance = Math.max(Math.hypot(dx, this.eyeY, dz), CAMERA_NEAR_LDU);
      const studPitchPx = orthographic
        ? orthoStudPitchPx
        : (STUD_PITCH_LDU * this.focalLengthPx) / distance;
      nearestStudPitchPx = Math.max(nearestStudPitchPx, studPitchPx);
      let tier: number;
      if (!this.tiered) tier = TIER_NEAR;
      else if (this.forcedTier !== null) tier = this.forcedTier;
      else if (studPitchPx >= NEAR_MIN_STUD_PITCH_PX) tier = TIER_NEAR;
      else if (studPitchPx >= MID_MIN_STUD_PITCH_PX) tier = TIER_MID;
      else tier = TIER_FAR;
      record.show(tier, !this.inFrustum(record.bounds));
      if (tier === TIER_NEAR) near++;
      else if (tier === TIER_MID) mid++;
      else far++;
    }
    out.nearChunks = near;
    out.midChunks = mid;
    out.farChunks = far;
    out.nearestStudPitchPx = nearestStudPitchPx;
    this.showFarModels();
  }

  private updateFrustum(): void {
    const camera = this.camera;
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection, camera.coordinateSystem);
  }

  private inFrustum(bounds: Box3): boolean {
    const box = this.cullBox.copy(bounds);
    box.min.x -= this.renderOriginX;
    box.max.x -= this.renderOriginX;
    box.min.z -= this.renderOriginZ;
    box.max.z -= this.renderOriginZ;
    return this.frustum.intersectsBox(box);
  }

  private cullRegions(): void {
    for (let r = 0; r < this.regionList.length; r++) {
      const region = this.regionList[r];
      if (region) region.root.visible = this.inFrustum(region.bounds);
    }
  }

  bufferMemory(): BufferMemory {
    return this.bufferTally.snapshot();
  }

  renderFrame(out: FrameStats): void {
    const renderer = this.renderer;
    if (!renderer) throw new Error("ThreeSceneBackend.renderFrame called before init");
    this.throwIfFailed();
    this.updateFrustum();
    this.assignTiers(out);
    this.cullRegions();
    renderer.info.reset();
    if (this.pipeline && this.camera === this.perspective) this.pipeline.render();
    else renderer.render(this.scene, this.camera);
    out.drawCalls = renderer.info.render.drawCalls;
    out.triangles = renderer.info.render.triangles;
    out.renderOriginChunkX = this.renderOriginX / CHUNK_LDU;
    out.renderOriginChunkZ = this.renderOriginZ / CHUNK_LDU;
    out.rebaseCount = this.rebaseCount;
    let visibleSuperChunks = 0;
    for (let i = 0; i < this.superList.length; i++) {
      if (this.superList[i]?.group.visible) visibleSuperChunks++;
    }
    out.superChunks = visibleSuperChunks;
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
