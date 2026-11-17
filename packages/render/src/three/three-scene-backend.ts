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
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGPURenderer,
  type BufferGeometry,
} from "three/webgpu";
import {
  CAMERA_FOV_DEGREES,
  COLOR_CHANNELS,
  INSTANCE_MATRIX_FLOATS,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type EdgeMarker,
  type MarkerKind,
  type GeometrySet,
  type FrameStats,
  type ISceneBackend,
  type PartPalette,
  type PlanOverlay,
  type RebaseEvent,
  type SceneBackendConfig,
  type StudInstances,
  type TrackEndKind,
  type TrackEndMarker,
  type WorldBox,
} from "../scene-backend.ts";
import { CHUNK_LDU, chunkOf } from "@brr/math";
import { GpuBufferTally } from "./gpu-buffer-tally.ts";
import { fixedColorGeometry, inheritBodyGeometry, primitiveGeometry } from "./part-geometry.ts";

const MATRIX4_FLOATS = 16;
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
const TRACK_END_ARROW_RADIUS_LDU = 26;
const TRACK_END_ARROW_LENGTH_LDU = 70;
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

interface InstanceMaterials {
  readonly body: MeshStandardNodeMaterial;
  readonly fixed: MeshStandardNodeMaterial;
}

function plasticMaterials(ghost: boolean): InstanceMaterials {
  const translucent = ghost ? { transparent: true, opacity: GHOST_OPACITY, depthWrite: false } : {};
  return {
    body: new MeshStandardNodeMaterial({
      roughness: PLASTIC_ROUGHNESS,
      metalness: 0,
      ...translucent,
    }),
    fixed: new MeshStandardNodeMaterial({
      roughness: PLASTIC_ROUGHNESS,
      metalness: 0,
      vertexColors: true,
      ...translucent,
    }),
  };
}

function disposeInstancedChildren(layer: Group): void {
  for (const child of layer.children) {
    if (child instanceof InstancedMesh) child.dispose();
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

class VehicleRecord {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;

  constructor(
    readonly group: Group,
    readonly body: ChunkRecord,
  ) {}
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
  private readonly solid = plasticMaterials(false);
  private readonly ghostMaterials = plasticMaterials(true);
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
  private detailedLevel: LevelGeometries = EMPTY_LEVEL;
  private farLevel: LevelGeometries = EMPTY_LEVEL;
  private linearColors = new Float32Array(0);
  private readonly chunks = new Map<number, ChunkRecord>();
  private readonly vehicles = new Map<number, VehicleRecord>();
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
    this.setGhost(null);
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

  setVehiclePose(vehicle: number, x: number, y: number, z: number, yaw: number): void {
    const record = this.vehicles.get(vehicle);
    if (!record) throw new Error(`vehicle ${vehicle} has no model`);
    record.x = x;
    record.y = y;
    record.z = z;
    record.yaw = yaw;
    this.placeVehicle(record);
  }

  private placeVehicle(record: VehicleRecord): void {
    record.group.position.set(
      record.x - this.renderOriginX,
      record.y,
      record.z - this.renderOriginZ,
    );
    record.group.rotation.y = -record.yaw;
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
    disposeInstancedChildren(existing.detailed);
    disposeInstancedChildren(existing.shellBodies);
    disposeInstancedChildren(existing.coarseStuds);
    this.chunks.delete(key);
    this.chunkList = this.chunkList.filter((record) => record !== existing);
  }

  setGhost(model: ChunkInstances | null): void {
    if (this.ghost) {
      this.scene.remove(this.ghost);
      disposeInstancedChildren(this.ghost);
      this.ghost = undefined;
    }
    if (!model) return;
    const ghost = new Group();
    ghost.matrixAutoUpdate = false;
    ghost.visible = false;
    this.addInstances(ghost, undefined, undefined, model, this.ghostMaterials);
    this.ghost = ghost;
    this.scene.add(ghost);
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
    this.rayPoint.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
    out[0] = camera.position.x + this.renderOriginX;
    out[1] = camera.position.y;
    out[2] = camera.position.z + this.renderOriginZ;
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
    const coarseStuds = new Group();
    group.add(detailed, shellBodies, coarseStuds);
    this.addInstances(detailed, shellBodies, coarseStuds, chunk, this.solid);
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

  private addInstances(
    detailed: Group,
    shellBodies: Group | undefined,
    coarseStuds: Group | undefined,
    chunk: ChunkInstances,
    materials: InstanceMaterials,
  ): void {
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
      this.addPartMeshes(detailed, this.detailedLevel.parts[p], count, attributes, materials);
      if (shellBodies) {
        this.addPartMeshes(shellBodies, this.farLevel.parts[p], count, attributes, materials);
      }
    }
    this.addStudMeshes(chunk.studs, detailed, coarseStuds, materials.body);
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
    materials: InstanceMaterials,
  ): void {
    if (geometries?.body) {
      layer.add(
        this.instancedMesh(
          geometries.body,
          materials.body,
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
          materials.fixed,
          count,
          attributes.matrices,
          undefined,
        ),
      );
    }
  }

  private addStudMeshes(
    studs: StudInstances,
    detailed: Group,
    coarse: Group | undefined,
    material: MeshStandardNodeMaterial,
  ): void {
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
