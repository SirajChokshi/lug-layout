import { injectable } from "inversify";
import {
  BoxGeometry,
  BufferGeometry as LineGeometry,
  Color,
  ConeGeometry,
  DataTexture,
  Float32BufferAttribute,
  FloatType,
  DirectionalLight,
  EdgesGeometry,
  Euler,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  NoColorSpace,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGPURenderer,
  type AnimationClip,
  type BufferGeometry,
  type Material,
  MeshStandardNodeMaterial,
  Sphere,
  type TextureNode,
} from "three/webgpu";
import { texture } from "three/tsl";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import {
  CAMERA_FOV_DEGREES,
  COLOR_CHANNELS,
  MARKER_COLORS,
  PROJECTED_IN_VIEW,
  PROJECTED_NDC_X,
  PROJECTED_NDC_Y,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type EdgeMarker,
  type MarkerKind,
  type ChunkTier,
  type FarModelPlacement,
  type GeometrySet,
  type GhostTone,
  type GhostVerdict,
  type FrameStats,
  type GroundSettings,
  type GuideSegment,
  type ISceneBackend,
  type LdrawColor,
  type LookSettings,
  type NeededMeshListener,
  type PaletteLevel,
  type PartMeshUpdate,
  type PartPalette,
  type NoteShapes,
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
import { GroundPlane } from "./ground-plane.ts";
import { GuideLines } from "./guide-lines.ts";
import { NoteShapeLayer } from "./note-shapes.ts";
import { MirroredGeometries } from "./mirrored-geometry.ts";
import {
  MATRIX4_FLOATS,
  groupRunEnd,
  isNotUpright,
  isVoxelized,
  linearColorsOf,
  matricesOf,
  pageOf,
  preservesAlphaSlotSharing,
  regroupedPage,
  studBasisAndColorIndexOf,
  studTranslationsOf,
  TRANSLATION_FLOATS,
  usesAnyShape,
  writeMatrix4,
  type InstancePage,
} from "./instance-page.ts";
import { LookPipeline } from "./look-pipeline.ts";
import { PlanSceneBackend } from "./plan-scene-backend.ts";
import { KeyOrderedChildren, opaqueSort, transparentSort } from "./tie-order.ts";
import { GHOST_EDGE_SLOT, chunkEdgeSlot, vehicleEdgeSlot, writeEdgeId } from "./edge-ids.ts";
import {
  MESH_KIND_BODY,
  MESH_KIND_STUD,
  meshPageOf,
  shownStateOf,
  type LevelGeometryCounts,
  type MeshPage,
  type ShownState,
} from "./mesh-page.ts";
import {
  fixedColorGeometries,
  inheritBodyGeometry,
  primitiveGeometry,
  type FixedColorGeometry,
} from "./part-geometry.ts";
import {
  LOOKUP_TEXELS_PER_ROW,
  OPAQUE_ALPHA,
  PlasticMaterials,
  UNTINTED,
  type MaterialTint,
  type StudLookups,
} from "./plastic-materials.ts";
import { NO_MATCH, RowSpheres, type SphereReuse } from "./row-spheres.ts";
import { StudBasisTable } from "./stud-basis-table.ts";
import { isInstanced, StudMesh, studGeometry } from "./stud-mesh.ts";
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
const TIER_NAMES: ReadonlyArray<ChunkTier> = ["near", "mid", "far"];
const SPHERE_DOUBLES = 4;
const MESH_SPHERE_DOUBLES = 2 * SPHERE_DOUBLES;
const SHARED_IDENTITY = frozen(matrixWithFrozenElements());
const SHARED_POSITION = frozen(new Vector3());
const SHARED_ROTATION = frozen(new Euler());
const SHARED_QUATERNION = frozen(new Quaternion());
const SHARED_SCALE = frozen(new Vector3(1, 1, 1));
const SHARED_UP = frozen(Object3D.DEFAULT_UP.clone());
const NO_CHILDREN = frozen<Object3D[]>([]);
const NO_ANIMATIONS = frozen<AnimationClip[]>([]);
const TIER_BY_NAME: Readonly<Record<ChunkTier, number>> = {
  near: TIER_NEAR,
  mid: TIER_MID,
  far: TIER_FAR,
};
const GHOST_OPACITY = 0.55;
const GHOST_TINTS: Readonly<Record<GhostTone, MaterialTint>> = {
  fits: { color: 0xd0ffda, emissive: 0x188a36 },
  mates: { color: 0xb8ffc6, emissive: 0x26b84e },
  refused: { color: 0xff7070, emissive: 0xb8141e },
};
const GHOST_HIT_COLOR = 0xffc400;
const GHOST_HIT_OPACITY = 0.9;
const GHOST_PRECISE_COLOR = 0x00b8ff;
const SELECTION_COLOR = 0xff8c00;
const SELECTION_RENDER_ORDER = 1;
const ISSUE_RENDER_ORDER = 2;
const QUARTER_TURN_RADIANS = Math.PI / 2;
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
const OBSTACLE_COLOR = 0xc0392b;
const OBSTACLE_OPACITY = 0.45;
const ISSUE_COLOR = 0xe0115f;
const FLOOR_THICKNESS_LDU = 10;
const GRID_LIFT_LDU = 0.5;
const NDC_DEPTH_LIMIT = 1;

interface Anchored {
  readonly object: Group | LineSegments | Mesh;
  readonly x: number;
  readonly z: number;
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

function disposeTree(root: Anchored["object"]): void {
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

function pageNeeds(page: InstancePage, tiered: boolean): ChunkNeeds {
  const needs = new ChunkNeedsBuilder(TIER_COUNT);
  const runs = page.partRuns;
  const count = runs.shape.length;
  let first = 0;
  while (first < count) {
    const p = runs.shape[first] ?? 0;
    const next = groupRunEnd(runs, first);
    needs.need(TIER_NEAR, "detailed", p);
    if (tiered) {
      for (let run = first; run < next; run++) {
        const c = runs.instanceClass[run] ?? 0;
        const level: PaletteLevel = isNotUpright(c) ? "detailed" : "far";
        needs.need(TIER_MID, level, p);
        if (!isVoxelized(c)) needs.need(TIER_FAR, level, p);
      }
    }
    first = next;
  }
  return needs.build();
}

function frozen<T extends object>(value: T): T {
  Object.freeze(value);
  return value;
}

function matrixWithFrozenElements(): Matrix4 {
  const matrix = new Matrix4();
  frozen(matrix.elements);
  return matrix;
}

function shareIdentityOnParent(mesh: InstancedMesh | StudMesh, parent: Object3D): void {
  mesh.matrix = SHARED_IDENTITY;
  mesh.matrixWorld = parent.matrixWorld;
  mesh.matrixWorldAutoUpdate = false;
  Object.defineProperties(mesh, {
    position: { configurable: true, enumerable: true, value: SHARED_POSITION },
    rotation: { configurable: true, enumerable: true, value: SHARED_ROTATION },
    quaternion: { configurable: true, enumerable: true, value: SHARED_QUATERNION },
    scale: { configurable: true, enumerable: true, value: SHARED_SCALE },
  });
  mesh.up = SHARED_UP;
  mesh.children = NO_CHILDREN;
  mesh.animations = NO_ANIMATIONS;
}

function pageBox(page: InstancePage, partBounds: Float32Array, out: Float64Array): Float64Array {
  out.fill(0);
  const m = page.matrices;
  for (let i = 0; i < page.partCount; i++) {
    const s = i * MATRIX4_FLOATS;
    const o = (page.shape[i] ?? 0) * BOUNDS_FLOATS;
    for (let row = 0; row < 3; row++) {
      let centre = m[s + TRANSLATION_X + row] ?? 0;
      let half = 0;
      for (let axis = 0; axis < 3; axis++) {
        const low = partBounds[o + axis] ?? 0;
        const high = partBounds[o + 3 + axis] ?? 0;
        const scale = m[s + axis * 4 + row] ?? 0;
        centre += scale * ((low + high) / 2);
        half += Math.abs(scale) * ((high - low) / 2);
      }
      const low = centre - half;
      const high = centre + half;
      if (i === 0 || low < (out[row] ?? 0)) out[row] = low;
      if (i === 0 || high > (out[row + 3] ?? 0)) out[row + 3] = high;
    }
  }
  return out;
}

function disposeInstancedChildren(layer: Group): void {
  for (const child of layer.children) {
    if (isInstanced(child)) child.dispose();
  }
}

const LOOKUP_TEXEL_FLOATS = 4;

function lookupTexture(data: Float32Array): DataTexture {
  const texels = data.length / LOOKUP_TEXEL_FLOATS;
  const width = Math.min(texels, LOOKUP_TEXELS_PER_ROW);
  const result = new DataTexture(data, width, Math.ceil(texels / width), RGBAFormat, FloatType);
  result.magFilter = NearestFilter;
  result.minFilter = NearestFilter;
  result.generateMipmaps = false;
  result.flipY = false;
  result.unpackAlignment = 1;
  result.colorSpace = NoColorSpace;
  result.needsUpdate = true;
  return result;
}

function refreshLookup(node: TextureNode, data: Float32Array): void {
  const current = node.value;
  const image = current.image as { data: Float32Array; width: number; height: number };
  if (image.data.length === data.length) {
    image.data = data;
    current.needsUpdate = true;
    return;
  }
  current.dispose();
  node.value = lookupTexture(data);
}

function lookupLength(texels: number): number {
  const used = Math.max(texels, 1);
  const width = Math.min(used, LOOKUP_TEXELS_PER_ROW);
  return width * Math.ceil(used / width) * LOOKUP_TEXEL_FLOATS;
}

interface InstanceAttributes {
  readonly matrices: InstancedBufferAttribute;
  readonly colors: InstancedBufferAttribute;
}

interface PaletteCounts {
  readonly detailed: LevelGeometryCounts;
  readonly far: LevelGeometryCounts;
}

function levelCountsOf(level: LevelGeometries): LevelGeometryCounts {
  const parts = level.parts.length;
  const present = new Uint8Array(parts);
  const bodyCount = new Uint8Array(parts);
  const fixedCount = new Uint16Array(parts);
  level.parts.forEach((part, p) => {
    if (!part) return;
    present[p] = 1;
    bodyCount[p] = part.body ? 1 : 0;
    fixedCount[p] = part.fixed.length;
  });
  return {
    parts: { present, bodyCount, fixedCount },
    studs: new Uint8Array(level.studs.length).fill(1),
  };
}

type DrawnState = Exclude<ShownState, "hidden">;

class SwapColumns {
  readonly nearGeometry: Array<BufferGeometry | null>;
  readonly nearMaterial: Array<Material | null>;
  readonly shellGeometry: Array<BufferGeometry | null>;
  readonly shellMaterial: Array<Material | null>;
  readonly nearCount: Uint32Array;
  readonly shellCount: Uint32Array;
  readonly shellAtFar: Uint8Array;
  readonly boundingSpheres: Float64Array;

  constructor(
    meshes: MeshPage,
    private readonly shadows: boolean,
  ) {
    const rows = meshes.kind.length;
    this.nearGeometry = Array.from({ length: rows }, (): BufferGeometry | null => null);
    this.nearMaterial = Array.from({ length: rows }, (): Material | null => null);
    this.shellGeometry = Array.from({ length: rows }, (): BufferGeometry | null => null);
    this.shellMaterial = Array.from({ length: rows }, (): Material | null => null);
    this.nearCount = meshes.nearCount;
    this.shellCount = meshes.shellCount;
    this.shellAtFar = meshes.shellAtFar;
    this.boundingSpheres = new Float64Array(rows * MESH_SPHERE_DOUBLES);
  }

  capture(
    row: number,
    state: DrawnState,
    geometry: BufferGeometry,
    material: Material,
    sphere: Sphere | null,
  ): void {
    if (!sphere) throw new Error(`mesh row ${row} has no bounding sphere`);
    const o = row * MESH_SPHERE_DOUBLES + (state === "near" ? 0 : SPHERE_DOUBLES);
    const spheres = this.boundingSpheres;
    spheres[o] = sphere.center.x;
    spheres[o + 1] = sphere.center.y;
    spheres[o + 2] = sphere.center.z;
    spheres[o + 3] = sphere.radius;
    if (state === "near") {
      this.nearGeometry[row] = geometry;
      this.nearMaterial[row] = material;
    } else {
      this.shellGeometry[row] = geometry;
      this.shellMaterial[row] = material;
    }
  }

  show(row: number, mesh: Mesh, sphere: Sphere | null, tier: ChunkTier): void {
    const nearCount = this.nearCount[row] ?? 0;
    const shellCount = this.shellCount[row] ?? 0;
    const state = shownStateOf(nearCount > 0, shellCount > 0, this.shellAtFar[row] === 1, tier);
    mesh.visible = state !== "hidden";
    if (state === "hidden") return;
    const near = state === "near";
    const geometry = near ? this.nearGeometry[row] : this.shellGeometry[row];
    const material = near ? this.nearMaterial[row] : this.shellMaterial[row];
    if (!geometry || !material) throw new Error(`mesh row ${row} has no ${state} state`);
    const count = near ? nearCount : shellCount;
    const countsDiffer = nearCount !== shellCount;
    if (
      mesh.geometry === geometry &&
      mesh.material === material &&
      (!countsDiffer || mesh.count === count)
    ) {
      return;
    }
    mesh.geometry = geometry;
    mesh.material = material;
    if (countsDiffer) mesh.count = count;
    mesh.receiveShadow = this.shadows && !material.transparent;
    if (!sphere) return;
    const o = row * MESH_SPHERE_DOUBLES + (near ? 0 : SPHERE_DOUBLES);
    const spheres = this.boundingSpheres;
    sphere.center.set(spheres[o] ?? 0, spheres[o + 1] ?? 0, spheres[o + 2] ?? 0);
    sphere.radius = spheres[o + 3] ?? 0;
  }
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
    readonly meshCount: number,
    private readonly edgeSlot: number,
    private readonly swaps: SwapColumns | undefined,
    readonly shadowCasters: Group | undefined,
    readonly needs: ChunkNeeds,
    readonly tiered: boolean,
    readonly minX: number,
    readonly maxX: number,
    readonly minZ: number,
    readonly maxZ: number,
    readonly rowSpheres: RowSpheres,
  ) {}

  applyTier(tier: number): void {
    if (tier === this.tier) return;
    this.tier = tier;
    const swaps = this.swaps;
    const name = TIER_NAMES[tier];
    if (!swaps || name === undefined) return;
    const children = this.group.children;
    let ordinal = 0;
    for (let row = 0; row < this.meshCount; row++) {
      const mesh = children[row];
      if (!mesh || !isInstanced(mesh)) continue;
      swaps.show(row, mesh, mesh.boundingSphere, name);
      if (mesh.visible) writeEdgeId(mesh, ordinal++, this.edgeSlot);
    }
  }

  dispose(): void {
    const children = this.group.children;
    for (let row = 0; row < this.meshCount; row++) {
      const mesh = children[row];
      if (mesh && isInstanced(mesh)) mesh.dispose();
    }
    if (this.shadowCasters) disposeInstancedChildren(this.shadowCasters);
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

interface AlphaSlots {
  readonly alphaSlots: number[];
  readonly colorAlphaSlot: Uint8Array<ArrayBuffer>;
}

function alphaSlotsOf(colorsSrgb: Uint8Array, colorsAlpha: Uint8Array): AlphaSlots {
  const colorCount = colorsSrgb.length / COLOR_CHANNELS;
  const alphaSlots = [OPAQUE_ALPHA];
  const colorAlphaSlot = new Uint8Array(colorCount);
  for (let c = 0; c < colorCount; c++) {
    const alpha = colorsAlpha[c] ?? OPAQUE_ALPHA;
    let slot = alphaSlots.indexOf(alpha);
    if (slot < 0) slot = alphaSlots.push(alpha) - 1;
    colorAlphaSlot[c] = slot;
  }
  return { alphaSlots, colorAlphaSlot };
}

function addContainerGroup(parent: Object3D): Group {
  const group = new Group();
  group.matrixAutoUpdate = false;
  parent.add(group);
  return group;
}

function sphereOf(mesh: InstancedMesh | StudMesh): Sphere {
  if (mesh instanceof StudMesh) return mesh.boundingSphere;
  return (mesh.boundingSphere ??= new Sphere());
}

function writeNearEdgeIds(holder: Group, meshes: MeshPage, edgeSlot: number): void {
  let ordinal = 0;
  for (let row = 0; row < meshes.kind.length; row++) {
    const mesh = holder.children[row];
    if (mesh && (meshes.nearCount[row] ?? 0) > 0) writeEdgeId(mesh, ordinal++, edgeSlot);
  }
}

@injectable()
export class ThreeSceneBackend implements ISceneBackend, IThumbnailRenderer {
  private renderer: WebGPURenderer | undefined;
  private readonly scene = new Scene();
  private readonly chunkHolders = new KeyOrderedChildren(this.scene);
  private readonly farModelHolders = new KeyOrderedChildren(this.scene);
  private readonly vehicleHolders = new KeyOrderedChildren(this.scene);
  private readonly ghostGroup = addContainerGroup(this.scene);
  private readonly planOverlayGroup = addContainerGroup(this.scene);
  private readonly issueBoxGroup = addContainerGroup(this.scene);
  private readonly ground = new GroundPlane(
    addContainerGroup(this.scene),
    SKY_COLOR,
    CAMERA_FAR_LDU,
  );
  private readonly selectionGroup = addContainerGroup(this.scene);
  private readonly perspective = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    1,
    CAMERA_NEAR_LDU,
    CAMERA_FAR_LDU,
  );
  private readonly studLookups: StudLookups = {
    studBasisTexture: texture(lookupTexture(new Float32Array(LOOKUP_TEXEL_FLOATS))),
    linearColorTexture: texture(lookupTexture(new Float32Array(LOOKUP_TEXEL_FLOATS))),
  };
  private studBases = new StudBasisTable();
  private readonly mirroredGeometries = new MirroredGeometries();
  private uploadedStudBases = 0;
  private materials = new PlasticMaterials(false, 1, this.studLookups);
  private shellMaterials = new PlasticMaterials(false, 1, this.studLookups);
  private thumbnailStage: Promise<ThumbnailStage> | undefined;
  private ghostMaterials = new PlasticMaterials(false, GHOST_OPACITY, this.studLookups);
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
  private selectionObjects: Anchored[] = [];
  private readonly selectionEdges = new EdgesGeometry(new BoxGeometry(1, 1, 1));
  private readonly selectionMaterial = new LineBasicNodeMaterial({
    color: SELECTION_COLOR,
    depthTest: false,
  });
  private readonly ghostHit = new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshBasicNodeMaterial({
      color: GHOST_HIT_COLOR,
      depthTest: false,
      transparent: true,
      opacity: GHOST_HIT_OPACITY,
    }),
  );
  private ghostHitAnchor: Anchored = { object: this.ghostHit, x: 0, z: 0 };
  private ghostHitShown = false;
  private readonly ghostOutline = new LineSegments(
    new EdgesGeometry(new BoxGeometry(1, 1, 1)),
    new LineBasicNodeMaterial({ color: GHOST_PRECISE_COLOR, depthTest: false }),
  );
  private readonly ghostBox = new Float64Array(BOUNDS_FLOATS);
  private ghostPrecise = false;
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
  private readonly projected = new Vector3();
  private readonly guides = new GuideLines();
  private readonly noteShapes = new NoteShapeLayer();
  private detailedLevel: LevelGeometries = emptyLevel();
  private farLevel: LevelGeometries = emptyLevel();
  private paletteCounts: PaletteCounts | undefined;
  private farModelGeometries: Array<ReadonlyArray<FixedColorGeometry> | undefined> = [];
  private readonly farModelPlacements = new Map<number, FarModelPlacement>();
  private ldrawColorTable: ReadonlyMap<number, LdrawColor> = new Map();
  private ghostPage: InstancePage | null = null;
  private ghostNeeds: ChunkNeeds | null = null;
  private neededMeshListener: NeededMeshListener | null = null;
  private readonly rebuildKeys: number[] = [];
  private ghostModel: ChunkInstances | null = null;
  private readonly ghostPose = new Float64Array(4);
  private ghostPosed = false;
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
  readonly plan = new PlanSceneBackend({
    ldrawColor: (code) => this.ldrawColor(code),
    linearColors: () => this.linearColors,
    studBases: () => this.studBases,
    changed: () => {
      this.changed = true;
    },
  });

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
    renderer.setOpaqueSort(opaqueSort);
    renderer.setTransparentSort(transparentSort);
    this.look = config.look;
    this.materials = new PlasticMaterials(config.look.plastic, 1, this.studLookups);
    this.shellMaterials = new PlasticMaterials(config.look.plastic, 1, this.studLookups);
    const ghostTint = this.ghostMaterials.tint;
    this.ghostMaterials = new PlasticMaterials(
      config.look.plastic,
      GHOST_OPACITY,
      this.studLookups,
    );
    this.ghostMaterials.tint = ghostTint;
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
    this.ghostHit.visible = false;
    this.ghostHit.matrixAutoUpdate = false;
    this.ghostHit.renderOrder = 3;
    this.scene.add(this.ghostHit);
    this.markerGroup.matrixAutoUpdate = false;
    this.scene.add(this.markerGroup);
    this.trackEndGroup.matrixAutoUpdate = false;
    this.scene.add(this.trackEndGroup);
    this.scene.add(this.guides.lines, this.noteShapes.fills, this.noteShapes.lines);
    this.scene.add(this.plan.root);
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
    this.studBases = new StudBasisTable();
    this.uploadedStudBases = 0;
    this.farModelHolders.clear();
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
    this.paletteCounts = undefined;
    this.farModelGeometries = (palette.farModels ?? []).map((mesh) =>
      fixedColorGeometries(mesh, this.linearColor, this.alphaOf),
    );
    this.plan.setStudPrimitives(palette.detailed.studPrimitives);
    this.tiered = palette.far !== undefined;
    this.partBounds = new Float32Array(palette.detailed.parts.length * BOUNDS_FLOATS);
    palette.detailed.parts.forEach((part, p) => this.setPartBounds(p, part));
    this.installColors(palette.colorsSrgb, palette.colorsAlpha);
  }

  private installColors(colorsSrgb: Uint8Array, colorsAlpha: Uint8Array): void {
    const colorCount = colorsSrgb.length / COLOR_CHANNELS;
    this.linearColors = new Float32Array(colorCount * COLOR_CHANNELS);
    const slots = alphaSlotsOf(colorsSrgb, colorsAlpha);
    this.alphaSlots = slots.alphaSlots;
    this.colorAlphaSlot = slots.colorAlphaSlot;
    const lookup = new Float32Array(lookupLength(colorCount));
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
      lookup.set(this.linearColors.subarray(o, o + COLOR_CHANNELS), c * LOOKUP_TEXEL_FLOATS);
      lookup[c * LOOKUP_TEXEL_FLOATS + COLOR_CHANNELS] = 1;
    }
    refreshLookup(this.studLookups.linearColorTexture, lookup);
  }

  setColors(colorsSrgb: Uint8Array, colorsAlpha: Uint8Array): void {
    const { colorAlphaSlot } = alphaSlotsOf(colorsSrgb, colorsAlpha);
    if (!this.everyPage((page) => preservesAlphaSlotSharing(page, colorAlphaSlot))) {
      throw new Error(
        "setColors may only append colours: an existing colour would change which colours share its alpha slot",
      );
    }
    this.changed = true;
    this.installColors(colorsSrgb, colorsAlpha);
    this.rebuildPages(
      () => true,
      (page) => regroupedPage(page, this.linearColors, this.colorAlphaSlot),
    );
  }

  private everyPage(test: (page: InstancePage) => boolean): boolean {
    for (const record of this.chunks.values()) if (!test(record.page)) return false;
    for (const record of this.vehicles.values()) if (!test(record.body.page)) return false;
    return this.ghostPage === null || test(this.ghostPage);
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
    this.paletteCounts = undefined;
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
      this.paletteCounts = undefined;
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
    this.paletteCounts = undefined;
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

  private levelCounts(): PaletteCounts {
    this.paletteCounts ??= {
      detailed: levelCountsOf(this.detailedLevel),
      far: levelCountsOf(this.farLevel),
    };
    return this.paletteCounts;
  }

  private pageFor(instances: ChunkInstances): InstancePage {
    const page = pageOf(instances, this.linearColors, this.colorAlphaSlot, this.studBases);
    if (this.studBases.count !== this.uploadedStudBases) {
      refreshLookup(this.studLookups.studBasisTexture, this.studBases.columns);
      this.uploadedStudBases = this.studBases.count;
    }
    return page;
  }

  setChunk(key: number, chunk: ChunkInstances): void {
    this.changed = true;
    const page = this.pageFor(chunk);
    this.placeChunk(key, page);
    this.plan.setPartPage(key, page);
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
    const needs = samePage ? replaced.needs : pageNeeds(page, this.tiered);
    const record = this.buildChunk(
      page,
      this.tiered ? this.levelCounts().far : undefined,
      needs,
      chunkEdgeSlot(page.originX, page.originZ),
      replaced?.rowSpheres,
    );
    record.key = key;
    record.studPitchPx = this.studPitchPx(record, this.orthoStudPitchPx());
    record.applyTier(this.tierOf(record.studPitchPx));
    this.inheritHolds(record, replaced);
    this.syncNeeds(record);
    this.placeGroup(record.group, page.originX, page.originZ);
    this.chunks.set(key, record);
    this.chunkList.push(record);
    this.chunkHolders.add(record.group, key);
    this.sceneMinX = Math.min(this.sceneMinX, record.minX);
    this.sceneMaxX = Math.max(this.sceneMaxX, record.maxX);
    this.sceneMinZ = Math.min(this.sceneMinZ, record.minZ);
    this.sceneMaxZ = Math.max(this.sceneMaxZ, record.maxZ);
  }

  setVehicle(vehicle: number, model: ChunkInstances): void {
    this.changed = true;
    this.placeVehicleBody(vehicle, this.pageFor(model));
  }

  private placeVehicleBody(vehicle: number, page: InstancePage): void {
    this.changed = true;
    const replaced = this.vehicles.get(vehicle)?.body;
    const samePage =
      replaced !== undefined && replaced.page === page && replaced.tiered === this.tiered;
    this.removeVehicle(vehicle);
    const needs = samePage ? replaced.needs : pageNeeds(page, false);
    const body = this.buildChunk(
      page,
      undefined,
      needs,
      vehicleEdgeSlot(vehicle),
      replaced?.rowSpheres,
    );
    body.applyTier(TIER_NEAR);
    this.inheritHolds(body, replaced);
    this.syncNeeds(body);
    const group = new Group();
    group.add(body.group);
    const record = new VehicleRecord(group, body);
    this.vehicles.set(vehicle, record);
    this.vehicleHolders.add(group, vehicle);
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
    this.vehicleHolders.remove(existing.group);
    existing.body.dispose();
    this.vehicles.delete(vehicle);
  }

  deleteChunk(key: number): void {
    this.changed = true;
    const record = this.chunks.get(key);
    if (record) this.releaseHolds(record);
    this.removeChunk(key);
    this.plan.setPartPage(key, null);
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
    this.chunkHolders.remove(existing.group);
    existing.dispose();
    this.chunks.delete(key);
    this.chunkList = this.chunkList.filter((record) => record !== existing);
  }

  setGhost(model: ChunkInstances | null): void {
    if (model === this.ghostModel) return;
    this.ghostModel = model;
    this.changed = true;
    this.showGhost(model ? this.pageFor(model) : null);
  }

  private showGhost(page: InstancePage | null): void {
    this.changed = true;
    if (this.ghost) {
      this.ghostGroup.clear();
      disposeInstancedChildren(this.ghost);
      this.ghost = undefined;
    }
    const held = this.ghostNeeds;
    const samePage = page !== null && page === this.ghostPage;
    this.ghostPosed = false;
    this.ghostPage = page;
    this.ghostNeeds = null;
    this.showGhostHit();
    if (!page) {
      if (held) this.release(held, TIER_NEAR);
      return;
    }
    const ghost = new Group();
    ghost.matrixAutoUpdate = false;
    ghost.visible = false;
    const ghostMeshes = this.addNearInstances(ghost, page, this.ghostMaterials);
    writeNearEdgeIds(ghost, ghostMeshes, GHOST_EDGE_SLOT);
    this.outlineGhost(ghost, page);
    this.ghost = ghost;
    this.ghostGroup.add(ghost);
    if (samePage && held) {
      this.ghostNeeds = held;
      return;
    }
    const needs = pageNeeds(page, false);
    this.neededMeshListener?.hold(needs.detailedAt(TIER_NEAR), needs.farAt(TIER_NEAR));
    if (held) this.release(held, TIER_NEAR);
    this.ghostNeeds = needs;
  }

  private rebuildGhost(page: InstancePage): void {
    const posed = this.ghostPosed;
    this.showGhost(page);
    const pose = this.ghostPose;
    if (posed) this.placeGhost(pose[0] ?? 0, pose[1] ?? 0, pose[2] ?? 0, pose[3] ?? 0);
  }

  placeGhost(x: number, yLdu: number, z: number, rot: number): void {
    const ghost = this.ghost;
    const pose = this.ghostPose;
    if (
      ghost &&
      ghost.visible &&
      this.ghostPosed &&
      pose[0] === x &&
      pose[1] === yLdu &&
      pose[2] === z &&
      pose[3] === rot
    ) {
      return;
    }
    this.changed = true;
    if (!ghost) return;
    pose[0] = x;
    pose[1] = yLdu;
    pose[2] = z;
    pose[3] = rot;
    this.ghostPosed = true;
    this.ghostX = x;
    this.ghostZ = z;
    ghost.position.set(x - this.renderOriginX, yLdu, z - this.renderOriginZ);
    ghost.rotation.set(0, rot * QUARTER_TURN_RADIANS, 0);
    ghost.updateMatrix();
    ghost.updateMatrixWorld(true);
    ghost.visible = true;
    this.showGhostHit();
  }

  setGhostVerdict(verdict: GhostVerdict | null): void {
    this.changed = true;
    const tint = verdict?.tone ? GHOST_TINTS[verdict.tone] : UNTINTED;
    if (tint !== this.ghostMaterials.tint) this.ghostMaterials.tint = tint;
    this.ghostPrecise = verdict?.precise ?? false;
    this.ghostOutline.visible = this.ghostPrecise;
    const box = verdict?.hit ?? null;
    this.ghostHitShown = box !== null;
    if (box) {
      this.ghostHit.scale.set(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
      this.ghostHit.position.y = (box.minY + box.maxY) / 2;
      this.ghostHitAnchor = {
        object: this.ghostHit,
        x: (box.minX + box.maxX) / 2,
        z: (box.minZ + box.maxZ) / 2,
      };
      this.positionAnchored(this.ghostHitAnchor);
    }
    this.showGhostHit();
  }

  private outlineGhost(ghost: Group, page: InstancePage): void {
    const box = pageBox(page, this.partBounds, this.ghostBox);
    const x0 = box[0] ?? 0;
    const y0 = box[1] ?? 0;
    const z0 = box[2] ?? 0;
    const x1 = box[3] ?? 0;
    const y1 = box[4] ?? 0;
    const z1 = box[5] ?? 0;
    const outline = this.ghostOutline;
    outline.matrixAutoUpdate = false;
    outline.renderOrder = 2;
    outline.visible = this.ghostPrecise;
    outline.scale.set(x1 - x0, y1 - y0, z1 - z0);
    outline.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    outline.updateMatrix();
    ghost.add(outline);
  }

  private showGhostHit(): void {
    this.ghostHit.visible = this.ghostHitShown && this.ghostPosed;
  }

  setSelectionBoxes(boxes: ReadonlyArray<WorldBox>): void {
    this.changed = true;
    this.selectionObjects = this.outlineBoxes(
      this.selectionGroup,
      this.selectionObjects,
      boxes,
      this.selectionEdges,
      this.selectionMaterial,
      SELECTION_RENDER_ORDER,
    );
  }

  setMarkers(markers: ReadonlyArray<EdgeMarker>): void {
    if (markers === this.markers) return;
    this.changed = true;
    this.markerGroup.clear();
    this.markers = markers;
    for (const marker of markers) {
      const mesh = new Mesh(this.markerBox, this.markerMaterials[marker.kind]);
      mesh.matrixAutoUpdate = false;
      this.markerGroup.add(mesh);
    }
    this.positionMarkers();
    this.plan.setMarkers(markers);
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
    if (markers === this.trackEnds) return;
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

  setGround(ground: GroundSettings | null): void {
    this.changed = true;
    this.ground.configure(ground);
    this.aimGround();
  }

  private aimGround(): void {
    const centreX = this.atX - this.renderOriginX;
    const centreZ = this.atZ - this.renderOriginZ;
    if (this.camera === this.orthographic) {
      this.ground.followOrthographic(
        centreX,
        centreZ,
        this.orthoHalfHeight * this.aspect,
        this.orthoHalfHeight,
      );
      return;
    }
    this.ground.followPerspective(
      centreX,
      centreZ,
      Math.hypot(this.eyeX - this.atX, this.eyeY - this.atY, this.eyeZ - this.atZ),
    );
  }

  setPlanOverlays(overlays: ReadonlyArray<PlanOverlay>): void {
    this.changed = true;
    this.planOverlayGroup.clear();
    for (const anchored of this.planObjects) disposeTree(anchored.object);
    this.planObjects = overlays.map((overlay) => this.planGroup(overlay));
    for (const anchored of this.planObjects) {
      this.positionAnchored(anchored);
      this.planOverlayGroup.add(anchored.object);
    }
  }

  private tableMaterial(srgb: number): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial({ roughness: 0.8 });
    material.colorNode = this.ground.griddedTop(srgb);
    return material;
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
    const tableMaterials = new Map<number, MeshStandardNodeMaterial>();
    for (const table of overlay.tables) {
      const srgb = table.srgb ?? TABLE_COLOR;
      const material = tableMaterials.get(srgb) ?? this.tableMaterial(srgb);
      tableMaterials.set(srgb, material);
      group.add(boxMesh(table, x, z, material));
    }
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
    this.issueObjects = this.outlineBoxes(
      this.issueBoxGroup,
      this.issueObjects,
      boxes,
      this.issueEdges,
      this.issueMaterial,
      ISSUE_RENDER_ORDER,
    );
  }

  private outlineBoxes(
    group: Group,
    shown: ReadonlyArray<Anchored>,
    boxes: ReadonlyArray<WorldBox>,
    edges: EdgesGeometry,
    material: LineBasicNodeMaterial,
    renderOrder: number,
  ): Anchored[] {
    for (let i = boxes.length; i < shown.length; i++) {
      const extra = shown[i];
      if (extra) group.remove(extra.object);
    }
    return boxes.map((box, i) => {
      const reused = shown[i]?.object;
      const lines = reused ?? new LineSegments(edges, material);
      if (!reused) {
        lines.matrixAutoUpdate = false;
        lines.renderOrder = renderOrder;
        group.add(lines);
      }
      lines.scale.set(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
      lines.position.y = (box.minY + box.maxY) / 2;
      const anchored = {
        object: lines,
        x: (box.minX + box.maxX) / 2,
        z: (box.minZ + box.maxZ) / 2,
      };
      this.positionAnchored(anchored);
      return anchored;
    });
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

  setGuides(segments: ReadonlyArray<GuideSegment>): void {
    this.changed = true;
    this.guides.set(segments);
    this.guides.place(this.renderOriginX, this.renderOriginZ);
  }

  setNoteShapes(shapes: NoteShapes): void {
    this.changed = true;
    this.noteShapes.set(shapes);
    this.noteShapes.place(this.renderOriginX, this.renderOriginZ);
  }

  projectToNdc(x: number, y: number, z: number, out: Float64Array, offset: number): void {
    const point = this.projected
      .set(x - this.renderOriginX, y, z - this.renderOriginZ)
      .project(this.camera);
    out[offset + PROJECTED_NDC_X] = point.x;
    out[offset + PROJECTED_NDC_Y] = point.y;
    out[offset + PROJECTED_IN_VIEW] =
      point.z > -NDC_DEPTH_LIMIT && point.z < NDC_DEPTH_LIMIT ? 1 : 0;
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
    this.plan.clearPartPages();
    for (const [vehicle, record] of this.vehicles) {
      this.releaseHolds(record.body);
      this.removeVehicle(vehicle);
    }
  }

  private buildChunk(
    page: InstancePage,
    far: LevelGeometryCounts | undefined,
    needs: ChunkNeeds,
    edgeSlot: number,
    replacedSpheres: RowSpheres | undefined,
  ): ChunkRecord {
    const group = new Group();
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const meshes = meshPageOf(page, this.levelCounts().detailed, far);
    const swaps = far ? new SwapColumns(meshes, this.look.shadows) : undefined;
    const shadowCasters = this.look.shadows ? new Group() : undefined;
    const reuse: SphereReuse = {
      replaced: replacedSpheres,
      built: new RowSpheres(page, meshes.kind.length),
    };
    this.addInstances(
      group,
      page,
      meshes,
      this.materials,
      this.shellMaterials,
      swaps,
      shadowCasters,
      reuse,
    );
    const meshCount = group.children.length;
    if (!swaps) writeNearEdgeIds(group, meshes, edgeSlot);
    if (shadowCasters) group.add(shadowCasters);
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
      meshCount,
      edgeSlot,
      swaps,
      shadowCasters,
      needs,
      this.tiered,
      minX,
      maxX,
      minZ,
      maxZ,
      reuse.built,
    );
    return record;
  }

  private pageAttributes(page: InstancePage, start: number, end: number): InstanceAttributes {
    return {
      matrices: new InstancedBufferAttribute(matricesOf(page, start, end), MATRIX4_FLOATS),
      colors: new InstancedBufferAttribute(linearColorsOf(page, start, end), COLOR_CHANNELS),
    };
  }

  private addNearInstances(
    holder: Group,
    page: InstancePage,
    materials: PlasticMaterials,
  ): MeshPage {
    const meshes = meshPageOf(page, this.levelCounts().detailed, undefined);
    this.addInstances(holder, page, meshes, materials, materials, undefined, undefined, undefined);
    return meshes;
  }

  private addInstances(
    holder: Group,
    page: InstancePage,
    meshes: MeshPage,
    materials: PlasticMaterials,
    shellMaterials: PlasticMaterials,
    swaps: SwapColumns | undefined,
    shadowCasters: Group | undefined,
    reuse: SphereReuse | undefined,
  ): void {
    let views: InstanceAttributes | undefined;
    let viewsStart = -1;
    let viewsEnd = -1;
    for (let row = 0; row < meshes.kind.length; row++) {
      const start = meshes.start[row] ?? 0;
      const end = start + Math.max(meshes.nearCount[row] ?? 0, meshes.shellCount[row] ?? 0);
      if (meshes.kind[row] === MESH_KIND_STUD) {
        const studMesh = this.studRow(
          page,
          meshes,
          row,
          start,
          end,
          materials,
          shellMaterials,
          swaps,
          reuse,
        );
        shareIdentityOnParent(studMesh, holder);
        holder.add(studMesh);
        continue;
      }
      if (!views || start !== viewsStart || end !== viewsEnd) {
        views = this.pageAttributes(page, start, end);
        viewsStart = start;
        viewsEnd = end;
      }
      const partMesh = this.partRow(meshes, row, views, materials, shellMaterials, swaps, reuse);
      shareIdentityOnParent(partMesh, holder);
      holder.add(partMesh);
      if (shadowCasters && !this.tiered) this.addShadowCaster(shadowCasters, meshes, row, views);
    }
    if (shadowCasters && this.tiered) this.addBoundsProxies(shadowCasters, page);
  }

  private partGeometry(level: LevelGeometries, meshes: MeshPage, row: number): BufferGeometry {
    const part = level.parts[meshes.shape[row] ?? 0];
    const geometry =
      meshes.kind[row] === MESH_KIND_BODY
        ? part?.body
        : part?.fixed[meshes.geometryIndex[row] ?? 0]?.geometry;
    if (!geometry) throw new Error(`mesh row ${row} names a geometry its level does not have`);
    return this.handed(geometry, meshes, row);
  }

  private handed(geometry: BufferGeometry, meshes: MeshPage, row: number): BufferGeometry {
    return meshes.mirrored[row] === 1 ? this.mirroredGeometries.of(geometry) : geometry;
  }

  private partMaterial(
    level: LevelGeometries,
    meshes: MeshPage,
    row: number,
    materials: PlasticMaterials,
  ): MeshStandardNodeMaterial {
    if (meshes.kind[row] === MESH_KIND_BODY) {
      return materials.instanceColored(this.alphaSlots[meshes.alphaSlot[row] ?? 0] ?? OPAQUE_ALPHA);
    }
    const fixed = level.parts[meshes.shape[row] ?? 0]?.fixed[meshes.geometryIndex[row] ?? 0];
    return materials.vertexColored(fixed?.alpha ?? OPAQUE_ALPHA);
  }

  private shellLevel(meshes: MeshPage, row: number): LevelGeometries {
    return meshes.shellFromDetailed[row] === 1 ? this.detailedLevel : this.farLevel;
  }

  private partRow(
    meshes: MeshPage,
    row: number,
    views: InstanceAttributes,
    materials: PlasticMaterials,
    shellMaterials: PlasticMaterials,
    swaps: SwapColumns | undefined,
    reuse: SphereReuse | undefined,
  ): InstancedMesh {
    const nearCount = meshes.nearCount[row] ?? 0;
    const shellCount = meshes.shellCount[row] ?? 0;
    const firstLevel = nearCount > 0 ? this.detailedLevel : this.shellLevel(meshes, row);
    const geometry = this.partGeometry(firstLevel, meshes, row);
    const mesh = this.instancedMesh(
      geometry,
      this.partMaterial(firstLevel, meshes, row, materials),
      Math.max(nearCount, shellCount),
      views.matrices,
      meshes.kind[row] === MESH_KIND_BODY ? views.colors : undefined,
    );
    if (!swaps) {
      this.fillSphere(
        mesh,
        geometry,
        meshes.kind[row] ?? 0,
        meshes.start[row] ?? 0,
        mesh.count,
        reuse,
      );
      return mesh;
    }
    if (nearCount > 0) {
      this.capturePartState(
        mesh,
        swaps,
        meshes,
        row,
        "near",
        this.detailedLevel,
        nearCount,
        materials,
        reuse,
      );
    }
    if (shellCount > 0) {
      const level = this.shellLevel(meshes, row);
      this.capturePartState(
        mesh,
        swaps,
        meshes,
        row,
        "shell",
        level,
        shellCount,
        shellMaterials,
        reuse,
      );
    }
    return mesh;
  }

  private capturePartState(
    mesh: InstancedMesh,
    swaps: SwapColumns,
    meshes: MeshPage,
    row: number,
    state: DrawnState,
    level: LevelGeometries,
    count: number,
    materials: PlasticMaterials,
    reuse: SphereReuse | undefined,
  ): void {
    const geometry = this.partGeometry(level, meshes, row);
    mesh.geometry = geometry;
    mesh.count = count;
    this.fillSphere(mesh, geometry, meshes.kind[row] ?? 0, meshes.start[row] ?? 0, count, reuse);
    swaps.capture(
      row,
      state,
      geometry,
      this.partMaterial(level, meshes, row, materials),
      mesh.boundingSphere,
    );
  }

  private addShadowCaster(
    layer: Group,
    meshes: MeshPage,
    row: number,
    views: InstanceAttributes,
  ): void {
    if ((this.alphaSlots[meshes.alphaSlot[row] ?? 0] ?? OPAQUE_ALPHA) !== OPAQUE_ALPHA) return;
    const part = this.detailedLevel.parts[meshes.shape[row] ?? 0];
    const body = meshes.kind[row] === MESH_KIND_BODY;
    const fixed = body ? undefined : part?.fixed[meshes.geometryIndex[row] ?? 0];
    if (!body && fixed?.alpha !== OPAQUE_ALPHA) return;
    const mesh = this.instancedMesh(
      this.partGeometry(this.detailedLevel, meshes, row),
      body
        ? this.materials.instanceColored(OPAQUE_ALPHA)
        : this.materials.vertexColored(OPAQUE_ALPHA),
      meshes.nearCount[row] ?? 0,
      views.matrices,
      undefined,
    );
    mesh.computeBoundingSphere();
    mesh.layers.set(SHADOW_LAYER);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    shareIdentityOnParent(mesh, layer);
    layer.add(mesh);
  }

  private studRow(
    page: InstancePage,
    meshes: MeshPage,
    row: number,
    start: number,
    end: number,
    materials: PlasticMaterials,
    shellMaterials: PlasticMaterials,
    swaps: SwapColumns | undefined,
    reuse: SphereReuse | undefined,
  ): StudMesh {
    const primitive = meshes.shape[row] ?? 0;
    const detailedPrimitive = this.detailedLevel.studs[primitive];
    if (!detailedPrimitive)
      throw new Error(`mesh row ${row} names a stud primitive that is missing`);
    const alpha = this.alphaSlots[meshes.alphaSlot[row] ?? 0] ?? OPAQUE_ALPHA;
    const material = materials.basisInstanced(alpha);
    const translations = new InstancedBufferAttribute(
      studTranslationsOf(page, start, end),
      TRANSLATION_FLOATS,
    );
    const basisAndColorIndex = new InstancedBufferAttribute(
      studBasisAndColorIndexOf(page, start, end),
      1,
    );
    const nearSource = this.handed(detailedPrimitive, meshes, row);
    const near = studGeometry(nearSource, translations, basisAndColorIndex);
    const mesh = new StudMesh(near, material, translations, basisAndColorIndex, this.studBases);
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = this.look.shadows && !material.transparent;
    const count = end - start;
    this.fillSphere(mesh, nearSource, MESH_KIND_STUD, start, count, reuse);
    if (!swaps) return mesh;
    swaps.capture(row, "near", near, material, mesh.boundingSphere);
    const coarsePrimitive = this.farLevel.studs[primitive];
    if ((meshes.shellCount[row] ?? 0) === 0 || !coarsePrimitive) return mesh;
    const shellSource = this.handed(coarsePrimitive, meshes, row);
    const shell = studGeometry(shellSource, translations, basisAndColorIndex);
    mesh.geometry = shell;
    this.fillSphere(mesh, shellSource, MESH_KIND_STUD, start, count, reuse);
    swaps.capture(row, "shell", shell, shellMaterials.basisInstanced(alpha), mesh.boundingSphere);
    return mesh;
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
    mesh.computeBoundingSphere();
    mesh.layers.set(SHADOW_LAYER);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    shareIdentityOnParent(mesh, layer);
    layer.add(mesh);
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
    return mesh;
  }

  private fillSphere(
    mesh: InstancedMesh | StudMesh,
    source: BufferGeometry,
    kind: number,
    start: number,
    count: number,
    reuse: SphereReuse | undefined,
  ): void {
    if (!reuse) {
      mesh.computeBoundingSphere();
      return;
    }
    const { replaced, built } = reuse;
    const sphere = sphereOf(mesh);
    const index = replaced ? replaced.match(built, source, kind, start, count) : NO_MATCH;
    if (replaced && index !== NO_MATCH) replaced.copyTo(index, sphere);
    else mesh.computeBoundingSphere();
    built.append(source, kind, start, count, sphere);
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
    this.aimGround();
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
    for (const anchored of this.selectionObjects) this.positionAnchored(anchored);
    this.positionAnchored(this.ghostHitAnchor);
    for (const record of this.vehicles.values()) this.placeVehicle(record);
    this.positionMarkers();
    this.positionTrackEnds();
    for (const anchored of this.planObjects) this.positionAnchored(anchored);
    for (const anchored of this.issueObjects) this.positionAnchored(anchored);
    this.guides.place(this.renderOriginX, this.renderOriginZ);
    this.noteShapes.place(this.renderOriginX, this.renderOriginZ);
    this.plan.place(this.renderOriginX, this.renderOriginZ);
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
    this.aimGround();
    this.changed = true;
  };

  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return this.rebases;
  }

  async renderThumbnail({ model, box, sizePx }: ThumbnailRequest): Promise<string> {
    const stage = await (this.thumbnailStage ??= this.createThumbnailStage());
    stage.renderer.setSize(sizePx, sizePx, false);
    const group = new Group();
    const page = this.pageFor(model);
    this.addNearInstances(group, page, this.materials);
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
    this.aimGround();
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
      this.farModelHolders.remove(existing.group);
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
    this.farModelHolders.add(group, id);
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
    const flat = this.camera === this.orthographic;
    for (let i = 0; i < this.chunkList.length; i++) {
      const record = this.chunkList[i];
      if (!record) continue;
      record.studPitchPx = this.studPitchPx(record, orthoStudPitchPx);
      if (flat) continue;
      const tier = this.tierOf(record.studPitchPx);
      if (tier === record.tier) continue;
      this.changed = true;
      if (record.needsRebuild) {
        this.rebuildKeys.push(record.key);
        continue;
      }
      record.applyTier(tier);
      this.syncNeeds(record);
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
    const flat = this.camera === this.orthographic;
    this.chunkHolders.show(!flat);
    this.farModelHolders.show(!flat);
    this.markerGroup.visible = !flat;
    this.plan.root.visible = flat;
    if (flat) this.plan.prepare(this.orthoStudPitchPx());
    renderer.info.reset();
    const lookPipeline = this.camera === this.perspective ? this.pipeline : undefined;
    this.noteShapes.showFills(lookPipeline === undefined);
    if (lookPipeline) lookPipeline.render();
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
