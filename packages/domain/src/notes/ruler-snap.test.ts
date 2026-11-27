import type { PlacementRecordV1, RulerEndV2 } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import { rulerEndPoint } from "./note-state.ts";
import { NO_SNAP_MODEL, snapRulerEnd, type SnapModel } from "./ruler-snap.ts";

const REACH = 15;
const SEPARATION = 40;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function placed(x: number, z: number, rot: number): PlacementRecordV1 {
  return { ref: "import:cottage", color: 4, x, z, yPlates: 2, rot };
}

function namedPlacement(end: RulerEndV2): PlacementRecordV1 | null {
  if (end.on !== "model") return null;
  const { offsetX: _x, offsetZ: _z, on: _on, ...named } = end;
  return named;
}

function model(
  placement: PlacementRecordV1,
  [minX, minZ, maxX, maxZ]: readonly [number, number, number, number],
  under = false,
): SnapModel {
  return { placement, minX, minZ, maxX, maxZ, under };
}

describe("ruler end snapping", () => {
  it("attaches to the exact corner, edge middle or centre of a model's box near the cursor, for any pose", () => {
    const next = lcg(7);
    const coordinate = (): number => (next() % 2001) - 1000;
    for (let sample = 0; sample < 200; sample++) {
      const placement = placed(coordinate() * 20, coordinate() * 20, next() % 4);
      const minX = placement.x - 2 * (next() % 50) - SEPARATION;
      const minZ = placement.z - 2 * (next() % 50) - SEPARATION;
      const maxX = placement.x + 2 * (next() % 50) + SEPARATION;
      const maxZ = placement.z + 2 * (next() % 50) + SEPARATION;
      const features = [
        { x: minX, z: maxZ, kind: "corner" },
        { x: (minX + maxX) / 2, z: minZ, kind: "edge" },
        { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, kind: "centre" },
      ];
      for (const feature of features) {
        const snapped = snapRulerEnd(feature.x + 3, feature.z - 4, REACH, [
          model(placement, [minX, minZ, maxX, maxZ]),
        ]);
        expect({
          kind: snapped.kind,
          at: rulerEndPoint(snapped.end),
          model: snapped.model,
          names: namedPlacement(snapped.end),
        }).toEqual({
          kind: feature.kind,
          at: { x: feature.x, z: feature.z },
          model: 0,
          names: placement,
        });
      }
    }
  });

  it("takes the nearest feature across every model near the cursor", () => {
    const left = model(placed(0, 0, 0), [-40, -20, 40, 20]);
    const right = model(placed(100, 0, 1), [60, -20, 140, 20]);

    const snapped = snapRulerEnd(52, 18, REACH, [left, right]);

    expect([snapped.model, rulerEndPoint(snapped.end)]).toEqual([1, { x: 60, z: 20 }]);
  });

  it("never snaps to a feature that isn't a whole LDU, and falls back to the stud under the cursor on that model", () => {
    const odd = model(placed(0, 0, 0), [-30, -20, 15, 20], true);

    const snapped = snapRulerEnd(-7, -19, REACH, [odd]);

    expect({ kind: snapped.kind, on: snapped.end.on, at: rulerEndPoint(snapped.end) }).toEqual({
      kind: "stud",
      on: "model",
      at: { x: 0, z: -20 },
    });
  });

  it("is a free point on the nearest stud when no feature is in reach and no model is under the cursor", () => {
    const far = model(placed(0, 0, 0), [-40, -20, 40, 20]);

    const snapped = snapRulerEnd(129, -71, REACH, [far]);

    expect(snapped).toEqual({
      end: { on: "point", x: 120, z: -80 },
      x: 120,
      z: -80,
      kind: "point",
      model: NO_SNAP_MODEL,
    });
  });
});
