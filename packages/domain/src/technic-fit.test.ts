import type { PartTechnic } from "@brr/schema/bundle";
import { describe, expect, it } from "vitest";
import type { LatticePose } from "./connect/candidate-poses.ts";
import {
  PosedTechnicBuffer,
  TECHNIC_WAIVER_INTS,
  modelTechnic,
  placeTechnicInto,
  technicItemsOverlap,
  technicScratch,
  type PosedTechnic,
  type TechnicSet,
} from "./technic-fit.ts";

const Z = 2;
const STEPS = 16;
const WIDE = 8 * STEPS;
const BORE = 6 * STEPS;
const BORE_RADII = [WIDE, WIDE, ...Array.from({ length: 16 }, () => BORE), WIDE, WIDE];
const RIDGED_END = [WIDE, WIDE, ...Array.from({ length: 18 }, (_, k) => BORE + 4 + (k % 2))];
const BORE_LINE = [0, 14] as const;
const BLOCK_BOX = [-20, 0, -10, 20, 24, 10];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const NO_WAIVERS = new Int32Array(0);

function bored(line: readonly [number, number] = BORE_LINE): PartTechnic {
  return {
    stepsPerLdu: STEPS,
    holes: [{ axis: Z, at: [line[0], line[1]], from: -10, radii: BORE_RADII }],
    shaft: null,
  };
}

function shaft(
  components: ReadonlyArray<{ from: number; radii: number[] }>,
  lift = 0,
): PartTechnic {
  return {
    stepsPerLdu: STEPS,
    holes: [],
    shaft: {
      axis: Z,
      at: [BORE_LINE[0], BORE_LINE[1] + lift],
      components: components.map(({ from, radii }) => ({ from, radii, pin: null })),
    },
  };
}

function rod(fromZ: number, length: number, radius: number, lift = 0): PartTechnic {
  return shaft([{ from: fromZ, radii: Array.from({ length }, () => radius) }], lift);
}

function box(technic: PartTechnic): number[] {
  const hole = technic.holes[0];
  if (hole) return BLOCK_BOX;
  const line = technic.shaft;
  const components = line?.components ?? [];
  const reach = Math.max(...components.flatMap((c) => c.radii)) / STEPS;
  const from = Math.min(...components.map((c) => c.from));
  const to = Math.max(...components.map((c) => c.from + c.radii.length));
  const [x, y] = line?.at ?? [0, 0];
  return [x - reach, y - reach, from, x + reach, y + reach, to];
}

function single(technic: PartTechnic): PosedTechnic {
  return modelTechnic(
    [technic],
    { count: 1, partIndex: [0], matrices: Float64Array.from(IDENTITY) },
    box(technic),
  );
}

function waiver(
  fromZ: number,
  toZ: number,
  line: readonly [number, number] = BORE_LINE,
): Int32Array {
  return Int32Array.of(Z, line[0], line[1], fromZ, toZ);
}

function overlaps(a: PosedTechnic, b: PosedTechnic, waivers: Int32Array = NO_WAIVERS): boolean {
  return technicItemsOverlap(a, 0, b, 0, waivers, waivers.length / TECHNIC_WAIVER_INTS);
}

function placed(local: TechnicSet, pose: LatticePose): PosedTechnic {
  const out = technicScratch(local);
  placeTechnicInto(local, pose, out);
  return out;
}

