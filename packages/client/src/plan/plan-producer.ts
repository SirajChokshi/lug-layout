import {
  BOX_MAX_X,
  BOX_MAX_Y,
  BOX_MAX_Z,
  BOX_MIN_X,
  BOX_MIN_Y,
  BOX_MIN_Z,
  BOX_PLAN_UNREADABLE,
  BOX_STRIDE,
  BOX_Y_UNREADABLE,
  LABEL_AT,
  MODEL_SEGMENT,
  WRITE_ADD,
  WRITE_UPDATE,
  type PlanDelta,
} from "@brr/domain";
import type { WorldBox } from "@brr/render";

export interface PlanModelSource {
  readonly id: number;
  readonly handle: {
    readonly chunkKey: number;
    readonly slot: number;
    readonly x: number;
    readonly z: number;
  };
  readonly placeable: { readonly id: string; readonly label: string };
  readonly box: WorldBox;
}

export interface PlanTrackSource {
  readonly pieceCount: number;
  writeFootprint(piece: number, delta: PlanDelta, kind: number): void;
}

export interface PlanViewUpdate {
  readonly added: ReadonlyArray<PlanModelSource>;
  readonly removed: ReadonlyArray<PlanModelSource>;
}

const READ: unique symbol = Symbol("read");

function readPlanFields(delta: PlanDelta, at: number, box: WorldBox): unknown {
  try {
    delta.box[at + BOX_MIN_X] = box.minX;
    delta.box[at + BOX_MIN_Z] = box.minZ;
    delta.box[at + BOX_MAX_X] = box.maxX;
    delta.box[at + BOX_MAX_Z] = box.maxZ;
    return READ;
  } catch (error) {
    return error;
  }
}

function readHeights(delta: PlanDelta, at: number, box: WorldBox): unknown {
  try {
    delta.box[at + BOX_MIN_Y] = box.minY;
    delta.box[at + BOX_MAX_Y] = box.maxY;
    return READ;
  } catch (error) {
    return error;
  }
}

export function writeModelRow(delta: PlanDelta, kind: number, model: PlanModelSource): void {
  const { handle, placeable, box } = model;
  const entry = delta.write(
    kind,
    MODEL_SEGMENT,
    model.id,
    handle.slot,
    placeable.id,
    LABEL_AT,
    placeable.label,
  );
  delta.chunkKey[entry] = handle.chunkKey;
  delta.labelA[entry] = handle.x;
  delta.labelB[entry] = handle.z;
  const at = entry * BOX_STRIDE;
  const planFields = readPlanFields(delta, at, box);
  if (planFields !== READ) {
    delta.markUnreadable(entry, BOX_PLAN_UNREADABLE, box, planFields);
    return;
  }
  const heights = readHeights(delta, at, box);
  if (heights !== READ) delta.markUnreadable(entry, BOX_Y_UNREADABLE, box, heights);
}

export function writeViewUpdate(delta: PlanDelta, view: PlanViewUpdate): void {
  delta.reset();
  const { removed, added } = view;
  for (let i = 0; i < removed.length; i++) {
    const model = removed[i];
    if (model) delta.remove(MODEL_SEGMENT, model.id);
  }
  for (let i = 0; i < added.length; i++) {
    const model = added[i];
    if (model) writeModelRow(delta, WRITE_ADD, model);
  }
}

export function writeFullRebuild(
  delta: PlanDelta,
  models: ReadonlyArray<PlanModelSource>,
  track: PlanTrackSource | null,
): void {
  delta.reset();
  delta.clearAll();
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (model) writeModelRow(delta, WRITE_ADD, model);
  }
  const pieces = track?.pieceCount ?? 0;
  for (let p = 0; p < pieces; p++) track?.writeFootprint(p, delta, WRITE_ADD);
}

export function writeTrackLay(delta: PlanDelta, track: PlanTrackSource, laid: number): void {
  delta.reset();
  for (let p = track.pieceCount - laid; p < track.pieceCount; p++) {
    track.writeFootprint(p, delta, WRITE_ADD);
  }
}

export function writeTrackThrow(delta: PlanDelta, track: PlanTrackSource, piece: number): void {
  delta.reset();
  track.writeFootprint(piece, delta, WRITE_UPDATE);
}
