import {
  attribute,
  cameraViewMatrix,
  mat3,
  mat4,
  normalLocal,
  positionLocal,
  select,
  varying,
  vec3,
} from "three/tsl";
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  InterpolationSamplingMode,
  InterpolationSamplingType,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  Uint32BufferAttribute,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Node,
  type NodeBuilder,
  type Sphere,
} from "three/webgpu";
import type { TrackEndKind, TrackEndMarker } from "../scene-backend.ts";
import { MATRIX4_FLOATS } from "./instance-page.ts";
import { ProjectedOpaqueOrder } from "./projected-opaque-order.ts";

const TRACK_END_GROUP_ORDER = 3;
const TRACK_END_RENDER_ORDER = 3;
const TRACK_END_COLORS: Readonly<Record<TrackEndKind, number>> = {
  open: 0xffb000,
  gap: 0xe0202a,
  target: 0x1fbf4a,
};
const ARROW_RADIUS_LDU = 16;
const ARROW_LENGTH_LDU = 30;
const ARROW_LIFT_LDU = 44;
const ARROW_SEGMENTS = 12;
const POST_WIDTH_LDU = 8;
const POST_HEIGHT_LDU = 96;

const HEAD = 0;
const POST = 1;
const PARTS_PER_ARROW: ArrowTemplate["partSpheres"]["length"] = 2;
const XYZ_FLOATS = 3;
const MATRIX4_COLUMN_FLOATS = 4;
const MATRIX3_FLOATS = 9;
const SLOT_NORMAL_OFFSET = MATRIX4_FLOATS;
const SLOT_COLOR_OFFSET = SLOT_NORMAL_OFFSET + MATRIX3_FLOATS;
const SLOT_PART_OFFSET = SLOT_COLOR_OFFSET + XYZ_FLOATS;
const SLOT_FLOATS = SLOT_PART_OFFSET + 1;

const ENDS_GROUP_WORLD = new Matrix4();
const PART_LOCAL = new Matrix4();

const VERTEX_PART = "vertexPart";
const SLOT_WORLD = ["slotWorld0", "slotWorld1", "slotWorld2", "slotWorld3"] as const;
const SLOT_NORMAL = ["slotNormal0", "slotNormal1", "slotNormal2"] as const;
const SLOT_COLOR = "slotColor";
const SLOT_PART = "slotPart";

interface ArrowTemplate {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly vertexParts: Float32Array;
  readonly indices: Uint32Array;
  readonly partSpheres: readonly [Sphere, Sphere];
}

function headGeometry(): ConeGeometry {
  const cone = new ConeGeometry(ARROW_RADIUS_LDU, ARROW_LENGTH_LDU, ARROW_SEGMENTS);
  cone.rotateZ(-Math.PI / 2);
  cone.translate(ARROW_LENGTH_LDU / 2, ARROW_LIFT_LDU, 0);
  return cone;
}

function postGeometry(): BoxGeometry {
  const post = new BoxGeometry(POST_WIDTH_LDU, POST_HEIGHT_LDU, POST_WIDTH_LDU);
  post.translate(0, POST_HEIGHT_LDU / 2, 0);
  return post;
}

function indicesOf(geometry: BufferGeometry): ArrayLike<number> {
  const index = geometry.index;
  if (!index) throw new Error("an arrow part has no index");
  return index.array;
}

function boundingSphereOf(geometry: BufferGeometry): Sphere {
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (!sphere) throw new Error("an arrow part has no bounding sphere");
  return sphere.clone();
}

function arrowTemplate(): ArrowTemplate {
  const head = headGeometry();
  const post = postGeometry();
  const headVertices = head.getAttribute("position").count;
  const postVertices = post.getAttribute("position").count;
  const headIndex = indicesOf(head);
  const postIndex = indicesOf(post);
  const positions = new Float32Array((headVertices + postVertices) * XYZ_FLOATS);
  const normals = new Float32Array(positions.length);
  const vertexParts = new Float32Array(headVertices + postVertices);
  const indices = new Uint32Array(headIndex.length + postIndex.length);
  positions.set(head.getAttribute("position").array);
  positions.set(post.getAttribute("position").array, headVertices * XYZ_FLOATS);
  normals.set(head.getAttribute("normal").array);
  normals.set(post.getAttribute("normal").array, headVertices * XYZ_FLOATS);
  vertexParts.fill(POST, headVertices);
  for (let i = 0; i < headIndex.length; i++) indices[i] = headIndex[i] ?? 0;
  for (let i = 0; i < postIndex.length; i++) {
    indices[headIndex.length + i] = (postIndex[i] ?? 0) + headVertices;
  }
  const partSpheres = [boundingSphereOf(head), boundingSphereOf(post)] as const;
  head.dispose();
  post.dispose();
  return { positions, normals, vertexParts, indices, partSpheres };
}

