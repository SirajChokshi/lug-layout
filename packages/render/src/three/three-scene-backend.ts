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
  type LdrawColor,
  type LookSettings,
  type NeededMeshListener,
  type PaletteLevel,
  type PartMeshUpdate,
  type PartPalette,
  type PlanOverlay,
  type RebaseEvent,
  type SceneBackendConfig,
  type IThumbnailRenderer,
  type TrackEndKind,
  type TrackEndMarker,
  type ThumbnailRequest,
  type WorldBox,
} from "../scene-backend.ts";
import {
  DIRECT_COLOR_ALPHA,
  directColorSrgb,
  isDirectColor,
  type PartAsset,
  type PartMesh,
  type StudPrimitiveAsset,
} from "@brr/catalog";
import { CHUNK_LDU, chunkOf } from "@brr/math";
import { type ChunkNeeds, ChunkNeedsBuilder } from "./chunk-needs.ts";
import { GpuBufferTally } from "./gpu-buffer-tally.ts";
import {
  MATRIX4_FLOATS,
  groupRunEnd,
  linearColorsOf,
  isNotUpright,
  isVoxelized,
  matricesOf,
  pageOf,
  regroupedPage,
  usesAnyShape,
  writeMatrix4,
  type InstancePage,
} from "./instance-page.ts";
import { LookPipeline } from "./look-pipeline.ts";
import {
  fixedColorGeometries,
  inheritBodyGeometry,
  primitiveGeometry,
  type FixedColorGeometry,
} from "./part-geometry.ts";
import { OPAQUE_ALPHA, PlasticMaterials } from "./plastic-materials.ts";
import { skyEnvironment } from "./sky-environment.ts";

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
const TRANSLATION_X = 12;
const TRANSLATION_Z = 14;
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
const TIER_COUNT = 3;
const TIER_BY_NAME: Readonly<Record<ChunkTier, number>> = {
  near: TIER_NEAR,
  mid: TIER_MID,
  far: TIER_FAR,
};
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
  readonly parts: Array<PartGeometries | undefined>;
  studs: ReadonlyArray<BufferGeometry>;
}

function emptyLevel(): LevelGeometries {
  return { parts: [], studs: [] };
}

function disposePart(part: PartGeometries | undefined): void {
  part?.body?.dispose();
  for (const fixed of part?.fixed ?? []) fixed.geometry.dispose();
}

