import { injectable } from "inversify";
import {
  BoxGeometry,
  BufferGeometry as LineGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  DirectionalLight,
  EdgesGeometry,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicNodeMaterial,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGPURenderer,
  type BufferGeometry,
  MeshStandardNodeMaterial,
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
  type GhostCue,
  type GhostFootprint,
  type GhostTone,
  type ISceneBackend,
  type LookSettings,
  type PartPalette,
  type PlanOverlay,
  type RebaseEvent,
  type SceneBackendConfig,
  type SnapTarget,
  type StudInstances,
  type TrackEndKind,
  type TrackEndMarker,
  type WorldBox,
} from "../scene-backend.ts";
import { CHUNK_LDU, chunkOf } from "@brr/math";
import { GhostEffects } from "./ghost-effects.ts";
import { GpuBufferTally } from "./gpu-buffer-tally.ts";
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
const CLASS_NOT_UPRIGHT = 1;
const CLASS_VOXELIZED = 2;
const INSTANCE_CLASSES = 4;
const GHOST_OPACITY = 0.55;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const SELECTION_COLOR = 0xff8c00;
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

function disposeInstancedChildren(layer: Group): void {
  for (const child of layer.children) {
    if (child instanceof InstancedMesh) child.dispose();
  }
}

interface TierLayers {
  readonly shellBodies: Group;
  readonly midShells: Group;
  readonly coarseStuds: Group;
}

interface InstanceAttributes {
  readonly matrices: InstancedBufferAttribute;
  readonly colors: InstancedBufferAttribute;
}

interface InstanceKeys {
  readonly keys: Uint32Array;
  readonly counts: Uint32Array;
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

function classKeys(alphaKeys: Uint32Array, chunk: ChunkInstances): Uint32Array {
  const keys = new Uint32Array(chunk.count);
  for (let i = 0; i < chunk.count; i++) {
    const voxelized = (chunk.voxelized?.[i] ?? 0) !== 0 ? CLASS_VOXELIZED : 0;
    const notUpright = isUpright(chunk.matrices, i) ? 0 : CLASS_NOT_UPRIGHT;
    keys[i] = (alphaKeys[i] ?? 0) * INSTANCE_CLASSES + (voxelized | notUpright);
  }
  return keys;
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
    readonly midShells: Group,
    readonly coarseStuds: Group,
    readonly shadowCasters: Group,
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
    this.midShells.visible = tier === TIER_MID;
    this.coarseStuds.visible = tier === TIER_MID;
  }

  layers(): ReadonlyArray<Group> {
    return [this.detailed, this.shellBodies, this.midShells, this.coarseStuds, this.shadowCasters];
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
    readonly body: ChunkRecord,
  ) {}
}

class FarModelNode {
  constructor(
    readonly group: Group,
    readonly originX: number,
    readonly originZ: number,
    readonly chunkKeys: ReadonlyArray<number>,
  ) {}
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
  private ghost: Group | undefined;
  private readonly ghostEffects = new GhostEffects(this.ghostMaterials);
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
  private readonly chunks = new Map<number, ChunkRecord>();
  private readonly vehicles = new Map<number, VehicleRecord>();
  private chunkList: ChunkRecord[] = [];
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
    this.ghostEffects.useMaterials(this.ghostMaterials);
    this.watchReducedMotion();
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
    this.scene.add(this.ghostEffects.root);
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

  private watchReducedMotion(): void {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(REDUCED_MOTION_QUERY);
    this.ghostEffects.setReducedMotion(query.matches);
    query.addEventListener("change", (event) => this.ghostEffects.setReducedMotion(event.matches));
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
    for (const node of this.farModelList) this.scene.remove(node.group);
    this.farModelNodes.clear();
    this.farModelList = [];
    this.setGhost(null);
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
    const record = this.buildChunk(chunk);
    this.chunks.set(key, record);
    this.chunkList.push(record);
    this.scene.add(record.group);
    this.sceneMinX = Math.min(this.sceneMinX, record.minX);
    this.sceneMaxX = Math.max(this.sceneMaxX, record.maxX);
    this.sceneMinZ = Math.min(this.sceneMinZ, record.minZ);
    this.sceneMaxZ = Math.max(this.sceneMaxZ, record.maxZ);
  }