function markerAt(markers: ReadonlyArray<TrackEndMarker>, arrow: number): TrackEndMarker {
  const marker = markers[arrow];
  if (!marker) throw new Error(`track-end marker ${arrow} is missing`);
  return marker;
}

function slotWorld(): Node<"mat4"> {
  const [column0, column1, column2, column3] = SLOT_WORLD;
  return mat4(
    attribute(column0, "vec4"),
    attribute(column1, "vec4"),
    attribute(column2, "vec4"),
    attribute(column3, "vec4"),
  );
}

function slotNormalMatrix(): Node<"mat3"> {
  const [column0, column1, column2] = SLOT_NORMAL;
  return mat3(attribute(column0, "vec3"), attribute(column1, "vec3"), attribute(column2, "vec3"));
}

class SlotBuffer extends InstancedInterleavedBuffer {
  private readonly uploadRange = { start: 0, count: 0 };

  constructor(array: Float32Array, stride: number) {
    super(array, stride);
    this.updateRanges.push(this.uploadRange);
  }

  uploadSlots(slots: number): void {
    this.uploadRange.count = slots * this.stride;
    this.needsUpdate = true;
  }

  override clearUpdateRanges(): void {}
}

class TrackEndArrowMaterial extends MeshBasicNodeMaterial {
  constructor() {
    super({ depthTest: false });
    this.colorNode = varying(attribute(SLOT_COLOR, "vec3")).setInterpolation(
      InterpolationSamplingType.FLAT,
      InterpolationSamplingMode.EITHER,
    );
  }

  override setupPosition(builder: NodeBuilder): Node {
    const position = super.setupPosition(builder);
    normalLocal.assign(slotNormalMatrix().mul(normalLocal));
    return position;
  }

  override setupPositionView(): Node<"vec3"> {
    const viewPosition = cameraViewMatrix.mul(slotWorld()).mul(positionLocal).xyz;
    const inSlotsPart = attribute(VERTEX_PART, "float").equal(attribute(SLOT_PART, "float"));
    return select(inSlotsPart, viewPosition, vec3(0));
  }
}

export class TrackEndArrows {
  readonly group = new Group();
  private readonly mesh: Mesh<InstancedBufferGeometry, TrackEndArrowMaterial>;
  private readonly template = arrowTemplate();
  private readonly projection = new ProjectedOpaqueOrder();
  private readonly kindColors: Readonly<Record<TrackEndKind, Color>> = {
    open: new Color(TRACK_END_COLORS.open),
    gap: new Color(TRACK_END_COLORS.gap),
    target: new Color(TRACK_END_COLORS.target),
  };
  private markers: ReadonlyArray<TrackEndMarker> = [];
  private arrowCount = 0;
  private records = new Float32Array(0);
  private worlds = new Float64Array(0);
  private slots = new SlotBuffer(new Float32Array(0), SLOT_FLOATS);
  private readonly arrowPosition = new Vector3();
  private readonly arrowTurn = new Euler();
  private readonly arrowQuaternion = new Quaternion();
  private readonly unitScale = new Vector3(1, 1, 1);
  private readonly arrowLocal = new Matrix4();
  private readonly arrowWorld = new Matrix4();
  private readonly partWorld = new Matrix4();
  private readonly partNormal = new Matrix3();

  constructor() {
    this.group.renderOrder = TRACK_END_GROUP_ORDER;
    this.group.matrixAutoUpdate = false;
    this.mesh = new Mesh(this.geometryFor(this.slots), new TrackEndArrowMaterial());
    this.mesh.renderOrder = TRACK_END_RENDER_ORDER;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => this.orderSlots(camera);
    this.group.add(this.mesh);
  }

  set(markers: ReadonlyArray<TrackEndMarker>): void {
    for (let arrow = 0; arrow < markers.length; arrow++) markerAt(markers, arrow);
    this.markers = markers;
    this.arrowCount = markers.length;
    const items = this.arrowCount * PARTS_PER_ARROW;
    if (items > this.slots.count) this.reserve(items);
    for (let arrow = 0; arrow < this.arrowCount; arrow++) {
      const color = this.kindColors[markerAt(markers, arrow).kind];
      for (let part = HEAD; part <= POST; part++) {
        const record = (arrow * PARTS_PER_ARROW + part) * SLOT_FLOATS;
        this.records[record + SLOT_COLOR_OFFSET] = color.r;
        this.records[record + SLOT_COLOR_OFFSET + 1] = color.g;
        this.records[record + SLOT_COLOR_OFFSET + 2] = color.b;
        this.records[record + SLOT_PART_OFFSET] = part;
      }
    }
    this.mesh.visible = items > 0;
  }

