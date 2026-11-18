import {
  AXIS_NEG_Y,
  AXIS_POS_Y,
  CAP_FAR,
  CAP_ROOT,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  ModelConnectors,
  SECTION_ROUND,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
  type CellVolumes,
  type SnapWindow,
} from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { PLACEMENT_SEARCH, SNAP_MATING, SNAP_SHAPES } from "../tokens.ts";
import { placementChoice, type IPlacementSearch } from "./placement-search.ts";

const HALF = STUD_LDU / 2;
const SLAB_LDU = 4;
const BRICK_LDU = 3 * PLATE_LDU;
const BASEPLATE = 1;
const BRICK = 2;
const PLATE = 3;

interface Fixture {
  readonly search: IPlacementSearch;
  readonly connectors: (parts: ReadonlyArray<ConnectorTable>) => ModelConnectors;
  readonly stud: number;
  readonly receptor: (depth: number) => number;
}

function fixture(): Fixture {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const shapes = container.get(SNAP_SHAPES);
  const mating = container.get(SNAP_MATING);
  return {
    search: container.get(PLACEMENT_SEARCH),
    connectors: (parts) =>
      ModelConnectors.fromParts(
        parts,
        {
          count: parts.length,
          partIndex: parts.map((_, i) => i),
          matrices: Float64Array.from(parts.flatMap(() => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])),
        },
        mating,
      ),
    stud: shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [4]),
    receptor: (depth) => shapes.intern(CAP_FAR, false, [SECTION_ROUND], [6], [depth]),
  };
}

function grid(
  width: number,
  depth: number,
  shape: number,
  gender: number,
  y: number,
  axis: number,
): ConnectorTable {
  const count = width * depth;
  const origin = new Float32Array(count * 3);
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      origin.set([i * STUD_LDU + HALF, y, j * STUD_LDU + HALF], (j * width + i) * 3);
    }
  }
  return new ConnectorTable(
    new Uint16Array(count).fill(shape),
    new Uint8Array(count).fill(gender),
    new Uint8Array(count).fill(SOURCE_SHADOW),
    new Uint8Array(count).fill(STATUS_VERIFIED),
    origin,
    new Int8Array(count).fill(axis),
    new Float32Array(count * 3),
    new Uint16Array(count),
  );
}

function columns(width: number, depth: number, bottom: number, top: number): CellVolumes {
  const count = width * depth;
  return {
    count,
    cellX: Int32Array.from({ length: count }, (_, c) => c % width),
    cellZ: Int32Array.from({ length: count }, (_, c) => Math.floor(c / width)),
    bottomLdu: new Int32Array(count).fill(bottom),
    topLdu: new Int32Array(count).fill(top),
  };
}

function window(x: number, z: number, cells: number): SnapWindow {
  return { x, z, yPlates: 0, rot: 0, cells, plates: 1, turns: 1 };
}

function world(f: Fixture): { plate: ModelConnectors; plateVolumes: CellVolumes } {
  f.search.add(
    BASEPLATE,
    f.connectors([grid(4, 4, f.stud, GENDER_MALE, 0, AXIS_POS_Y)]),
    columns(4, 4, -SLAB_LDU, 0),
    { x: 0, z: 0, yPlates: 0, rot: 0 },
  );
  f.search.add(
    BRICK,
    f.connectors([
      grid(1, 1, f.stud, GENDER_MALE, BRICK_LDU, AXIS_POS_Y),
      grid(1, 1, f.receptor(BRICK_LDU - 4), GENDER_FEMALE, 0, AXIS_NEG_Y),
    ]),
    columns(1, 1, 0, BRICK_LDU),
    { x: 0, z: 0, yPlates: 0, rot: 0 },
  );
  return {
    plate: f.connectors([
      grid(2, 2, f.stud, GENDER_MALE, PLATE_LDU, AXIS_POS_Y),
      grid(2, 2, f.receptor(4), GENDER_FEMALE, 0, AXIS_NEG_Y),
    ]),
    plateVolumes: columns(2, 2, 0, PLATE_LDU),
  };
}

describe("PlacementSearch", () => {
  it("walks past a ranked pose that collides and takes the best pose that fits", () => {
    const f = fixture();
    const { plate, plateVolumes } = world(f);
    const choice = placementChoice();
    f.search.search(plate, plateVolumes, window(0, 0, 1), null, choice);
    expect([
      choice.accepted,
      choice.x,
      choice.z,
      choice.yPlates,
      choice.votes,
      choice.walked,
    ]).toEqual([true, STUD_LDU, 0, 0, 4, 2]);
  });

  it("refuses with the top pose's overlap when every candidate collides, unless that volume is moving", () => {
    const f = fixture();
    const { plate, plateVolumes } = world(f);
    const choice = placementChoice();
    f.search.search(plate, plateVolumes, window(0, 0, 0), null, choice);
    expect([choice.accepted, choice.x, choice.z, choice.votes]).toEqual([false, 0, 0, 4]);
    expect(choice.overlap).toEqual({
      owner: BRICK,
      bottomLdu: 0,
      topLdu: BRICK_LDU,
      cellX: 0,
      cellZ: 0,
      candidateBottomLdu: 0,
      candidateTopLdu: PLATE_LDU,
    });
    f.search.search(plate, plateVolumes, window(0, 0, 0), BRICK, choice);
    expect(choice.accepted).toBe(true);
    f.search.remove(BRICK);
    f.search.search(plate, plateVolumes, window(0, 0, 0), null, choice);
    expect([choice.accepted, choice.votes]).toEqual([true, 4]);
  });

  it("finds the placement that a removal would leave with no mate and not resting on the table", () => {
    const f = fixture();
    const { plate, plateVolumes } = world(f);
    f.search.add(PLATE, plate, plateVolumes, {
      x: 2 * STUD_LDU,
      z: 2 * STUD_LDU,
      yPlates: 0,
      rot: 0,
    });
    const onTable = (placement: number): boolean => placement === BASEPLATE;
    expect(f.search.strandedByRemoval(BASEPLATE, onTable)).toBe(BRICK);
    expect(f.search.strandedByRemoval(BASEPLATE, () => true)).toBeNull();
    f.search.remove(BRICK);
    expect(f.search.strandedByRemoval(BASEPLATE, onTable)).toBe(PLATE);
    expect(f.search.strandedByRemoval(PLATE, onTable)).toBeNull();
    const choice = placementChoice();
    f.search.search(plate, plateVolumes, window(2 * STUD_LDU, 2 * STUD_LDU, 0), PLATE, choice);
    expect([choice.accepted, choice.votes]).toEqual([true, 4]);
  });
});
