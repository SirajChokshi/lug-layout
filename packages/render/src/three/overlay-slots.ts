import {
  attribute,
  cameraViewMatrix,
  mat3,
  mat4,
  normalLocal,
  positionLocal,
  varying,
} from "three/tsl";
import {
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  InterpolationSamplingMode,
  InterpolationSamplingType,
  MeshBasicNodeMaterial,
  type BufferGeometry,
  type Color,
  type Matrix3,
  type Matrix4,
  type MeshBasicNodeMaterialParameters,
  type Node,
  type NodeBuilder,
} from "three/webgpu";
import { MATRIX4_FLOATS } from "./instance-page.ts";

export const XYZ_FLOATS = 3;
const MATRIX4_COLUMN_FLOATS = 4;
const MATRIX3_FLOATS = 9;
const SLOT_NORMAL_OFFSET = MATRIX4_FLOATS;
const SLOT_COLOR_OFFSET = SLOT_NORMAL_OFFSET + MATRIX3_FLOATS;
export const OVERLAY_SLOT_FLOATS = SLOT_COLOR_OFFSET + XYZ_FLOATS;

const SLOT_WORLD = ["slotWorld0", "slotWorld1", "slotWorld2", "slotWorld3"] as const;
const SLOT_NORMAL = ["slotNormal0", "slotNormal1", "slotNormal2"] as const;
const SLOT_COLOR = "slotColor";

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

export class SlotBuffer extends InstancedInterleavedBuffer {
  private readonly uploadRange = { start: 0, count: 0 };

  constructor(array: Float32Array, stride: number) {
    super(array, stride);
    this.updateRanges.push(this.uploadRange);
  }

  uploadSlots(slots: number): void {
    if (slots === 0) return;
    this.uploadRange.count = slots * this.stride;
    this.needsUpdate = true;
  }

  override clearUpdateRanges(): void {}
}

export class OverlaySlotMaterial extends MeshBasicNodeMaterial {
  constructor(parameters?: Pick<MeshBasicNodeMaterialParameters, "depthTest">) {
    super(parameters);
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
    return cameraViewMatrix.mul(slotWorld()).mul(positionLocal).xyz;
  }
}

export function addSlotAttributes(geometry: BufferGeometry, slots: SlotBuffer): void {
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
}

export function writeSlotMatrices(
  records: Float32Array,
  recordOffset: number,
  world: Matrix4,
  normal: Matrix3,
): void {
  const worldElements = world.elements;
  const normalElements = normal.elements;
  for (let f = 0; f < MATRIX4_FLOATS; f++) records[recordOffset + f] = worldElements[f] ?? 0;
  for (let f = 0; f < MATRIX3_FLOATS; f++) {
    records[recordOffset + SLOT_NORMAL_OFFSET + f] = normalElements[f] ?? 0;
  }
}

export function writeSlotColor(records: Float32Array, recordOffset: number, color: Color): void {
  records[recordOffset + SLOT_COLOR_OFFSET] = color.r;
  records[recordOffset + SLOT_COLOR_OFFSET + 1] = color.g;
  records[recordOffset + SLOT_COLOR_OFFSET + 2] = color.b;
}
