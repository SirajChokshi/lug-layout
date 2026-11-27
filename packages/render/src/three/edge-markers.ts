import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Group,
  InstancedBufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type TypedArray,
} from "three/webgpu";
import type { EdgeMarker, MarkerKind } from "../scene-backend.ts";
import {
  addSlotAttributes,
  OVERLAY_SLOT_FLOATS,
  OverlaySlotMaterial,
  SlotBuffer,
  writeSlotColor,
  writeSlotMatrices,
  XYZ_FLOATS,
} from "./overlay-slots.ts";
import { EDGE_MARKER_RENDER_ORDER } from "./render-orders.ts";

const EDGE_MARKER_COLORS: Readonly<Record<MarkerKind, number>> = {
  joined: 0x1fbf4a,
  open: 0xffb000,
  mismatch: 0xe0202a,
};
const UNTURNED = new Quaternion();

interface BoxTemplate {
  readonly positions: TypedArray;
  readonly normals: TypedArray;
  readonly indices: TypedArray;
}

function unitBox(): BoxTemplate {
  const box = new BoxGeometry(1, 1, 1);
  const index = box.getIndex();
  if (!index) throw new Error("the unit box has no index");
  const template = {
    positions: box.getAttribute("position").array,
    normals: box.getAttribute("normal").array,
    indices: index.array,
  };
  box.dispose();
  return template;
}

function markerAt(markers: ReadonlyArray<EdgeMarker>, slot: number): EdgeMarker {
  const marker = markers[slot];
  if (!marker) throw new Error(`edge marker ${slot} is missing`);
  return marker;
}

export class EdgeMarkers {
  readonly group = new Group();
  private readonly mesh: Mesh<InstancedBufferGeometry, OverlaySlotMaterial>;
  private readonly template = unitBox();
  private readonly kindColors: Readonly<Record<MarkerKind, Color>> = {
    joined: new Color(EDGE_MARKER_COLORS.joined),
    open: new Color(EDGE_MARKER_COLORS.open),
    mismatch: new Color(EDGE_MARKER_COLORS.mismatch),
  };
  private markers: ReadonlyArray<EdgeMarker> = [];
  private markerCount = 0;
  private records = new Float32Array(0);
  private slots = new SlotBuffer(this.records, OVERLAY_SLOT_FLOATS);
  private readonly centre = new Vector3();
  private readonly size = new Vector3();
  private readonly world = new Matrix4();
  private readonly normal = new Matrix3();

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.mesh = new Mesh(this.geometryFor(this.slots), new OverlaySlotMaterial());
    this.mesh.renderOrder = EDGE_MARKER_RENDER_ORDER;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  set(markers: ReadonlyArray<EdgeMarker>, renderOriginX: number, renderOriginZ: number): void {
    for (let slot = 0; slot < markers.length; slot++) markerAt(markers, slot);
    this.markers = markers;
    this.markerCount = markers.length;
    if (this.markerCount > this.slots.count) this.reserve(this.markerCount);
    for (let slot = 0; slot < this.markerCount; slot++) {
      const color = this.kindColors[markerAt(markers, slot).kind];
      writeSlotColor(this.records, slot * OVERLAY_SLOT_FLOATS, color);
    }
    this.mesh.geometry.instanceCount = this.markerCount;
    this.mesh.visible = this.markerCount > 0;
    this.place(renderOriginX, renderOriginZ);
  }

  place(renderOriginX: number, renderOriginZ: number): void {
    for (let slot = 0; slot < this.markerCount; slot++) {
      const { box } = markerAt(this.markers, slot);
      this.centre.set(
        (box.minX + box.maxX) / 2 - renderOriginX,
        (box.minY + box.maxY) / 2,
        (box.minZ + box.maxZ) / 2 - renderOriginZ,
      );
      this.size.set(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
      this.world.compose(this.centre, UNTURNED, this.size);
      this.normal.getNormalMatrix(this.world);
      writeSlotMatrices(this.records, slot * OVERLAY_SLOT_FLOATS, this.world, this.normal);
    }
    this.slots.uploadSlots(this.markerCount);
  }

  private reserve(count: number): void {
    let capacity = Math.max(this.slots.count, 1);
    while (capacity < count) capacity *= 2;
    this.records = new Float32Array(capacity * OVERLAY_SLOT_FLOATS);
    this.slots = new SlotBuffer(this.records, OVERLAY_SLOT_FLOATS);
    const previous = this.mesh.geometry;
    this.mesh.geometry = this.geometryFor(this.slots);
    previous.dispose();
  }

  private geometryFor(slots: SlotBuffer): InstancedBufferGeometry {
    const { positions, normals, indices } = this.template;
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.setAttribute("position", new BufferAttribute(positions, XYZ_FLOATS));
    geometry.setAttribute("normal", new BufferAttribute(normals, XYZ_FLOATS));
    addSlotAttributes(geometry, slots);
    geometry.instanceCount = 0;
    return geometry;
  }
}
