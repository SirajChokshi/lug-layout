import { HALF_TURN_16, POSE16_IDENTITY, pose16, zeta16 } from "@brr/math";
import { expect, it } from "vitest";
import { TrackLayout, type TrackPieceSpec } from "./track-layout.ts";

function straight(studs: bigint): TrackPieceSpec {
  return {
    connectors: [
      pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), HALF_TURN_16),
      pose16(zeta16([studs, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0),
    ],
    routes: [{ from: 0, to: 1 }],
  };
}

it("swaps a placement to a piece with the same ends and refuses one whose ends differ", () => {
  const layout = new TrackLayout([straight(16n), straight(16n), straight(17n)]);
  const placed = layout.place(0, POSE16_IDENTITY, 0);
  const before = layout.connectorPose(placed, 1);
  layout.replace(placed, 1);
  expect(layout.piece(placed)).toBe(1);
  expect(layout.connectorPose(placed, 1)).toEqual(before);
  expect(() => layout.replace(placed, 2)).toThrow(RangeError);
  expect(layout.piece(placed)).toBe(1);
});
