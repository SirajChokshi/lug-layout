import { chunkOf } from "@brr/math";
import type { Node, Object3D } from "three/webgpu";
import { floor, vec4 } from "three/tsl";

export const ID_MODULUS = 2048;
export const NOT_A_PART = 0;
export const GHOST_EDGE_SLOT = 9;

const EDGE_ID_KEY = "edgeId";
const CHUNK_EDGE_SLOT_SPAN = 3;
const FIRST_VEHICLE_EDGE_SLOT = GHOST_EDGE_SLOT + 1;
const VEHICLE_EDGE_SLOTS = 6;
const EDGE_SLOT_COUNT = FIRST_VEHICLE_EDGE_SLOT + VEHICLE_EDGE_SLOTS;
const EDGE_SLOT_STEP = ID_MODULUS / EDGE_SLOT_COUNT;

function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export function chunkEdgeSlot(originX: number, originZ: number): number {
  return (
    CHUNK_EDGE_SLOT_SPAN * positiveMod(chunkOf(originZ), CHUNK_EDGE_SLOT_SPAN) +
    positiveMod(chunkOf(originX), CHUNK_EDGE_SLOT_SPAN)
  );
}

export function vehicleEdgeSlot(vehicle: number): number {
  return FIRST_VEHICLE_EDGE_SLOT + positiveMod(vehicle, VEHICLE_EDGE_SLOTS);
}

export function packEdgeId(ordinal: number, edgeSlot: number): number {
  const edgeSlotOffset = edgeSlot * EDGE_SLOT_STEP;
  const meshId = 1 + ((ordinal + edgeSlotOffset) % ID_MODULUS);
  return meshId * ID_MODULUS + edgeSlotOffset;
}

export function writeEdgeId(object: Object3D, ordinal: number, edgeSlot: number): void {
  object.userData[EDGE_ID_KEY] = packEdgeId(ordinal, edgeSlot);
}

export function edgeIdOf(object: Object3D): number {
  const edgeId: unknown = object.userData[EDGE_ID_KEY];
  return typeof edgeId === "number" ? edgeId : NOT_A_PART;
}

export function unpackEdgeId(edgeId: Node<"float">, instance: Node<"float">): Node<"vec4"> {
  const meshId = floor(edgeId.div(ID_MODULUS));
  const instanceId = instance.add(edgeId.mod(ID_MODULUS)).mod(ID_MODULUS);
  return vec4(meshId, instanceId, 0, 1);
}
