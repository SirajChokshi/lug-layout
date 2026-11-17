import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { readPalette } from "../palette.ts";
import {
  buildLevelCrossing,
  LEVEL_CROSSING_SPEC,
  readCrossingModels,
  type CrossingSpec,
} from "./level-crossing.ts";

const cache = (folder: string) =>
  fileURLToPath(new URL(`../../../../.cache/${folder}`, import.meta.url));
const library = new LdrawLibrary([cache("ldraw-audit")]);
const palette = await readPalette(fileURLToPath(new URL("../../palette.json", import.meta.url)));
const models = readCrossingModels(cache("omr"), palette);

describe("level crossing recipe", () => {
  it("reads 10128-1 as four 6 x 8 slopes on the track bed, rising to the rail top flush with the 9V track sides", () => {
    const recipe = buildLevelCrossing(library, models, palette);
    const slopes = recipe.slopes.map(({ footprint, offset, highEdgeAcrossLdu }) => ({
      footprint,
      bottomLdu: offset[1] - recipe.slopeRiseLdu,
      highEdgeAcrossLdu,
    }));
    expect(
      slopes.toSorted(
        (a, b) => a.footprint.minZ - b.footprint.minZ || a.footprint.minX - b.footprint.minX,
      ),
    ).toEqual([
      {
        footprint: { minX: -160, maxX: 0, minZ: -200, maxZ: -80 },
        bottomLdu: 0,
        highEdgeAcrossLdu: -80,
      },
      {
        footprint: { minX: 0, maxX: 160, minZ: -200, maxZ: -80 },
        bottomLdu: 0,
        highEdgeAcrossLdu: -80,
      },
      {
        footprint: { minX: -160, maxX: 0, minZ: 80, maxZ: 200 },
        bottomLdu: 0,
        highEdgeAcrossLdu: 80,
      },
      {
        footprint: { minX: 0, maxX: 160, minZ: 80, maxZ: 200 },
        bottomLdu: 0,
        highEdgeAcrossLdu: 80,
      },
    ]);
    expect(recipe.slopeRiseLdu).toBe(recipe.railTopAboveBedLdu);
  });

  it("refuses 7936-1 as the recipe, whose slopes stand 20 LDU inside the plastic track's sides", () => {
    const plasticFirst: CrossingSpec = {
      ...LEVEL_CROSSING_SPEC,
      sources: LEVEL_CROSSING_SPEC.sources.map((source) => ({
        ...source,
        use: source.model === "7936-1" ? "recipe" : "cross-check",
      })),
    };
    expect(() => buildLevelCrossing(library, models, palette, plasticFirst)).toThrow(
      /slopes' high edges are 60 LDU from the centreline, not flush with the 80 LDU track edge/u,
    );
  });

  it("refuses a model file that is not the pinned one", () => {
    const edited = new Map(models);
    edited.set("10128-1", `${models.get("10128-1") ?? ""}\n0 edited\n`);
    expect(() => buildLevelCrossing(library, edited, palette)).toThrow(
      "10128-1 does not match its pinned sha256",
    );
  });
});