  setVehicle(vehicle: number, model: ChunkInstances): void {
    this.removeVehicle(vehicle);
    const body = this.buildChunk({
      ...model,
      originX: this.renderOriginX,
      originZ: this.renderOriginZ,
    });
    const group = new Group();
    group.add(body.group);
    const record = new VehicleRecord(group, body);
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
    disposeInstancedChildren(existing.body.detailed);
    disposeInstancedChildren(existing.body.shellBodies);
    disposeInstancedChildren(existing.body.coarseStuds);
    this.vehicles.delete(vehicle);
  }

  deleteChunk(key: number): void {
    this.removeChunk(key);
  }

  private removeChunk(key: number): void {
    const existing = this.chunks.get(key);
    if (!existing) return;
    this.scene.remove(existing.group);
    for (const layer of existing.layers()) disposeInstancedChildren(layer);
    this.chunks.delete(key);
    this.chunkList = this.chunkList.filter((record) => record !== existing);
  }

  setGhost(model: ChunkInstances | null, footprint?: GhostFootprint): void {
    if (this.ghost) {
      this.scene.remove(this.ghost);
      disposeInstancedChildren(this.ghost);
      this.ghost = undefined;
    }
    if (!model) {
      this.ghostEffects.attach(undefined, undefined);
      return;
    }
    const ghost = new Group();
    ghost.matrixAutoUpdate = false;
    ghost.visible = false;
    this.addInstances(ghost, undefined, undefined, model, this.ghostMaterials);
    this.ghost = ghost;
    this.ghostEffects.attach(ghost, footprint);
    this.scene.add(ghost);
  }

  placeGhost(x: number, yLdu: number, z: number, rot: number): void {
    if (!this.ghost) return;
    const now = performance.now();
    this.ghostEffects.place(x, yLdu, z, rot, now);
    this.ghostEffects.animate(now, this.camera);
  }

  setGhostTone(tone: GhostTone): void {
    this.ghostEffects.setTone(tone);
  }

  cueGhost(cue: GhostCue): void {
    this.ghostEffects.play(cue, performance.now());
  }

