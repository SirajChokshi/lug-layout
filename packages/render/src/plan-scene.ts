import type { PlanGlyph } from "@brr/schema/bundle";

export interface PlanSprite {
  readonly glyph: PlanGlyph;
  readonly inheritedColor: number;
  readonly shiftX: number;
  readonly shiftZ: number;
}

export const PLAN_POSE_X = 0;
export const PLAN_POSE_Z = 1;
export const PLAN_POSE_Y = 2;
export const PLAN_POSE_ROT = 3;
export const PLAN_POSE_FLOATS = 4;

export interface PlanInstances {
  readonly originX: number;
  readonly originZ: number;
  readonly count: number;
  readonly sprite: Uint32Array;
  readonly pose: Float32Array;
}

export interface PlanPartLines {
  readonly topY: number;
  readonly outline: Float32Array;
  readonly centre: Float32Array;
}

export interface IPlanSceneBackend {
  setSprite(id: number, sprite: PlanSprite): void;
  setPlacements(key: number, instances: PlanInstances): void;
  deletePlacements(key: number): void;
  setPartLines(partIndex: number, lines: PlanPartLines): void;
}
