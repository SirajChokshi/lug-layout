import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { HALF_TURN_16, pose16, posesJoin16, zeta16, ZETA16_ORDER, type Pose16 } from "@brr/math";
import { MilsProfile, type MilsModuleEdge } from "@brr/schema/bundle";
import { decode } from "@brr/schema/decode";
import { describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { findTrackEnds, LDU_PER_STUD, loadTrackEndMarkers } from "../track/track-ends.ts";
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

function onStuds(xStuds: number, zStuds: number, heading: number): Pose16 {
  return pose16(zeta16([BigInt(xStuds), 0n, 0n, 0n, BigInt(zStuds), 0n, 0n, 0n]), heading);
}

function exactStuds(ldu: number, what: string): number {
  const studs = ldu / LDU_PER_STUD;
  if (!Number.isInteger(studs)) throw new Error(`${what} is at ${ldu} LDU, off the stud lattice`);
  return studs;
}

function chainedRailEnds(modules: number): ReadonlyArray<Pose16> {
  const rail = profile.templates.find((template) => template.feature === "rail");
  const built = buildMilsModules(library, profile, catalog).find((m) => m.name === rail?.name);
  if (!built) throw new Error("the profile has no rail module");
  const part = profile.build.rail.part;
  const ends = findTrackEnds(library, part, loadTrackEndMarkers());
  const placements = built.ldraw
    .split("\n")
    .filter((line) => line.endsWith(` ${part}.dat`))
    .map((line) => {
      const [x = 0, , z = 0, a = 1, , c = 0, , , , g = 0, , i = 1] = line
        .split(" ")
        .slice(2, 14)
        .map(Number);
      return { x, z, a, c, g, i };
    });
  const moduleLdu = profile.spec.moduleStuds.value * LDU_PER_STUD;
  return Array.from({ length: modules }, (_, index) => index * moduleLdu).flatMap((offset) =>
    placements.flatMap(({ x, z, a, c, g, i }) =>
      ends.map((end) => {
        const dx = a * Math.cos(end.outward) + c * Math.sin(end.outward);
        const dz = g * Math.cos(end.outward) + i * Math.sin(end.outward);
        const at = `the ${part} end of the module at ${offset} LDU`;
        return onStuds(
          exactStuds(offset + x + a * end.x + c * end.z, `${at} (x)`),
          exactStuds(-(z + g * end.x + i * end.z), `${at} (z)`),
          Math.round((Math.atan2(-dz, dx) * ZETA16_ORDER) / (2 * Math.PI)),
        );
      }),
    ),
  );
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

  it.each([2, 3])(
    "joins the track of %i rail modules end to end exactly, leaving only the two outer edges open",
    (modules) => {
      const ends = chainedRailEnds(modules);
      const open = ends.filter((end) => !ends.some((other) => posesJoin16(end, other)));
      const joined = ends.length - open.length;
      const halfStuds = profile.spec.moduleStuds.value / 2;
      expect({ joins: joined / 2, open }).toEqual({
        joins: ends.length / 2 - 1,
        open: [
          onStuds(-halfStuds, 0, HALF_TURN_16),
          onStuds(-halfStuds + modules * profile.spec.moduleStuds.value, 0, 0),
        ],
      });
    },
  );

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