  setSnapTargets(targets: ReadonlyArray<SnapTarget>): void {
    this.ghostEffects.setTargets(targets);
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

  private buildChunk(chunk: ChunkInstances): ChunkRecord {
    const group = new Group();
    group.position.set(chunk.originX - this.renderOriginX, 0, chunk.originZ - this.renderOriginZ);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const detailed = new Group();
    const shellBodies = new Group();
    const midShells = new Group();
    const coarseStuds = new Group();
    const shadowCasters = this.look.shadows ? new Group() : undefined;
    group.add(detailed, shellBodies, midShells, coarseStuds);
    if (shadowCasters) group.add(shadowCasters);
    this.addInstances(
      detailed,
      { shellBodies, midShells, coarseStuds },
      shadowCasters,
      chunk,
      this.materials,
    );
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    const extend = (matrices: Float32Array, count: number): void => {
      for (let i = 0; i < count; i++) {
        const x = chunk.originX + (matrices[i * INSTANCE_MATRIX_FLOATS + 3] ?? 0);
        const z = chunk.originZ + (matrices[i * INSTANCE_MATRIX_FLOATS + 11] ?? 0);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    };
    extend(chunk.matrices, chunk.count);
    group.updateMatrixWorld(true);
    const record = new ChunkRecord(
      group,
      detailed,
      shellBodies,
      midShells,
      coarseStuds,
      shadowCasters ?? new Group(),
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

  private keyInstances(
    select: ArrayLike<number>,
    colorIndex: Uint16Array,
    total: number,
    selectCount: number,
  ): InstanceKeys {
    const slots = this.alphaSlots.length;
    const keys = new Uint32Array(total);
    for (let i = 0; i < total; i++) {
      keys[i] = (select[i] ?? 0) * slots + (this.colorAlphaSlot[colorIndex[i] ?? 0] ?? 0);
    }
    return { keys, counts: countBy(keys, total, selectCount * slots) };
  }

  private addInstances(
    detailed: Group,
    tiers: TierLayers | undefined,
    shadowCasters: Group | undefined,
    chunk: ChunkInstances,
    materials: PlasticMaterials,
  ): void {
    const slots = this.alphaSlots.length;
    const { keys, counts } = this.keyInstances(
      chunk.partIndex,
      chunk.colorIndex,
      chunk.count,
      this.detailedLevel.parts.length,
    );
    const tiered = tiers !== undefined && this.tiered;
    const tierKeys = tiered ? classKeys(keys, chunk) : new Uint32Array(0);
    const tierCounts = countBy(tierKeys, tierKeys.length, counts.length * INSTANCE_CLASSES);
    for (let key = 0; key < counts.length; key++) {
      const count = counts[key] ?? 0;
      if (count === 0) continue;
      const p = Math.floor(key / slots);
      const alpha = this.alphaSlots[key % slots] ?? OPAQUE_ALPHA;
      const attributes = this.instanceAttributes(
        keys,
        chunk.count,
        key,
        count,
        chunk.matrices,
        chunk.colorIndex,
      );
      this.addPartMeshes(
        detailed,
        this.detailedLevel.parts[p],
        alpha,
        count,
        attributes,
        materials,
      );
      if (shadowCasters && !this.tiered && alpha === OPAQUE_ALPHA) {
        this.addShadowCasters(shadowCasters, this.detailedLevel.parts[p], count, attributes);
      }
      if (!tiered) continue;
      for (let c = 0; c < INSTANCE_CLASSES; c++) {
        const tierKey = key * INSTANCE_CLASSES + c;
        const tierCount = tierCounts[tierKey] ?? 0;
        if (tierCount === 0) continue;
        const tierAttributes =
          tierCount === count
            ? attributes
            : this.instanceAttributes(
                tierKeys,
                chunk.count,
                tierKey,
                tierCount,
                chunk.matrices,
                chunk.colorIndex,
              );
        const level = (c & CLASS_NOT_UPRIGHT) !== 0 ? this.detailedLevel : this.farLevel;
        const layer = (c & CLASS_VOXELIZED) !== 0 ? tiers.midShells : tiers.shellBodies;
        this.addPartMeshes(layer, level.parts[p], alpha, tierCount, tierAttributes, materials);
      }
    }
    if (shadowCasters && this.tiered) this.addBoundsProxies(shadowCasters, chunk);
    this.addStudMeshes(chunk.studs, detailed, tiers?.coarseStuds, materials);
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
    alpha: number,
    count: number,
    attributes: InstanceAttributes,
    materials: PlasticMaterials,
  ): void {
    if (!geometries) return;
    if (geometries.body) {
      layer.add(
        this.instancedMesh(
          geometries.body,
          materials.instanceColored(alpha),
          count,
          attributes.matrices,
          attributes.colors,
        ),
      );
    }
    for (const fixed of geometries.fixed) {
      layer.add(
        this.instancedMesh(
          fixed.geometry,
          materials.vertexColored(fixed.alpha),
          count,
          attributes.matrices,
          undefined,
        ),
      );
    }
  }

  private addBoundsProxies(layer: Group, chunk: ChunkInstances): void {
    let count = 0;
    for (let i = 0; i < chunk.count; i++) {
      if ((this.colorAlphaSlot[chunk.colorIndex[i] ?? 0] ?? 0) === 0) count++;
    }
    if (count === 0) return;
    const matrices = new Float32Array(count * MATRIX4_FLOATS);
    const m = chunk.matrices;
    const b = this.partBounds;
    let slot = 0;
    for (let i = 0; i < chunk.count; i++) {
      if ((this.colorAlphaSlot[chunk.colorIndex[i] ?? 0] ?? 0) !== 0) continue;
      const s = i * INSTANCE_MATRIX_FLOATS;
      const o = (chunk.partIndex[i] ?? 0) * BOUNDS_FLOATS;
      const t = slot * MATRIX4_FLOATS;
      for (let axis = 0; axis < 3; axis++) {
        const size = (b[o + 3 + axis] ?? 0) - (b[o + axis] ?? 0);
        matrices[t + axis * 4] = (m[s + axis] ?? 0) * size;
        matrices[t + axis * 4 + 1] = (m[s + 4 + axis] ?? 0) * size;
        matrices[t + axis * 4 + 2] = (m[s + 8 + axis] ?? 0) * size;
      }
      for (let row = 0; row < 3; row++) {
        let centre = m[s + row * 4 + 3] ?? 0;
        for (let axis = 0; axis < 3; axis++) {
          const mid = ((b[o + axis] ?? 0) + (b[o + 3 + axis] ?? 0)) / 2;
          centre += (m[s + row * 4 + axis] ?? 0) * mid;
        }
        matrices[t + 12 + row] = centre;
      }
      matrices[t + 15] = 1;
      slot++;
    }
    const mesh = this.instancedMesh(
      this.unitBox,
      this.materials.instanceColored(OPAQUE_ALPHA),
      count,
      new InstancedBufferAttribute(matrices, MATRIX4_FLOATS),
      undefined,
    );
    mesh.layers.set(SHADOW_LAYER);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    layer.add(mesh);
  }

  private addShadowCasters(
    layer: Group,
    geometries: PartGeometries | undefined,
    count: number,
    attributes: InstanceAttributes,
  ): void {
    if (!geometries) return;
    const caster = (geometry: BufferGeometry, material: MeshStandardNodeMaterial): void => {
      const mesh = this.instancedMesh(geometry, material, count, attributes.matrices, undefined);
      mesh.layers.set(SHADOW_LAYER);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      layer.add(mesh);
    };
    if (geometries.body) caster(geometries.body, this.materials.instanceColored(OPAQUE_ALPHA));
    for (const fixed of geometries.fixed) {
      if (fixed.alpha === OPAQUE_ALPHA) {
        caster(fixed.geometry, this.materials.vertexColored(OPAQUE_ALPHA));
      }
    }
  }

  private addStudMeshes(
    studs: StudInstances,
    detailed: Group,
    coarse: Group | undefined,
    materials: PlasticMaterials,
  ): void {
    const primitiveCount = this.detailedLevel.studs.length;
    const slots = this.alphaSlots.length;
    const { keys, counts } = this.keyInstances(
      studs.primitiveIndex,
      studs.colorIndex,
      studs.count,
      primitiveCount,
    );
    for (let key = 0; key < counts.length; key++) {
      const count = counts[key] ?? 0;
      const k = Math.floor(key / slots);
      const detailedGeometry = this.detailedLevel.studs[k];
      if (count === 0 || !detailedGeometry) continue;
      const material = materials.instanceColored(this.alphaSlots[key % slots] ?? OPAQUE_ALPHA);
      const attributes = this.instanceAttributes(
        keys,
        studs.count,
        key,
        count,
        studs.matrices,
        studs.colorIndex,
      );
      detailed.add(
        this.instancedMesh(
          detailedGeometry,
          material,
          count,
          attributes.matrices,
          attributes.colors,
        ),
      );
      const coarseGeometry = this.farLevel.studs[k];
      if (coarse && coarseGeometry) {
        coarse.add(
          this.instancedMesh(
            coarseGeometry,
            material,
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
    mesh.receiveShadow = this.look.shadows && !material.transparent;
    mesh.computeBoundingSphere();
    return mesh;
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
    this.ghostEffects.rebase(this.renderOriginX, this.renderOriginZ);
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
    writeMatrix4(placement.matrix, 0, this.farModelMatrix, 0);
    for (const fixed of geometries) {
      const material = this.materials.vertexColored(fixed.alpha);
      const mesh = new Mesh(fixed.geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(this.farModelMatrix);
      mesh.receiveShadow = this.look.shadows && !material.transparent;
      group.add(mesh);
    }
    group.updateMatrixWorld(true);
    group.visible = false;
    const node = new FarModelNode(group, placement.originX, placement.originZ, [
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
    const orthoStudPitchPx =
      (STUD_PITCH_LDU * this.focalLengthPx * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360)) /
      Math.max(this.orthoHalfHeight, CAMERA_NEAR_LDU);
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
      record.applyTier(tier);
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

  bufferMemory(): BufferMemory {
    return this.bufferTally.snapshot();
  }

  renderFrame(out: FrameStats): void {
    const renderer = this.renderer;
    if (!renderer) throw new Error("ThreeSceneBackend.renderFrame called before init");
    this.throwIfFailed();
    this.assignTiers(out);
    this.ghostEffects.animate(performance.now(), this.camera);
    renderer.info.reset();
    if (this.pipeline && this.camera === this.perspective) this.pipeline.render();
    else renderer.render(this.scene, this.camera);
    out.drawCalls = renderer.info.render.drawCalls;
    out.triangles = renderer.info.render.triangles;
    out.renderOriginChunkX = this.renderOriginX / CHUNK_LDU;
    out.renderOriginChunkZ = this.renderOriginZ / CHUNK_LDU;
    out.rebaseCount = this.rebaseCount;
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