describe("technicItemsOverlap", () => {
  it("lets a shaft through a bore only on the bore's own line and within its free radius at every step", () => {
    expect({
      through: overlaps(single(rod(-40, 80, BORE)), single(bored())),
      onePlateUp: overlaps(single(rod(-40, 80, BORE, 8)), single(bored())),
      oneStudAside: overlaps(single(rod(-40, 80, BORE)), single(bored([20, 14]))),
      sixteenthTooThick: overlaps(single(rod(-40, 80, BORE + 1)), single(bored())),
      besideTheBlock: overlaps(single(rod(10, 30, BORE)), single(bored())),
    }).toEqual({
      through: false,
      onePlateUp: true,
      oneStudAside: true,
      sixteenthTooThick: true,
      besideTheBlock: false,
    });
  });

  it("lets a shaft wider than the bore occupy it only where a waiver on that same line covers every wide step", () => {
    const ridged = single(shaft([{ from: -10, radii: RIDGED_END }]));
    const bore = single(bored());
    expect({
      unwaived: overlaps(ridged, bore),
      waivedOverItsLength: overlaps(ridged, bore, waiver(-10, 10)),
      waivedOnAnotherLine: overlaps(ridged, bore, waiver(-10, 10, [20, 14])),
      waivedOneLduShort: overlaps(ridged, bore, waiver(-7, 10)),
      waiverAmongOthers: overlaps(
        ridged,
        bore,
        Int32Array.of(...waiver(-10, 10, [20, 14]), ...waiver(-10, 10)),
      ),
      twoShafts: overlaps(ridged, ridged, waiver(-30, 30)),
      twoBores: overlaps(bore, bore, waiver(-30, 30)),
    }).toEqual({
      unwaived: true,
      waivedOverItsLength: false,
      waivedOnAnotherLine: true,
      waivedOneLduShort: true,
      waiverAmongOthers: false,
      twoShafts: true,
      twoBores: true,
    });
  });

  it("gives the same verdict either way round, under every quarter turn and lattice translation", () => {
    const ridged = single(shaft([{ from: -10, radii: RIDGED_END }]));
    const flange = [WIDE, WIDE, ...Array.from({ length: 18 }, () => BORE)];
    const flangedBore = single({
      stepsPerLdu: STEPS,
      holes: [{ axis: Z, at: [BORE_LINE[0], BORE_LINE[1]], from: -10, radii: flange }],
      shaft: null,
    });
    const cases = [
      [single(rod(-40, 80, BORE)), single(bored())],
      [single(rod(-40, 80, BORE, 8)), single(bored())],
      [single(rod(-40, 80, BORE + 1)), single(bored())],
      [ridged, single(bored())],
      [single(shaft([{ from: -10, radii: flange }])), flangedBore],
      [single(shaft([{ from: -10, radii: flange.toReversed() }])), flangedBore],
    ] as const;
    const expected = cases.map(([a, b]) => overlaps(a, b));
    expect(expected).toEqual([false, true, true, true, false, true]);
    const halfTurned = placed(flangedBore, { x: 0, z: 0, yPlates: 0, rot: 2 });
    expect({
      flangeNowAtPlusZ: overlaps(
        single(shaft([{ from: -10, radii: flange.toReversed() }])),
        halfTurned,
      ),
      flangeStillAtMinusZ: overlaps(single(shaft([{ from: -10, radii: flange }])), halfTurned),
    }).toEqual({ flangeNowAtPlusZ: false, flangeStillAtMinusZ: true });
    for (let rot = 0; rot < 4; rot++) {
      const pose = { x: 640 * rot - 20, z: -340, yPlates: rot, rot };
      const turned = cases.map(([a, b]) => overlaps(placed(a, pose), placed(b, pose)));
      const swapped = cases.map(([a, b]) => overlaps(placed(b, pose), placed(a, pose)));
      expect({ rot, turned, swapped }).toEqual({ rot, turned: expected, swapped: expected });
    }
  });
});

describe("modelTechnic", () => {
  it("turns each profiled instance by its exact quarter-turn matrix and skips instances it can't identify", () => {
    const sideways = [0, 0, 1, 40, 0, 1, 0, 0, -1, 0, 0, 0];
    const tilted = [
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
      0,
      0,
      1,
      0,
      0,
      -Math.SQRT1_2,
      0,
      Math.SQRT1_2,
      0,
    ];
    const off = [1, 0, 0, 0.25, 0, 1, 0, 0, 0, 0, 1, 0];
    const blocks = modelTechnic(
      [bored()],
      {
        count: 4,
        partIndex: [0, 0, 0, 0],
        matrices: Float64Array.from([...IDENTITY, ...sideways, ...tilted, ...off]),
      },
      [...BLOCK_BOX, 30, 0, -20, 50, 24, 20, ...BLOCK_BOX, ...BLOCK_BOX],
    );
    const rodAlongX = modelTechnic(
      [rod(-40, 80, BORE)],
      { count: 1, partIndex: [0], matrices: Float64Array.from(sideways) },
      [0, 8, -6, 80, 20, 6],
    );
    expect({
      items: Array.from(blocks.itemOfInstance),
      sidewaysBore: [blocks.axis[1], blocks.atU[1], blocks.atV[1], blocks.from[1]],
      throughSidewaysBlock: technicItemsOverlap(rodAlongX, 0, blocks, 1, NO_WAIVERS, 0),
      acrossUprightBlock: technicItemsOverlap(rodAlongX, 0, blocks, 0, NO_WAIVERS, 0),
    }).toEqual({
      items: [0, 1, -1, -1],
      sidewaysBore: [0, 14, 0, 30],
      throughSidewaysBlock: false,
      acrossUprightBlock: true,
    });
  });
});

describe("PosedTechnicBuffer", () => {
  it("poses one item of a model exactly as posing the whole model does, at every quarter turn", () => {
    const blocks = modelTechnic(
      [bored(), rod(-40, 80, BORE)],
      {
        count: 3,
        partIndex: [0, 0, 1],
        matrices: Float64Array.from([
          ...IDENTITY,
          0,
          0,
          1,
          40,
          0,
          1,
          0,
          0,
          -1,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          20,
        ]),
      },
      [...BLOCK_BOX, 30, 0, -20, 50, 24, 20, -6, 8, -20, 6, 20, 60],
    );
    const probes = [single(rod(-40, 80, BORE)), single(rod(-40, 80, BORE + 8)), single(bored())];
    const buffer = new PosedTechnicBuffer();
    const answers = (posedItem: (item: number, pose: LatticePose) => PosedTechnic) =>
      [0, 1, 2, 3].map((rot) => {
        const pose = { x: 40, z: -20, yPlates: 3, rot };
        return [0, 1, 2].map((item) => {
          const posed = posedItem(item, pose);
          const itemBox = Array.from(posed.box.subarray(item * 6, item * 6 + 6));
          const hits = probes.map((probe) =>
            technicItemsOverlap(placed(probe, pose), 0, posed, item, NO_WAIVERS, 0),
          );
          return { itemBox, hits };
        });
      });
    expect(answers((item, pose) => buffer.placeItem(blocks, item, pose))).toEqual(
      answers((_, pose) => placed(blocks, pose)),
    );
  });
});