function disposeLevel(level: LevelGeometries): void {
  for (const part of level.parts) disposePart(part);
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

class ChunkRecord {
  key = 0;
  needsRebuild = false;
  tier = TIER_UNSET;
  studPitchPx = 0;
  heldNeeds: ChunkNeeds | null = null;
  heldTier = TIER_UNSET;

  constructor(
    readonly page: InstancePage,
    readonly group: Group,
    readonly detailed: Group,
    readonly shellBodies: Group,
    readonly midShells: Group,
    readonly coarseStuds: Group,
    readonly shadowCasters: Group,
    readonly needs: ChunkNeeds,
    readonly tiered: boolean,
    readonly minX: number,
    readonly maxX: number,
    readonly minZ: number,
    readonly maxZ: number,
  ) {}

  applyTier(tier: number): boolean {
    if (tier === this.tier) return false;
    this.tier = tier;
    this.detailed.visible = tier === TIER_NEAR;
    this.shellBodies.visible = tier !== TIER_NEAR;
    this.midShells.visible = tier === TIER_MID;
    this.coarseStuds.visible = tier === TIER_MID;
    return true;
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

interface ThumbnailStage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
}

const THUMBNAIL_FOV_DEGREES = 30;
const THUMBNAIL_VIEW = new Vector3(0.9, 0.85, 1.15).normalize();
const THUMBNAIL_MARGIN = 1.04;
const THUMBNAIL_DEPTH_SLACK = 2;

@injectable()
export class ThreeSceneBackend implements ISceneBackend, IThumbnailRenderer {
  private renderer: WebGPURenderer | undefined;
  private readonly scene = new Scene();
  private readonly perspective = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    1,
    CAMERA_NEAR_LDU,
    CAMERA_FAR_LDU,
  );
  private materials = new PlasticMaterials(false, 1);
  private thumbnailStage: Promise<ThumbnailStage> | undefined;
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
  private detailedLevel: LevelGeometries = emptyLevel();
  private farLevel: LevelGeometries = emptyLevel();
  private farModelGeometries: Array<ReadonlyArray<FixedColorGeometry> | undefined> = [];
  private readonly farModelPlacements = new Map<number, FarModelPlacement>();
  private ldrawColorTable: ReadonlyMap<number, LdrawColor> = new Map();
  private ghostPage: InstancePage | null = null;
  private ghostNeeds: ChunkNeeds | null = null;
  private neededMeshListener: NeededMeshListener | null = null;
  private readonly rebuildKeys: number[] = [];
  private ghostPose: readonly [number, number, number, number] | null = null;
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
  private atX = 0;
  private atY = 0;
  private atZ = 0;
  private changed = true;
  private sceneMinX = Number.POSITIVE_INFINITY;
  private sceneMaxX = Number.NEGATIVE_INFINITY;
  private sceneMinZ = Number.POSITIVE_INFINITY;
  private sceneMaxZ = Number.NEGATIVE_INFINITY;
  private frame = 0;
  private readonly rebases: RebaseEvent[] = [];
  private rebaseCount = 0;
  private eyeMovedAt = 0;
  private settledEyeTimer: ReturnType<typeof setTimeout> | null = null;
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

  private ldrawColor(code: number): LdrawColor {
    if (isDirectColor(code)) return { srgb: directColorSrgb(code), alpha: DIRECT_COLOR_ALPHA };
    const color = this.ldrawColorTable.get(code);
    if (color === undefined) throw new Error(`LDraw colour ${code} is not in LDConfig`);
    return color;
  }

  private readonly linearColor = (code: number, out: Float32Array): void => {
    this.scratchColor.setHex(this.ldrawColor(code).srgb, SRGBColorSpace);
    out[0] = this.scratchColor.r;
    out[1] = this.scratchColor.g;
    out[2] = this.scratchColor.b;
  };

  private readonly alphaOf = (code: number): number => this.ldrawColor(code).alpha;

  private partGeometries(part: PartAsset): PartGeometries {
    return {
      body: inheritBodyGeometry(part),
      fixed: fixedColorGeometries(part.mesh, this.linearColor, this.alphaOf),
    };
  }

  private level(set: GeometrySet): LevelGeometries {
    return {
      parts: set.parts.map((part) => this.partGeometries(part)),
      studs: set.studPrimitives.map((primitive) => primitiveGeometry(primitive.mesh)),
    };
  }

  private setPartBounds(index: number, part: PartAsset): void {
    if ((index + 1) * BOUNDS_FLOATS > this.partBounds.length) {
      const grown = new Float32Array(
        Math.max((index + 1) * BOUNDS_FLOATS, this.partBounds.length * 2),
      );
      grown.set(this.partBounds);
      this.partBounds = grown;
    }
    this.partBounds.set(part.boundsMin, index * BOUNDS_FLOATS);
    this.partBounds.set(part.boundsMax, index * BOUNDS_FLOATS + 3);
  }

  setPalette(palette: PartPalette): void {
    this.changed = true;
    this.clearChunks();
    for (const node of this.farModelList) this.scene.remove(node.group);
    this.farModelNodes.clear();
    this.farModelPlacements.clear();
    this.farModelList = [];
    this.setGhost(null);
    disposeLevel(this.detailedLevel);
    disposeLevel(this.farLevel);
    for (const geometries of this.farModelGeometries) {
      for (const fixed of geometries ?? []) fixed.geometry.dispose();
    }
    if (palette.far) assertSameParts(palette.detailed, palette.far);
    this.ldrawColorTable = palette.ldrawColors;
    this.detailedLevel = this.level(palette.detailed);
    this.farLevel = palette.far ? this.level(palette.far) : emptyLevel();
    this.farModelGeometries = (palette.farModels ?? []).map((mesh) =>
      fixedColorGeometries(mesh, this.linearColor, this.alphaOf),
    );
    this.tiered = palette.far !== undefined;
    this.partBounds = new Float32Array(palette.detailed.parts.length * BOUNDS_FLOATS);
    palette.detailed.parts.forEach((part, p) => this.setPartBounds(p, part));
    this.installColors(palette.colorsSrgb, palette.colorsAlpha);
  }

  private installColors(colorsSrgb: Uint8Array, colorsAlpha: Uint8Array): void {
    const colorCount = colorsSrgb.length / COLOR_CHANNELS;
    this.linearColors = new Float32Array(colorCount * COLOR_CHANNELS);
    this.alphaSlots = [OPAQUE_ALPHA];
    this.colorAlphaSlot = new Uint8Array(colorCount);
    for (let c = 0; c < colorCount; c++) {
      const o = c * COLOR_CHANNELS;
      this.scratchColor.setRGB(
        (colorsSrgb[o] ?? 0) / 255,
        (colorsSrgb[o + 1] ?? 0) / 255,
        (colorsSrgb[o + 2] ?? 0) / 255,
        SRGBColorSpace,
      );
      this.linearColors[o] = this.scratchColor.r;
      this.linearColors[o + 1] = this.scratchColor.g;
      this.linearColors[o + 2] = this.scratchColor.b;
      const alpha = colorsAlpha[c] ?? OPAQUE_ALPHA;
      let slot = this.alphaSlots.indexOf(alpha);
      if (slot < 0) slot = this.alphaSlots.push(alpha) - 1;
      this.colorAlphaSlot[c] = slot;
    }
  }

  setColors(colorsSrgb: Uint8Array, colorsAlpha: Uint8Array): void {
    this.changed = true;
    this.installColors(colorsSrgb, colorsAlpha);
    this.rebuildPages(
      () => true,
      (page) => regroupedPage(page, this.linearColors, this.colorAlphaSlot),
    );
  }

  private rebuildPages(
    affected: (page: InstancePage) => boolean,
    rebuild: (page: InstancePage) => InstancePage = (page) => page,
  ): void {
    for (const [key, record] of Array.from(this.chunks)) {
      if (affected(record.page)) this.placeChunk(key, rebuild(record.page));
    }
    for (const [vehicle, record] of Array.from(this.vehicles)) {
      if (affected(record.body.page)) this.rebuildVehicle(vehicle, rebuild(record.body.page));
    }
    const ghost = this.ghostPage;
    if (ghost && affected(ghost)) this.rebuildGhost(rebuild(ghost));
  }

  addParts(parts: ReadonlyArray<PartAsset>): void {
    this.changed = true;
    for (const part of parts) {
      const index = this.detailedLevel.parts.length;
      this.detailedLevel.parts.push(this.partGeometries(part));
      this.setPartBounds(index, part);
    }
  }

  setPartMeshes(updates: ReadonlyArray<PartMeshUpdate>): void {
    const changed = new Set<number>();
    const detailedChanged = new Set<number>();
    const farChanged = new Set<number>();
    for (const { index, level, part } of updates) {
      if (index >= this.detailedLevel.parts.length) {
        throw new RangeError(`part ${index} is not in the palette`);
      }
      const geometries = level === "far" ? this.farLevel : this.detailedLevel;
      disposePart(geometries.parts[index]);
      geometries.parts[index] = this.partGeometries(part);
      if (level === "detailed") {
        this.setPartBounds(index, part);
        detailedChanged.add(index);
        changed.add(index);
      } else if (this.tiered) {
        farChanged.add(index);
        changed.add(index);
      }
    }
    if (changed.size === 0) return;
    for (const [key, record] of Array.from(this.chunks)) {
      if (!usesAnyShape(record.page.partRuns, changed)) continue;
      if (
        record.needs.drawsAnyPart(record.tier, detailedChanged, farChanged, this.farLevel.parts)
      ) {
        this.placeChunk(key, record.page);
      } else {
        record.needsRebuild = true;
      }
    }
    for (const [vehicle, record] of Array.from(this.vehicles)) {
      if (usesAnyShape(record.body.page.partRuns, detailedChanged)) {
        this.rebuildVehicle(vehicle, record.body.page);
      }
    }
    const ghost = this.ghostPage;
    if (ghost && usesAnyShape(ghost.partRuns, detailedChanged)) this.rebuildGhost(ghost);
  }

  setFarStuds(studPrimitives: ReadonlyArray<StudPrimitiveAsset>): void {
    this.changed = true;
    if (studPrimitives.length !== this.detailedLevel.studs.length) {
      throw new Error("the far stud primitives do not match the palette's stud primitives");
    }
    for (const stud of this.farLevel.studs) stud.dispose();
    this.farLevel.studs = studPrimitives.map((primitive) => primitiveGeometry(primitive.mesh));
    this.tiered = true;
    this.rebuildPages(() => true);
  }

  setFarModelMesh(modelIndex: number, mesh: PartMesh): void {
    this.changed = true;
    for (const fixed of this.farModelGeometries[modelIndex] ?? []) fixed.geometry.dispose();
    this.farModelGeometries[modelIndex] = fixedColorGeometries(
      mesh,
      this.linearColor,
      this.alphaOf,
    );
    for (const [id, placement] of Array.from(this.farModelPlacements)) {
      if (placement.modelIndex === modelIndex) this.setFarModel(id, placement);
    }
  }

  setChunk(key: number, chunk: ChunkInstances): void {
    this.changed = true;
    this.placeChunk(key, pageOf(chunk, this.linearColors, this.colorAlphaSlot));
  }

  private placeGroup(group: Group, originX: number, originZ: number): void {
    group.position.set(originX - this.renderOriginX, 0, originZ - this.renderOriginZ);
    group.updateMatrix();
    group.updateMatrixWorld(true);
  }

  private placeChunk(key: number, page: InstancePage): void {
    this.changed = true;
    const replaced = this.chunks.get(key);
    const samePage =
      replaced !== undefined && replaced.page === page && replaced.tiered === this.tiered;
    this.removeChunk(key);
    const record = this.buildChunk(
      page,
      samePage ? replaced.needs : new ChunkNeedsBuilder(TIER_COUNT),
    );
    record.key = key;
    record.studPitchPx = this.studPitchPx(record, this.orthoStudPitchPx());
    record.applyTier(this.tierOf(record.studPitchPx));
    this.inheritHolds(record, replaced);
    this.syncNeeds(record);
    this.placeGroup(record.group, page.originX, page.originZ);
    this.chunks.set(key, record);
    this.chunkList.push(record);
    this.scene.add(record.group);
    this.sceneMinX = Math.min(this.sceneMinX, record.minX);
    this.sceneMaxX = Math.max(this.sceneMaxX, record.maxX);
    this.sceneMinZ = Math.min(this.sceneMinZ, record.minZ);
    this.sceneMaxZ = Math.max(this.sceneMaxZ, record.maxZ);
  }

  setVehicle(vehicle: number, model: ChunkInstances): void {
    this.changed = true;
    this.placeVehicleBody(vehicle, pageOf(model, this.linearColors, this.colorAlphaSlot));
  }

  private placeVehicleBody(vehicle: number, page: InstancePage): void {
    this.changed = true;
    const replaced = this.vehicles.get(vehicle)?.body;
    const samePage =
      replaced !== undefined && replaced.page === page && replaced.tiered === this.tiered;
    this.removeVehicle(vehicle);
    const body = this.buildChunk(
      page,
      samePage ? replaced.needs : new ChunkNeedsBuilder(TIER_COUNT),
    );
    body.applyTier(TIER_NEAR);
    this.inheritHolds(body, replaced);
    this.syncNeeds(body);
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
    this.changed = true;
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
    this.changed = true;
    const body = this.vehicles.get(vehicle)?.body;
    if (body) this.releaseHolds(body);
    this.removeVehicle(vehicle);
  }

  private rebuildVehicle(vehicle: number, page: InstancePage): void {
    const before = this.vehicles.get(vehicle);
    this.placeVehicleBody(vehicle, page);
    const after = this.vehicles.get(vehicle);
    if (!before || !after) return;
    after.x = before.x;
    after.y = before.y;
    after.z = before.z;
    after.yaw = before.yaw;
    this.placeVehicle(after);
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
    this.changed = true;
    const record = this.chunks.get(key);
    if (record) this.releaseHolds(record);
    this.removeChunk(key);
  }

  setNeededMeshListener(listener: NeededMeshListener | null): void {
    this.neededMeshListener = listener;
  }

  private inheritHolds(record: ChunkRecord, replaced: ChunkRecord | undefined): void {
    if (!replaced) return;
    record.heldNeeds = replaced.heldNeeds;
    record.heldTier = replaced.heldTier;
  }

  private syncNeeds(record: ChunkRecord): void {
    const held = record.heldNeeds;
    if (held === record.needs && record.heldTier === record.tier) return;
    this.neededMeshListener?.hold(
      record.needs.detailedAt(record.tier),
      record.needs.farAt(record.tier),
    );
    if (held) this.release(held, record.heldTier);
    record.heldNeeds = record.needs;
    record.heldTier = record.tier;
  }

  private releaseHolds(record: ChunkRecord): void {
    if (record.heldNeeds) this.release(record.heldNeeds, record.heldTier);
    record.heldNeeds = null;
    record.heldTier = TIER_UNSET;
  }

  private release(needs: ChunkNeeds, tier: number): void {
    this.neededMeshListener?.release(needs.detailedAt(tier), needs.farAt(tier));
  }

  private removeChunk(key: number): void {
    const existing = this.chunks.get(key);
    if (!existing) return;
    this.scene.remove(existing.group);
    for (const layer of existing.layers()) disposeInstancedChildren(layer);
    this.chunks.delete(key);
    this.chunkList = this.chunkList.filter((record) => record !== existing);
  }

  setGhost(model: ChunkInstances | null): void {
    this.changed = true;
    this.showGhost(model ? pageOf(model, this.linearColors, this.colorAlphaSlot) : null);
  }

  private showGhost(page: InstancePage | null): void {
    this.changed = true;
    if (this.ghost) {
      this.scene.remove(this.ghost);
      disposeInstancedChildren(this.ghost);
      this.ghost = undefined;
    }
    const held = this.ghostNeeds;
    const samePage = page !== null && page === this.ghostPage;
    this.ghostPose = null;
    this.ghostPage = page;
    this.ghostNeeds = null;
    if (!page) {
      if (held) this.release(held, TIER_NEAR);
      return;
    }
    const ghost = new Group();
    ghost.matrixAutoUpdate = false;
    ghost.visible = false;
    const builder = samePage && held ? null : new ChunkNeedsBuilder(TIER_COUNT);
    this.addInstances(ghost, undefined, undefined, page, this.ghostMaterials, builder);
    this.ghost = ghost;
    this.scene.add(ghost);
    if (!builder) {
      this.ghostNeeds = held;
      return;
    }
    const needs = builder.build();
    this.neededMeshListener?.hold(needs.detailedAt(TIER_NEAR), needs.farAt(TIER_NEAR));
    if (held) this.release(held, TIER_NEAR);
    this.ghostNeeds = needs;
  }

  private rebuildGhost(page: InstancePage): void {
    const pose = this.ghostPose;
    this.showGhost(page);
    if (pose) this.placeGhost(...pose);
  }

  placeGhost(x: number, yLdu: number, z: number, rot: number): void {
    this.changed = true;
    const ghost = this.ghost;
    if (!ghost) return;
    this.ghostPose = [x, yLdu, z, rot];
    this.ghostX = x;
    this.ghostZ = z;
    ghost.position.set(x - this.renderOriginX, yLdu, z - this.renderOriginZ);
    ghost.rotation.set(0, rot * QUARTER_TURN_RADIANS, 0);
    ghost.updateMatrix();
    ghost.updateMatrixWorld(true);
    ghost.visible = true;
  }

  setSelectionBox(box: WorldBox | null): void {
    this.changed = true;
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
    this.changed = true;
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
    this.changed = true;
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
    this.changed = true;
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
    this.changed = true;
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
    for (const [key, record] of this.chunks) {
      this.releaseHolds(record);
      this.removeChunk(key);
    }
    for (const [vehicle, record] of this.vehicles) {
      this.releaseHolds(record.body);
      this.removeVehicle(vehicle);
    }
  }

  private buildChunk(page: InstancePage, needs: ChunkNeeds | ChunkNeedsBuilder): ChunkRecord {
    const group = new Group();
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
      page,
      this.materials,
      needs instanceof ChunkNeedsBuilder ? needs : null,
    );
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < page.partCount; i++) {
      const x = page.originX + (page.matrices[i * MATRIX4_FLOATS + TRANSLATION_X] ?? 0);
      const z = page.originZ + (page.matrices[i * MATRIX4_FLOATS + TRANSLATION_Z] ?? 0);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    group.updateMatrixWorld(true);
    const record = new ChunkRecord(
      page,
      group,
      detailed,
      shellBodies,
      midShells,
      coarseStuds,
      shadowCasters ?? new Group(),
      needs instanceof ChunkNeedsBuilder ? needs.build() : needs,
      this.tiered,
      minX,
      maxX,
      minZ,
      maxZ,
    );
    return record;
  }

  private pageAttributes(page: InstancePage, start: number, end: number): InstanceAttributes {
    return {
      matrices: new InstancedBufferAttribute(matricesOf(page, start, end), MATRIX4_FLOATS),
      colors: new InstancedBufferAttribute(linearColorsOf(page, start, end), COLOR_CHANNELS),
    };
  }

  private addInstances(
    detailed: Group,
    tiers: TierLayers | undefined,
    shadowCasters: Group | undefined,
    page: InstancePage,
    materials: PlasticMaterials,
    needs: ChunkNeedsBuilder | null,
  ): void {
    const runs = page.partRuns;
    const count = runs.shape.length;
    let first = 0;
    while (first < count) {
      const p = runs.shape[first] ?? 0;
      const slot = runs.alphaSlot[first] ?? 0;
      const next = groupRunEnd(runs, first);
      const alpha = this.alphaSlots[slot] ?? OPAQUE_ALPHA;
      const start = runs.start[first] ?? 0;
      const end = runs.end[next - 1] ?? 0;
      const attributes = this.pageAttributes(page, start, end);
      const geometries = this.detailedLevel.parts[p];
      this.addPartMeshes(detailed, geometries, alpha, end - start, attributes, materials);
      needs?.need(TIER_NEAR, "detailed", p);
      if (shadowCasters && !this.tiered && alpha === OPAQUE_ALPHA) {
        this.addShadowCasters(shadowCasters, geometries, end - start, attributes);
      }
      if (tiers && this.tiered) {
        for (let run = first; run < next; run++) {
          const c = runs.instanceClass[run] ?? 0;
          const runStart = runs.start[run] ?? 0;
          const runEnd = runs.end[run] ?? 0;
          const runAttributes =
            next - first === 1 ? attributes : this.pageAttributes(page, runStart, runEnd);
          const levelName: PaletteLevel = isNotUpright(c) ? "detailed" : "far";
          const level = levelName === "detailed" ? this.detailedLevel : this.farLevel;
          const layer = isVoxelized(c) ? tiers.midShells : tiers.shellBodies;
          const shell = level.parts[p] ?? geometries;
          this.addPartMeshes(layer, shell, alpha, runEnd - runStart, runAttributes, materials);
          needs?.need(TIER_MID, levelName, p);
          if (layer === tiers.shellBodies) needs?.need(TIER_FAR, levelName, p);
        }
      }
      first = next;
    }
    if (shadowCasters && this.tiered) this.addBoundsProxies(shadowCasters, page);
    this.addStudMeshes(page, detailed, tiers?.coarseStuds, materials);
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

  private addBoundsProxies(layer: Group, page: InstancePage): void {
    let count = 0;
    for (let i = 0; i < page.partCount; i++) {
      if ((this.colorAlphaSlot[page.colorIndex[i] ?? 0] ?? 0) === 0) count++;
    }
    if (count === 0) return;
    const matrices = new Float32Array(count * MATRIX4_FLOATS);
    const m = page.matrices;
    const b = this.partBounds;
    let slot = 0;
    for (let i = 0; i < page.partCount; i++) {
      if ((this.colorAlphaSlot[page.colorIndex[i] ?? 0] ?? 0) !== 0) continue;
      const s = i * MATRIX4_FLOATS;
      const o = (page.shape[i] ?? 0) * BOUNDS_FLOATS;
      const t = slot * MATRIX4_FLOATS;
      for (let axis = 0; axis < 3; axis++) {
        const size = (b[o + 3 + axis] ?? 0) - (b[o + axis] ?? 0);
        for (let row = 0; row < 3; row++) {
          matrices[t + axis * 4 + row] = (m[s + axis * 4 + row] ?? 0) * size;
        }
      }
      for (let row = 0; row < 3; row++) {
        let centre = m[s + TRANSLATION_X + row] ?? 0;
        for (let axis = 0; axis < 3; axis++) {
          const mid = ((b[o + axis] ?? 0) + (b[o + 3 + axis] ?? 0)) / 2;
          centre += (m[s + axis * 4 + row] ?? 0) * mid;
        }
        matrices[t + TRANSLATION_X + row] = centre;
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
    page: InstancePage,
    detailed: Group,
    coarse: Group | undefined,
    materials: PlasticMaterials,
  ): void {
    const studs = page.studRuns;
    for (let run = 0; run < studs.shape.length; run++) {
      const k = studs.shape[run] ?? 0;
      const detailedGeometry = this.detailedLevel.studs[k];
      if (!detailedGeometry) continue;
      const alpha = this.alphaSlots[studs.alphaSlot[run] ?? 0] ?? OPAQUE_ALPHA;
      const material = materials.instanceColored(alpha);
      const start = studs.start[run] ?? 0;
      const end = studs.end[run] ?? 0;
      const attributes = this.pageAttributes(page, start, end);
      detailed.add(
        this.instancedMesh(
          detailedGeometry,
          material,
          end - start,
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
            end - start,
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
    const eyeMoved = eyeX !== this.eyeX || eyeY !== this.eyeY || eyeZ !== this.eyeZ;
    if (eyeMoved) this.eyeMovedAt = performance.now();
    const camera = orthoHalfHeightLdu === undefined ? this.perspective : this.orthographic;
    const viewChanged =
      eyeMoved ||
      atX !== this.atX ||
      atY !== this.atY ||
      atZ !== this.atZ ||
      camera !== this.camera ||
      (orthoHalfHeightLdu !== undefined && orthoHalfHeightLdu !== this.orthoHalfHeight);
    if (viewChanged) this.changed = true;
    this.eyeX = eyeX;
    this.eyeY = eyeY;
    this.eyeZ = eyeZ;
    this.atX = atX;
    this.atY = atY;
    this.atZ = atZ;
    const rebases = this.rebaseCount;
    this.followEye();
    if (this.rebaseCount !== rebases) this.changed = true;
    this.camera = camera;
    if (orthoHalfHeightLdu !== undefined && orthoHalfHeightLdu !== this.orthoHalfHeight) {
      this.orthoHalfHeight = orthoHalfHeightLdu;
      this.fitOrthographic();
    }
    this.aim(this.perspective, eyeX, eyeY, eyeZ, atX, atY, atZ);
    this.aim(this.orthographic, eyeX, eyeY, eyeZ, atX, atY, atZ);
    if (viewChanged) this.applyTiers();
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
    if (this.rebaseCount > 0 && !far) {
      if (atEye) return;
      if (performance.now() - this.eyeMovedAt < SETTLED_EYE_MS) {
        this.scheduleSettledEye();
        return;
      }
    }
    const started = performance.now();
    this.renderOriginX = chunkX * CHUNK_LDU;
    this.renderOriginZ = chunkZ * CHUNK_LDU;
    for (let i = 0; i < this.chunkList.length; i++) {
      const record = this.chunkList[i];
      if (record) this.placeGroup(record.group, record.page.originX, record.page.originZ);
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

  private scheduleSettledEye(): void {
    if (this.settledEyeTimer !== null) return;
    this.settledEyeTimer = setTimeout(
      this.followSettledEye,
      this.eyeMovedAt + SETTLED_EYE_MS - performance.now(),
    );
  }

  private readonly followSettledEye = (): void => {
    this.settledEyeTimer = null;
    const remainingMs = this.eyeMovedAt + SETTLED_EYE_MS - performance.now();
    if (remainingMs > 0) {
      this.settledEyeTimer = setTimeout(this.followSettledEye, remainingMs);
      return;
    }
    const rebases = this.rebaseCount;
    this.followEye();
    if (this.rebaseCount === rebases) return;
    this.aim(this.perspective, this.eyeX, this.eyeY, this.eyeZ, this.atX, this.atY, this.atZ);
    this.aim(this.orthographic, this.eyeX, this.eyeY, this.eyeZ, this.atX, this.atY, this.atZ);
    this.changed = true;
  };

  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return this.rebases;
  }

  async renderThumbnail({ model, box, sizePx }: ThumbnailRequest): Promise<string> {
    const stage = await (this.thumbnailStage ??= this.createThumbnailStage());
    stage.renderer.setSize(sizePx, sizePx, false);
    const group = new Group();
    const page = pageOf(model, this.linearColors, this.colorAlphaSlot);
    this.addInstances(group, undefined, undefined, page, this.materials, null);
    group.position.set(
      -(box.minX + box.maxX) / 2,
      -(box.minY + box.maxY) / 2,
      -(box.minZ + box.maxZ) / 2,
    );
    stage.scene.add(group);
    const radius = Math.hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ) / 2;
    const distance =
      (radius * THUMBNAIL_MARGIN) / Math.sin((THUMBNAIL_FOV_DEGREES * Math.PI) / 360);
    const { camera } = stage;
    camera.position.copy(THUMBNAIL_VIEW).multiplyScalar(distance);
    camera.near = Math.max(1, distance - radius * THUMBNAIL_DEPTH_SLACK);
    camera.far = distance + radius * THUMBNAIL_DEPTH_SLACK;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    stage.renderer.render(stage.scene, camera);
    const url = stage.canvas.toDataURL("image/png");
    stage.scene.remove(group);
    disposeInstancedChildren(group);
    return url;
  }

  private async createThumbnailStage(): Promise<ThumbnailStage> {
    const canvas = document.createElement("canvas");
    const renderer = new WebGPURenderer({ canvas, alpha: true, antialias: true, forceWebGL: true });
    await renderer.init();
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    const scene = new Scene();
    const sun = new DirectionalLight(
      0xffffff,
      this.look.plastic ? PLASTIC_SUN_INTENSITY : SUN_INTENSITY,
    );
    sun.position.copy(SUN_DIRECTION);
    scene.add(sun);
    if (this.look.plastic) {
      scene.environment = skyEnvironment(renderer);
      scene.environmentIntensity = ENVIRONMENT_INTENSITY;
      scene.add(new HemisphereLight(FILL_SKY_COLOR, FILL_GROUND_COLOR, FILL_INTENSITY));
    } else {
      scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_INTENSITY));
    }
    const camera = new PerspectiveCamera(THUMBNAIL_FOV_DEGREES, 1, 1, CAMERA_FAR_LDU);
    return { canvas, renderer, scene, camera };
  }

  resize(width: number, height: number): void {
    this.changed = true;
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
    this.applyTiers();
  }

  setFarModel(id: number, placement: FarModelPlacement | null): void {
    this.changed = true;
    const existing = this.farModelNodes.get(id);
    if (existing) {
      this.scene.remove(existing.group);
      this.farModelNodes.delete(id);
      this.farModelList = this.farModelList.filter((node) => node !== existing);
    }
    this.farModelPlacements.delete(id);
    if (!placement) return;
    this.farModelPlacements.set(id, placement);
    const geometries = this.farModelGeometries[placement.modelIndex] ?? [];
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
    this.changed = true;
    this.forcedTier = tier === null ? null : TIER_BY_NAME[tier];
    this.applyTiers();
  }

  private applyTiers(): void {
    const orthoStudPitchPx = this.orthoStudPitchPx();
    for (let i = 0; i < this.chunkList.length; i++) {
      const record = this.chunkList[i];
      if (!record) continue;
      record.studPitchPx = this.studPitchPx(record, orthoStudPitchPx);
      if (record.applyTier(this.tierOf(record.studPitchPx))) {
        this.changed = true;
        if (record.needsRebuild) this.rebuildKeys.push(record.key);
        else this.syncNeeds(record);
      }
    }
    for (let i = 0; i < this.rebuildKeys.length; i++) {
      const key = this.rebuildKeys[i] ?? 0;
      const record = this.chunks.get(key);
      if (record) this.placeChunk(key, record.page);
    }
    this.rebuildKeys.length = 0;
  }

  private orthoStudPitchPx(): number {
    return (
      (STUD_PITCH_LDU * this.focalLengthPx * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360)) /
      Math.max(this.orthoHalfHeight, CAMERA_NEAR_LDU)
    );
  }

  private studPitchPx(record: ChunkRecord, orthoStudPitchPx: number): number {
    if (this.camera === this.orthographic) return orthoStudPitchPx;
    const dx = Math.max(record.minX - this.eyeX, 0, this.eyeX - record.maxX);
    const dz = Math.max(record.minZ - this.eyeZ, 0, this.eyeZ - record.maxZ);
    const distance = Math.max(
      Math.sqrt(dx * dx + this.eyeY * this.eyeY + dz * dz),
      CAMERA_NEAR_LDU,
    );
    return (STUD_PITCH_LDU * this.focalLengthPx) / distance;
  }

  private tierOf(studPitchPx: number): number {
    if (!this.tiered) return TIER_NEAR;
    if (this.forcedTier !== null) return this.forcedTier;
    if (studPitchPx >= NEAR_MIN_STUD_PITCH_PX) return TIER_NEAR;
    if (studPitchPx >= MID_MIN_STUD_PITCH_PX) return TIER_MID;
    return TIER_FAR;
  }

  private readTierStats(out: FrameStats): void {
    let near = 0;
    let mid = 0;
    let far = 0;
    let nearestStudPitchPx = 0;
    for (let i = 0; i < this.chunkList.length; i++) {
      const record = this.chunkList[i];
      if (!record) continue;
      nearestStudPitchPx = Math.max(nearestStudPitchPx, record.studPitchPx);
      if (record.tier === TIER_NEAR) near++;
      else if (record.tier === TIER_MID) mid++;
      else far++;
    }
    out.nearChunks = near;
    out.midChunks = mid;
    out.farChunks = far;
    out.nearestStudPitchPx = nearestStudPitchPx;
  }

  bufferMemory(): BufferMemory {
    return this.bufferTally.snapshot();
  }

  renderFrame(out: FrameStats): void {
    const renderer = this.renderer;
    if (!renderer) throw new Error("ThreeSceneBackend.renderFrame called before init");
    this.throwIfFailed();
    this.fitShadowRange();
    this.readTierStats(out);
    this.showFarModels();
    renderer.info.reset();
    if (this.pipeline && this.camera === this.perspective) this.pipeline.render();
    else renderer.render(this.scene, this.camera);
    out.drawCalls = renderer.info.render.drawCalls;
    out.triangles = renderer.info.render.triangles;
    out.renderOriginChunkX = this.renderOriginX / CHUNK_LDU;
    out.renderOriginChunkZ = this.renderOriginZ / CHUNK_LDU;
    out.rebaseCount = this.rebaseCount;
    this.frame++;
    this.changed = false;
  }

  needsFrame(): boolean {
    return this.changed;
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