  place(renderOriginX: number, renderOriginZ: number): void {
    for (let arrow = 0; arrow < this.arrowCount; arrow++) {
      const marker = markerAt(this.markers, arrow);
      this.arrowPosition.set(marker.xLdu - renderOriginX, marker.yLdu, marker.zLdu - renderOriginZ);
      this.arrowTurn.set(0, -marker.headingRadians, 0);
      this.arrowQuaternion.setFromEuler(this.arrowTurn);
      this.arrowLocal.compose(this.arrowPosition, this.arrowQuaternion, this.unitScale);
      this.arrowWorld.multiplyMatrices(ENDS_GROUP_WORLD, this.arrowLocal);
      this.partWorld.multiplyMatrices(this.arrowWorld, PART_LOCAL);
      this.partNormal.getNormalMatrix(this.partWorld);
      const world = this.partWorld.elements;
      const normal = this.partNormal.elements;
      for (let f = 0; f < MATRIX4_FLOATS; f++) {
        this.worlds[arrow * MATRIX4_FLOATS + f] = world[f] ?? 0;
      }
      for (let part = HEAD; part <= POST; part++) {
        const record = (arrow * PARTS_PER_ARROW + part) * SLOT_FLOATS;
        for (let f = 0; f < MATRIX4_FLOATS; f++) this.records[record + f] = world[f] ?? 0;
        for (let f = 0; f < MATRIX3_FLOATS; f++) {
          this.records[record + SLOT_NORMAL_OFFSET + f] = normal[f] ?? 0;
        }
      }
    }
  }

  private orderSlots(camera: Camera): void {
    const items = this.arrowCount * PARTS_PER_ARROW;
    const visible = this.projection.project(camera, this.worlds, this.template.partSpheres, items);
    this.mesh.geometry.instanceCount = visible;
    if (visible === 0) return;
    const order = this.projection.visibleItems;
    const slots = this.slots.array;
    for (let slot = 0; slot < visible; slot++) {
      const from = (order[slot] ?? 0) * SLOT_FLOATS;
      const to = slot * SLOT_FLOATS;
      for (let f = 0; f < SLOT_FLOATS; f++) slots[to + f] = this.records[from + f] ?? 0;
    }
    this.slots.uploadSlots(visible);
  }

  private reserve(items: number): void {
    let capacity = Math.max(this.slots.count, PARTS_PER_ARROW);
    while (capacity < items) capacity *= 2;
    this.records = new Float32Array(capacity * SLOT_FLOATS);
    this.worlds = new Float64Array((capacity / PARTS_PER_ARROW) * MATRIX4_FLOATS);
    this.slots = new SlotBuffer(new Float32Array(capacity * SLOT_FLOATS), SLOT_FLOATS);
    this.projection.reserve(capacity);
    const previous = this.mesh.geometry;
    this.mesh.geometry = this.geometryFor(this.slots);
    previous.dispose();
  }

  private geometryFor(slots: SlotBuffer): InstancedBufferGeometry {
    const { positions, normals, vertexParts, indices } = this.template;
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(new Uint32BufferAttribute(indices, 1));
    geometry.setAttribute("position", new Float32BufferAttribute(positions, XYZ_FLOATS));
    geometry.setAttribute("normal", new Float32BufferAttribute(normals, XYZ_FLOATS));
    geometry.setAttribute(VERTEX_PART, new Float32BufferAttribute(vertexParts, 1));
    SLOT_WORLD.forEach((name, column) => {
      const offset = column * MATRIX4_COLUMN_FLOATS;
      geometry.setAttribute(
        name,
        new InterleavedBufferAttribute(slots, MATRIX4_COLUMN_FLOATS, offset),
      );
    });
    SLOT_NORMAL.forEach((name, column) => {
      const offset = SLOT_NORMAL_OFFSET + column * XYZ_FLOATS;
      geometry.setAttribute(name, new InterleavedBufferAttribute(slots, XYZ_FLOATS, offset));
    });
    geometry.setAttribute(
      SLOT_COLOR,
      new InterleavedBufferAttribute(slots, XYZ_FLOATS, SLOT_COLOR_OFFSET),
    );
    geometry.setAttribute(SLOT_PART, new InterleavedBufferAttribute(slots, 1, SLOT_PART_OFFSET));
    geometry.instanceCount = 0;
    return geometry;
  }
}
