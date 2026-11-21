import type { PlacementPose } from "@brr/domain";
import { PLATE_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import { expect, it } from "vitest";
import { groupGhost, type GhostMember } from "./group-ghost.ts";

const TRANSLATION = [3, 7, 11] as const;

function member(pose: PlacementPose, part: number, offsets: ReadonlyArray<number>): GhostMember {
  const count = offsets.length / 3;
  const matrices = new Float32Array(count * INSTANCE_MATRIX_FLOATS);
  for (let i = 0; i < count; i++) {
    matrices.set(
      [
        1,
        0,
        0,
        offsets[i * 3] ?? 0,
        0,
        1,
        0,
        offsets[i * 3 + 1] ?? 0,
        0,
        0,
        1,
        offsets[i * 3 + 2] ?? 0,
      ],
      i * INSTANCE_MATRIX_FLOATS,
    );
  }
  return {
    pose,
    placeable: {
      parts: {
        originX: 0,
        originZ: 0,
        count,
        partIndex: new Uint16Array(count).fill(part),
        colorIndex: new Uint16Array(count).fill(part + 1),
        matrices,
      },
      studs: {
        count: 1,
        primitiveIndex: Uint8Array.of(part),
        colorIndex: Uint16Array.of(part + 1),
        matrices: matrices.slice(0, INSTANCE_MATRIX_FLOATS),
      },
    },
  };
}

function worldOf(
  pose: PlacementPose,
  matrices: Float32Array,
  instance: number,
): ReadonlyArray<number> {
  if (!isRot90(pose.rot)) throw new Error(`rotation ${pose.rot} is not a quarter turn`);
  const cos = rot90Cos(pose.rot);
  const sin = rot90Sin(pose.rot);
  const [x = 0, y = 0, z = 0] = TRANSLATION.map(
    (at) => matrices[instance * INSTANCE_MATRIX_FLOATS + at] ?? 0,
  );
  return [
    pose.x + cos * x + sin * z + 0,
    pose.yPlates * PLATE_LDU + y,
    pose.z - sin * x + cos * z + 0,
  ];
}

it("draws every member's parts and studs at their own place, seen from the lead member", () => {
  const lead: PlacementPose = { refId: 0, colorId: 0, x: 640, z: -320, yPlates: 2, rot: 1 };
  const other: PlacementPose = { refId: 1, colorId: 0, x: -20, z: 400, yPlates: 5, rot: 3 };
  const members = [member(lead, 4, [10, 0, -30]), member(other, 9, [0, 8, 0, -50, 24, 70])];

  const ghost = groupGhost(members, lead);

  const expected = members.flatMap(({ pose, placeable }) =>
    [...Array(placeable.parts.count).keys()].map((i) => worldOf(pose, placeable.parts.matrices, i)),
  );
  const drawn = [...Array(ghost.count).keys()].map((i) => worldOf(lead, ghost.matrices, i));
  expect({
    parts: [...ghost.partIndex],
    colors: [...ghost.colorIndex],
    drawn,
    studs: [...Array(ghost.studs.count).keys()].map((i) => worldOf(lead, ghost.studs.matrices, i)),
  }).toEqual({
    parts: [4, 9, 9],
    colors: [5, 10, 10],
    drawn: expected,
    studs: [expected[0], expected[1]],
  });
});

it("draws a lone model's own instances, and moves them into any other frame", () => {
  const only = member({ refId: 0, colorId: 0, x: 60, z: 0, yPlates: 0, rot: 2 }, 3, [5, 0, 5]);
  const origin: PlacementPose = { refId: -1, colorId: -1, x: 0, z: 0, yPlates: 0, rot: 0 };

  const moved = groupGhost([only], origin);

  expect(groupGhost([only], only.pose).matrices).toBe(only.placeable.parts.matrices);
  expect(worldOf(origin, moved.matrices, 0)).toEqual(
    worldOf(only.pose, only.placeable.parts.matrices, 0),
  );
});
