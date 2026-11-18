import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { readPalette } from "../palette.ts";
import { measureMagnetSeat, type MagnetModel } from "./magnet-seat.ts";

const cache = (name: string) =>
  fileURLToPath(new URL(`../../../../.cache/${name}`, import.meta.url));
const palette = await readPalette(fileURLToPath(new URL("../../palette.json", import.meta.url)));

function omrModels(): ReadonlyArray<MagnetModel> {
  return palette.models
    .filter((model) => model.origin === "omr")
    .map((model) => ({
      name: model.file,
      source: readFileSync(join(cache("omr"), model.file), "utf8"),
    }));
}

function quad(...corners: ReadonlyArray<readonly [number, number, number]>): string {
  return `4 16 ${corners.map((corner) => corner.join(" ")).join(" ")}`;
}

function squareSlotHolder(): string {
  const walls: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, -10, 0, -16],
    [6, -10, 6, -16],
    [0, -10, 6, -10],
    [0, -16, 6, -16],
  ];
  return walls
    .flatMap(([y0, z0, y1, z1]) => [
      quad([10, y0, z0], [20, y0, z0], [20, y1, z1], [10, y1, z1]),
      quad([-10, y0, z0], [-20, y0, z0], [-20, y1, z1], [-10, y1, z1]),
    ])
    .join("\n");
}

function syntheticLibrary(pivot: string): { library: LdrawLibrary; shadow: LdrawLibrary } {
  const root = mkdtempSync(join(tmpdir(), "magnet-seat-"));
  mkdirSync(join(root, "parts", "parts"), { recursive: true });
  mkdirSync(join(root, "shadow", "parts"), { recursive: true });
  writeFileSync(
    join(root, "parts", "parts", "holder.dat"),
    `0 Square Slot Holder\n${squareSlotHolder()}\n`,
  );
  writeFileSync(
    join(root, "parts", "parts", "casing.dat"),
    "0 Pinned Casing\n1 16 12 0 0 0 6 0 2 0 0 0 0 2 4-4cyli.dat\n1 16 -12 0 0 0 -6 0 2 0 0 0 0 2 4-4cyli.dat\n",
  );
  writeFileSync(
    join(root, "shadow", "parts", "holder.dat"),
    `0 !LDCAD SNAP_FGR [group=magnet] [genderOfs=F] [seq=4 6 4] [radius=2] [pos=${pivot}]\n`,
  );
  return {
    library: new LdrawLibrary([join(root, "parts")]),
    shadow: new LdrawLibrary([join(root, "shadow")]),
  };
}

const twoPoses: MagnetModel = {
  name: "custom.ldr",
  source: [
    "0 FILE custom.ldr",
    "1 16 0 0 0 1 0 0 0 1 0 0 0 1 holder.dat",
    "1 16 0 3 -13 1 0 0 0 1 0 0 0 1 casing.dat",
    "1 16 100 0 0 1 0 0 0 1 0 0 0 1 holder.dat",
    "1 16 100 3 -11.5 -1 0 0 0 1 0 0 0 -1 casing.dat",
  ].join("\n"),
};

describe("magnet seat measurement", () => {
  it("finds the curated 2920 magnet pivot at the centre of the seat its casing pins fit", () => {
    const seat = measureMagnetSeat(
      new LdrawLibrary([cache("ldraw")]),
      new LdrawLibrary([cache("ldcad-shadow-bundle")]),
      "2920",
      "2959",
      omrModels(),
    );
    const [, height, depth] = seat.curatedPivot;
    const runs = seat.alongDepth;
    const runAt = (at: number) => runs.find((run) => run.from <= at && at <= run.to);
    const seated = runAt(depth);
    const seatedIndex = seated === undefined ? -1 : runs.indexOf(seated);
    const towardMouth = runs[0]?.fits ? runs.slice(0, seatedIndex) : runs.slice(seatedIndex + 1);
    expect(seat.seatCentre).toEqual([height, depth]);
    expect(seat.pivotClearance).toBeGreaterThan(seat.pinRadius);
    expect(towardMouth.some((run) => !run.fits && run.least < seat.pinRadius)).toBe(true);
    expect(towardMouth.some((run) => run.fits)).toBe(true);

    const poses = seat.modelPoses;
    const fitting = poses.filter((pose) => pose.fits);
    expect(poses.flatMap((pose) => pose.casings)).toHaveLength(22);
    expect(poses.some(({ axis }) => axis[0] === height && axis[1] === depth)).toBe(false);
    expect(poses.filter((pose) => !pose.fits)).toHaveLength(5);
    expect(fitting.filter(({ axis }) => runAt(axis[1]) === seated)).toHaveLength(1);
    expect(
      fitting.filter(({ axis }) => towardMouth.some((run) => run === runAt(axis[1]))),
    ).toHaveLength(1);
  });

  it("follows a custom holder's own slot and flags a curated pivot off its centre", () => {
    const centred = syntheticLibrary("0 3 -13");
    const seat = measureMagnetSeat(centred.library, centred.shadow, "holder", "casing", [twoPoses]);
    expect(seat.pinSpans).toEqual([
      { from: 12, to: 18 },
      { from: -18, to: -12 },
    ]);
    expect(seat.seatCentre).toEqual([3, -13]);
    expect(seat.pivotClearance).toBe(3);
    expect(seat.modelPoses.map(({ axis, clearance, fits }) => ({ axis, clearance, fits }))).toEqual(
      [
        { axis: [3, -13], clearance: 3, fits: true },
        { axis: [3, -11.5], clearance: 1.5, fits: false },
      ],
    );

    const offCentre = syntheticLibrary("0 3 -12");
    const misplaced = measureMagnetSeat(
      offCentre.library,
      offCentre.shadow,
      "holder",
      "casing",
      [],
    );
    expect(misplaced.seatCentre).toEqual([3, -13]);
    expect(misplaced.pivotClearance).toBe(2);
  });
});
