import { expect, it } from "vitest";
import { ChunkNeedsBuilder } from "./chunk-needs.ts";

const NEAR = 0;
const MID = 1;
const FAR = 2;
const UPRIGHT = 1;
const TILTED = 2;
const VOXELIZED_UPRIGHT = 3;

function mixedChunk() {
  const builder = new ChunkNeedsBuilder(3);
  for (const part of [UPRIGHT, TILTED, VOXELIZED_UPRIGHT]) builder.need(NEAR, "detailed", part);
  builder.need(MID, "far", UPRIGHT);
  builder.need(MID, "detailed", TILTED);
  builder.need(MID, "far", VOXELIZED_UPRIGHT);
  builder.need(FAR, "far", UPRIGHT);
  builder.need(FAR, "detailed", TILTED);
  return builder.build();
}

const FAR_LEVEL_LOADED: ReadonlyArray<unknown> = [undefined, {}, {}, {}];
const FAR_LEVEL_EMPTY: ReadonlyArray<unknown> = [];

it.each([
  ["near redraws for an arriving detailed mesh", NEAR, [UPRIGHT], [], FAR_LEVEL_LOADED, true],
  ["near ignores arriving far meshes", NEAR, [], [UPRIGHT, TILTED], FAR_LEVEL_LOADED, false],
  [
    "mid ignores an upright part's detailed mesh once its far mesh is in",
    MID,
    [UPRIGHT],
    [],
    FAR_LEVEL_LOADED,
    false,
  ],
  [
    "mid redraws for an upright part's detailed mesh standing in for a missing far mesh",
    MID,
    [UPRIGHT],
    [],
    FAR_LEVEL_EMPTY,
    true,
  ],
  ["mid redraws for a tilted part's detailed mesh", MID, [TILTED], [], FAR_LEVEL_LOADED, true],
  [
    "mid redraws for a voxelized part's far mesh",
    MID,
    [],
    [VOXELIZED_UPRIGHT],
    FAR_LEVEL_LOADED,
    true,
  ],
  ["mid ignores a tilted part's far mesh", MID, [], [TILTED], FAR_LEVEL_LOADED, false],
  [
    "far ignores a voxelized part's far mesh",
    FAR,
    [],
    [VOXELIZED_UPRIGHT],
    FAR_LEVEL_LOADED,
    false,
  ],
  [
    "far ignores a voxelized part's detailed mesh",
    FAR,
    [VOXELIZED_UPRIGHT],
    [],
    FAR_LEVEL_EMPTY,
    false,
  ],
  ["far redraws for an upright part's far mesh", FAR, [], [UPRIGHT], FAR_LEVEL_LOADED, true],
] as const)("%s", (_case, tier, detailedChanged, farChanged, farLevelParts, draws) => {
  expect(
    mixedChunk().drawsAnyPart(tier, new Set(detailedChanged), new Set(farChanged), farLevelParts),
  ).toBe(draws);
});
