import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { MilsProfile, type MilsModuleEdge } from "@brr/schema/bundle";
import { decode } from "@brr/schema/decode";
import { describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { buildMilsModules, loadMilsProfile, loadTrackCatalog } from "./mils-modules.ts";

const library = new LdrawLibrary([
  fileURLToPath(new URL("../../../../.cache/ldraw-audit", import.meta.url)),
]);
const catalog = loadTrackCatalog();
const profile = loadMilsProfile();
const EDGES: ReadonlyArray<MilsModuleEdge> = ["minX", "maxX", "minZ", "maxZ"];

const LAND = "32@4:2";
const FEATURE_EDGES: Readonly<Record<string, string>> = {
  road: "8@4:2 16@5:72 8@4:2",
  track: "12@4:2 8@4:19 12@4:2",
  path: "14@4:2 4@4:70 14@4:2",
  river: "10@4:2 1@3:2 1@2:2 8@2:33 1@2:2 1@3:2 10@4:2",
  rail: "12@4:2 8@7:72 12@4:2",
};

function corrupted(edit: (copy: MilsProfile) => void): MilsProfile {
  const copy = structuredClone(profile);
  edit(copy);
  return copy;
}

function withoutElement(key: string): MilsProfile {
  return corrupted((copy) => {
    Object.assign(copy, {
      elements: Object.fromEntries(Object.entries(copy.elements).filter(([k]) => k !== key)),
    });
  });
}

describe("MILS module templates", () => {
  it("measure, from the placed parts, MILS edges on every side of every template", () => {
    const modules = buildMilsModules(library, profile, catalog);
    expect(modules.map((module) => module.name)).toEqual(profile.templates.map((t) => t.name));
    for (const template of profile.templates) {
      const module = modules.find((entry) => entry.name === template.name);
      const expected = Object.fromEntries(
        EDGES.map((edge) => [
          edge,
          template.feature !== null && template.edges.includes(edge)
            ? FEATURE_EDGES[template.feature]
            : LAND,
        ]),
      );
      expect({ name: template.name, edges: module?.edges }).toEqual({
        name: template.name,
        edges: expected,
      });
    }
  });

  it.each([
    [
      "a paved road built at 7 plates",
      (p: MilsProfile) => (p.build.features.road.plates = 7),
      /mils-road-straight: edge minX stud 8 measures 7 plates/u,
    ],
    [
      "a path sunk to 3 plates",
      (p: MilsProfile) => (p.build.features.path.plates = 3),
      /mils-path-straight: edge minX stud 14 measures 3 plates/u,
    ],
    [
      "a river at the baseplate",
      (p: MilsProfile) => (p.build.features.river.plates = 0),
      /mils-river-straight: edge minX stud \d+ measures \d+ plates in colour \d+, but the spec needs river/u,
    ],
    [
      "a road 14 studs wide",
      (p: MilsProfile) => (p.build.features.road.widthStuds = 14),
      /mils-road-straight: edge minX stud 8 measures 4 plates in colour 2, but the spec needs road/u,
    ],
  ])("refuses a profile with %s", (_case, edit, message) => {
    expect(() => buildMilsModules(library, corrupted(edit), catalog)).toThrow(message);
  });

  it("packs around a plate never produced in a colour, and refuses to place a part that was not", () => {
    const plain = buildMilsModules(library, withoutElement("91405@2"), catalog)[0];
    expect(plain?.ldraw).toContain("92438.dat");
    expect(plain?.ldraw).not.toMatch(/^1 2 .* 91405\.dat$/mu);
    expect(() => buildMilsModules(library, withoutElement("3811@2"), catalog)).toThrow(
      "3811 in colour 2 has no Rebrickable element in the profile",
    );
  });

  it("refuses a profile file whose cited value has lost its source", () => {
    const raw = JSON.parse(
      readFileSync(new URL("./mils-profile.json", import.meta.url), "utf8"),
    ) as { spec: { features: { road: { widthStuds: Record<string, unknown> } } } };
    delete raw.spec.features.road.widthStuds["source"];
    const decoded = decode(MilsProfile, raw);
    expect(decoded.ok ? [] : decoded.issues.map((issue) => issue.path)).toContain(
      "$.spec.features.road.widthStuds.source",
    );
  });
});
