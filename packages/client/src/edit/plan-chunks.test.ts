import { NO_TRACK_CHANGE, type AppliedEdit, type PlacementHandle } from "@brr/domain";
import { CHUNK_LDU, PLATE_LDU, chunkKey, chunkOf } from "@brr/math";
import { decodePlanGlyph } from "@brr/schema/bundle";
import { expect, it } from "vitest";
import { RecordingBackend } from "../plan/plan-sync.test-support.ts";
import { fixtureModelChecks } from "./fixture-model.test-support.ts";
import type { Placeable } from "./placeable.ts";
import { PlacedChunks } from "./placed-chunks.ts";
import { RecordingPlanScene } from "./plan-scene.test-support.ts";

const MODEL = "brick-2x4";
const AT_X = 330;
const AT_Z = 950;
const Y_PLATES = 2;
const QUARTER_TURNS = 1;

function u32(value: number): ReadonlyArray<number> {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
}

function onePixelGlyph(code: number): Uint8Array {
  return Uint8Array.from([
    ..."BRRGLYF1".split("").map((char) => char.charCodeAt(0)),
    8,
    4,
    ...u32(0),
    ...u32(0),
    ...u32(1),
    ...u32(1),
    ...u32(1),
    ...u32(code),
    ...u32(1),
    0,
    16,
    0,
    ...u32(1),
    0,
    0,
    0,
    0,
    ...u32(4),
    8,
    8,
    7,
    7,
  ]);
}

function handleAt(): PlacementHandle {
  return {
    chunkKey: 0,
    slot: 0,
    generation: 0,
    live: true,
    refId: 0,
    colorId: 0,
    x: AT_X,
    z: AT_Z,
    yPlates: Y_PLATES,
    rot: QUARTER_TURNS,
    layer: 0,
  };
}

function edit(kind: "place" | "remove", handle: PlacementHandle): AppliedEdit {
  const placing = kind === "place";
  return {
    kind,
    step: "do",
    changes: [
      {
        placement: { handle: null },
        from: null,
        to: placing
          ? {
              refId: 0,
              colorId: 0,
              x: AT_X,
              z: AT_Z,
              yPlates: Y_PLATES,
              rot: QUARTER_TURNS,
              layer: 0,
            }
          : null,
        removed: placing ? null : handle,
        added: placing ? handle : null,
      },
    ],
    consists: [],
    track: NO_TRACK_CHANGE,
    plan: null,
    notes: null,
    event: null,
    layers: null,
  };
}

function highestPartTop(placeable: Placeable): number {
  let top = Number.NEGATIVE_INFINITY;
  for (let b = 4; b < placeable.partBoxes.length; b += 6) {
    top = Math.max(top, placeable.partBoxes[b] ?? 0);
  }
  return top;
}

it("draws a placed model's glyph at its handle's pose on its highest part once the glyph arrives, and withdraws it when removed", async () => {
  const { pending, checked } = await fixtureModelChecks(MODEL);
  const glyph = onePixelGlyph(4);
  const withGlyph = { ...checked, glyph };
  const plan = new RecordingPlanScene();
  const placed = new PlacedChunks(new RecordingBackend(), plan);
  const handle = handleAt();
  placed.apply(edit("place", handle), () => pending);
  const beforeGlyph = [...plan.placements.keys()];
  placed.replacePlaceable(pending, withGlyph);
  const shown = [...plan.placements].map(([key, instances]) => ({
    key,
    origin: [instances.originX, instances.originZ],
    sprite: [...instances.sprite].map((id) => plan.sprites.get(id)),
    pose: [...instances.pose],
  }));
  placed.apply(edit("remove", handle), () => withGlyph);
  const decoded = decodePlanGlyph(glyph);
  if (!decoded.ok) throw new Error("the test glyph doesn't decode");
  const originX = chunkOf(AT_X) * CHUNK_LDU;
  const originZ = chunkOf(AT_Z) * CHUNK_LDU;

  expect({ beforeGlyph, shown, afterRemoval: [...plan.placements.keys()] }).toEqual({
    beforeGlyph: [],
    shown: [
      {
        key: chunkKey(chunkOf(AT_X), chunkOf(AT_Z)),
        origin: [originX, originZ],
        sprite: [
          {
            glyph: decoded.value,
            inheritedColor: checked.worldColor,
            shiftX: checked.frameShift[0],
            shiftZ: checked.frameShift[2],
          },
        ],
        pose: [
          AT_X - originX,
          AT_Z - originZ,
          Y_PLATES * PLATE_LDU + highestPartTop(checked),
          QUARTER_TURNS,
        ],
      },
    ],
    afterRemoval: [],
  });
});
