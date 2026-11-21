import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { walkPart, type PlacedPolygon } from "../ldraw/walk.ts";
import { measureStud, rampFacts } from "./ramp-facts.ts";

const library = new LdrawLibrary([
  fileURLToPath(new URL("../../../../.cache/ldraw", import.meta.url)),
  fileURLToPath(new URL("../../../../.cache/ldraw-audit", import.meta.url)),
]);
const BRICK = 24;
const STUD = 20;

function polygons(file: string): PlacedPolygon[] {
  const found: PlacedPolygon[] = [];
  walkPart(library, file, { polygon: (polygon) => void found.push(polygon) });
  return found;
}

const stud = measureStud(polygons("stud.dat"));

describe("rampFacts", () => {
  it("reads a slope brick's rise, edge heights and run from its own faces", () => {
    const slope10 = rampFacts("ldraw:4515", "4515", polygons("4515.dat"), stud);
    const slope33 = rampFacts("ldraw:3297", "3297", polygons("3297.dat"), stud);
    expect({
      slope10: slope10 && { high: slope10.highEdgeLdu, run: slope10.runLdu, rise: slope10.rise },
      slope33: slope33 && { high: slope33.highEdgeLdu, run: slope33.runLdu, rise: slope33.rise },
    }).toEqual({
      slope10: { high: BRICK, run: 6 * STUD, rise: { axis: "z", toward: -1 } },
      slope33: { high: BRICK, run: 2 * STUD, rise: { axis: "z", toward: -1 } },
    });
  });

  it("finds anti-studs only on the part's own stud lattice, inside its footprint", () => {
    const slope = rampFacts("ldraw:3297", "3297", polygons("3297.dat"), stud);
    if (!slope) throw new Error("3297 is a ramp");
    const { minX, minZ, maxX, maxZ } = slope.footprint;
    expect(slope.antiStuds.length).toBeGreaterThan(0);
    for (const [x, z] of slope.antiStuds) {
      expect(((x - minX - STUD / 2) % STUD) + 0).toBe(0);
      expect(((z - minZ - STUD / 2) % STUD) + 0).toBe(0);
      expect(x > minX && x < maxX && z > minZ && z < maxZ).toBe(true);
    }
  });

  it("is no ramp for parts with a flat top or slopes facing more than one way", () => {
    expect({
      brick: rampFacts("ldraw:3001", "3001", polygons("3001.dat"), stud),
      roadPlate: rampFacts("ldraw:44336p04", "44336p04", polygons("44336p04.dat"), stud),
      track: rampFacts("ldraw:74746", "74746", polygons("74746.dat"), stud),
      doubleSlope: rampFacts("ldraw:3300", "3300", polygons("3300.dat"), stud),
    }).toEqual({ brick: null, roadPlate: null, track: null, doubleSlope: null });
  });
});
