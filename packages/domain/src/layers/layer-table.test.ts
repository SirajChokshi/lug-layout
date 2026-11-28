import { BASE_LAYER, BASE_LAYER_ID, LAYER_ID_MAX } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import { LayerTable } from "./layer-table.ts";

function table(layers: unknown): LayerTable {
  const decoded = LayerTable.of(layers, "layers");
  if (!decoded.ok) throw new Error(`fixture table refused: ${JSON.stringify(decoded.issues)}`);
  return decoded.value;
}

function created(from: LayerTable, name: string) {
  const result = from.created(name, "parts");
  if (!result.ok) throw new Error(`layer refused: ${JSON.stringify(result.issues)}`);
  return result.value;
}

const SCENERY = {
  id: 4,
  name: "Scenery",
  kind: "parts",
  visible: false,
  locked: true,
  opacity: 40,
};
const PLAN = { id: 9, name: "Tables", kind: "plan", visible: true, locked: false, opacity: 100 };

describe("LayerTable", () => {
  it("adds a layer on top, shown, unlocked and opaque, with the next id and its name trimmed", () => {
    const { table: grown, id } = created(table([BASE_LAYER, SCENERY, PLAN]), "  Track  ");

    expect(id).toBe(10);
    expect(grown.layers.map((layer) => layer.id)).toEqual([BASE_LAYER_ID, 4, 9, 10]);
    expect(grown.layer(10)).toEqual({
      id: 10,
      name: "Track",
      kind: "parts",
      visible: true,
      locked: false,
      opacity: 100,
    });
  });

  it("takes the lowest free id once the highest id is used", () => {
    const top = { ...PLAN, id: LAYER_ID_MAX };

    expect(created(table([BASE_LAYER, top]), "Gap").id).toBe(1);
  });

  it("reads hidden and locked from the table, and neither for an id it doesn't list", () => {
    const layers = table([BASE_LAYER, SCENERY]);

    expect([layers.isHidden(4), layers.isLocked(4)]).toEqual([true, true]);
    expect([layers.isHidden(BASE_LAYER_ID), layers.isLocked(BASE_LAYER_ID)]).toEqual([
      false,
      false,
    ]);
    expect([layers.isHidden(5), layers.isLocked(LAYER_ID_MAX)]).toEqual([false, false]);
  });

  it("changes one layer's name, visibility, lock or opacity and leaves the others as they were", () => {
    const layers = table([BASE_LAYER, SCENERY, PLAN]);
    const patched = layers.patched(4, { name: " Yard ", visible: true, locked: false, opacity: 0 });

    expect(patched.ok && patched.value.layers).toEqual([
      BASE_LAYER,
      { ...SCENERY, name: "Yard", visible: true, locked: false, opacity: 0 },
      PLAN,
    ]);
    expect(layers.layer(4)).toEqual(SCENERY);
  });

  it("hands back the same table for a change that changes nothing", () => {
    const layers = table([BASE_LAYER, SCENERY]);
    const same = layers.patched(4, { name: "Scenery", visible: false, opacity: 40 });

    expect(same.ok && same.value).toBe(layers);
    const unmoved = layers.movedTo(4, 1);
    expect(unmoved.ok && unmoved.value).toBe(layers);
  });

  it("refuses a blank or overlong name, an opacity outside 0-100 or a fraction, and an unlisted layer", () => {
    const layers = table([BASE_LAYER, SCENERY]);
    const refusals = [
      layers.created("   ", "parts"),
      layers.created("x".repeat(201), "notes"),
      layers.patched(4, { name: "" }),
      layers.patched(4, { opacity: 101 }),
      layers.patched(4, { opacity: 12.5 }),
      layers.patched(5, { visible: true }),
    ];

    expect(refusals.map((result) => result.ok)).toEqual([false, false, false, false, false, false]);
    expect(refusals.at(-1)).toEqual({
      ok: false,
      issues: [{ path: "layer 5", message: "isn't in the layer table" }],
    });
  });

  it("moves a layer to any position in the drawing order, the base layer included", () => {
    const layers = table([BASE_LAYER, SCENERY, PLAN]);
    const ids = (position: number, id: number) => {
      const moved = layers.movedTo(id, position);
      return moved.ok ? moved.value.layers.map((layer) => layer.id) : moved.issues;
    };

    expect(ids(0, 9)).toEqual([9, BASE_LAYER_ID, 4]);
    expect(ids(2, BASE_LAYER_ID)).toEqual([4, 9, BASE_LAYER_ID]);
    expect(ids(3, 4)).toEqual([
      { path: "layer 4", message: "can only move to a position 0-2, not 3" },
    ]);
    expect(ids(-1, 4)).toEqual([
      { path: "layer 4", message: "can only move to a position 0-2, not -1" },
    ]);
  });
});
