import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { buildTrackPiece } from "./track-catalog.ts";

const root = mkdtempSync(join(tmpdir(), "track-catalog-"));
mkdirSync(join(root, "parts", "s"), { recursive: true });
mkdirSync(join(root, "p"), { recursive: true });
writeFileSync(
  join(root, "parts", "s", "custom-end-sleeper.dat"),
  [
    "0 ~Custom End Sleeper",
    "0 Name: s\\custom-end-sleeper.dat",
    "4 16 -10 -8 -1 10 -8 -1 10 -8 1 -10 -8 1",
  ].join("\r\n"),
);
writeFileSync(
  join(root, "p", "head.dat"),
  ["0 Head top", "4 16 -1 0 -1 1 0 -1 1 0 1 -1 0 1"].join("\n"),
);

function writeStraightTrack(
  name: string,
  entrySleeperHalfWidth: number,
  exitSleeperHalfWidth: number,
  headCentres: ReadonlyArray<number>,
): void {
  writeFileSync(
    join(root, "parts", `${name}.dat`),
    [
      `0 Custom 9V Straight with end sleepers ${2 * entrySleeperHalfWidth} and ${2 * exitSleeperHalfWidth} LDU wide`,
      `0 Name: ${name}.dat`,
      "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
      `1 16 160 0 0 1 0 0 0 1 0 0 0 ${exitSleeperHalfWidth} s/custom-end-sleeper.dat`,
      `1 16 -160 0 0 -1 0 0 0 1 0 0 0 -${entrySleeperHalfWidth} s/custom-end-sleeper.dat`,
      ...headCentres.map((z) => `1 16 0 -16 ${z} 160 0 0 0 1 0 0 0 3 head.dat`),
      "4 16 -160 8 -160 160 8 -160 160 8 160 -160 8 160",
    ].join("\r\n"),
  );
}

writeStraightTrack("custom-wide-track", 140, 140, [-120, 120]);
writeStraightTrack("custom-narrow-track", 40, 40, [-70, -30, 30, 70]);
writeStraightTrack("custom-mixed-sleeper-track", 40, 140, [-70, -30, 30, 70]);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("track pieces", () => {
  const library = new LdrawLibrary([root]);
  const markers = [{ file: "s/custom-end-sleeper.dat", outwardSign: 1 as const }];

  function halfSpacings(part: string) {
    return buildTrackPiece(library, part, markers).checks.connectors.map(
      (connector) => connector.railHalfSpacingLdu,
    );
  }

  it("read a wide track's rails inside its own end sleepers", () => {
    expect(halfSpacings("custom-wide-track")).toEqual([
      { numerator: "120", denominator: "1" },
      { numerator: "120", denominator: "1" },
    ]);
  });

  it("read only a narrow track's own rails when other rail heads lie beyond its end sleepers", () => {
    expect(halfSpacings("custom-narrow-track")).toEqual([
      { numerator: "30", denominator: "1" },
      { numerator: "30", denominator: "1" },
    ]);
  });

  it("clip each end to the end sleeper placed at that end", () => {
    expect(halfSpacings("custom-mixed-sleeper-track")).toEqual([
      { numerator: "30", denominator: "1" },
      null,
    ]);
  });
});
