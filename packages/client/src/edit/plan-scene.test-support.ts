import type { IPlanSceneBackend, PlanInstances, PlanPartLines, PlanSprite } from "@brr/render";

export class RecordingPlanScene implements IPlanSceneBackend {
  readonly sprites = new Map<number, PlanSprite>();
  readonly placements = new Map<number, PlanInstances>();
  readonly partLines = new Map<number, PlanPartLines>();

  setSprite(id: number, sprite: PlanSprite): void {
    this.sprites.set(id, sprite);
  }

  setPlacements(key: number, instances: PlanInstances): void {
    this.placements.set(key, instances);
  }

  deletePlacements(key: number): void {
    this.placements.delete(key);
  }

  setPartLines(partIndex: number, lines: PlanPartLines): void {
    this.partLines.set(partIndex, lines);
  }
}
