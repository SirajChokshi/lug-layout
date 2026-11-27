import { CHUNK_LDU, chunkKey, chunkOf } from "@brr/math";
import {
  PLAN_POSE_FLOATS,
  PLAN_POSE_ROT,
  PLAN_POSE_X,
  PLAN_POSE_Y,
  PLAN_POSE_Z,
  type IPlanSceneBackend,
} from "@brr/render";
import { decodePlanGlyph } from "@brr/schema/bundle";
import { BOX_FLOATS } from "./local-box.ts";
import type { Placeable } from "./placeable.ts";

const BOX_MAX_Y = 4;

export interface PlanPlacement {
  readonly placeable: Placeable;
  readonly x: number;
  readonly z: number;
  readonly yLdu: number;
  readonly rot: number;
}

interface PlanSpriteRef {
  readonly id: number;
  readonly topLdu: number;
}

function bodyTop(placeable: Placeable): number {
  const boxes = placeable.partBoxes;
  let top = Number.NEGATIVE_INFINITY;
  for (let b = 0; b < boxes.length; b += BOX_FLOATS) top = Math.max(top, boxes[b + BOX_MAX_Y] ?? 0);
  return Number.isFinite(top) ? top : placeable.box.max[1];
}

function keyOf(placement: PlanPlacement): number {
  return chunkKey(chunkOf(placement.x), chunkOf(placement.z));
}

export class PlanChunks {
  private readonly byKey = new Map<number, Set<PlanPlacement>>();
  private readonly dirty = new Set<number>();
  private readonly sprites = new Map<string, PlanSpriteRef>();

  constructor(private readonly plan: IPlanSceneBackend) {}

  add(placement: PlanPlacement): void {
    const key = keyOf(placement);
    let placements = this.byKey.get(key);
    if (!placements) {
      placements = new Set();
      this.byKey.set(key, placements);
    }
    placements.add(placement);
    this.dirty.add(key);
  }

  remove(placement: PlanPlacement): void {
    const key = keyOf(placement);
    this.byKey.get(key)?.delete(placement);
    this.dirty.add(key);
  }

  clear(): void {
    for (const key of this.byKey.keys()) this.plan.deletePlacements(key);
    this.byKey.clear();
    this.dirty.clear();
  }

  flush(): void {
    for (const key of this.dirty) this.publish(key);
    this.dirty.clear();
  }

  private publish(key: number): void {
    const placements = this.byKey.get(key) ?? new Set<PlanPlacement>();
    if (placements.size === 0) this.byKey.delete(key);
    let count = 0;
    let originX = 0;
    let originZ = 0;
    for (const placement of placements) {
      if (!this.spriteOf(placement.placeable)) continue;
      originX = chunkOf(placement.x) * CHUNK_LDU;
      originZ = chunkOf(placement.z) * CHUNK_LDU;
      count++;
    }
    if (count === 0) {
      this.plan.deletePlacements(key);
      return;
    }
    const sprite = new Uint32Array(count);
    const pose = new Float32Array(count * PLAN_POSE_FLOATS);
    let i = 0;
    for (const placement of placements) {
      const ref = this.spriteOf(placement.placeable);
      if (!ref) continue;
      const p = i * PLAN_POSE_FLOATS;
      sprite[i] = ref.id;
      pose[p + PLAN_POSE_X] = placement.x - originX;
      pose[p + PLAN_POSE_Z] = placement.z - originZ;
      pose[p + PLAN_POSE_Y] = placement.yLdu + ref.topLdu;
      pose[p + PLAN_POSE_ROT] = placement.rot;
      i++;
    }
    this.plan.setPlacements(key, { originX, originZ, count, sprite, pose });
  }

  private spriteOf(placeable: Placeable): PlanSpriteRef | null {
    const known = this.sprites.get(placeable.id);
    if (known) return known;
    if (!placeable.glyph) return null;
    const decoded = decodePlanGlyph(placeable.glyph);
    if (!decoded.ok) {
      const reasons = decoded.issues.map((issue) => issue.message).join("; ");
      throw new Error(`${placeable.label}'s plan glyph doesn't decode: ${reasons}`);
    }
    const ref = { id: this.sprites.size, topLdu: bodyTop(placeable) };
    this.plan.setSprite(ref.id, {
      glyph: decoded.value,
      inheritedColor: placeable.worldColor,
      shiftX: placeable.frameShift[0],
      shiftZ: placeable.frameShift[2],
    });
    this.sprites.set(placeable.id, ref);
    return ref;
  }
}
