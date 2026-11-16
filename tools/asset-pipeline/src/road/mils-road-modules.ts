import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Affine } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { measureBaseplate, type BaseplateMeasurement } from "../verify/geometry.ts";

const LDU_PER_STUD = 20;
const LDU_PER_PLATE = 8;
const PROFILE_PATH = fileURLToPath(new URL("./mils-road-profile.json", import.meta.url));
const AUTHOR = "Brick Railroad tools/asset-pipeline (cli.ts facts)";
const SEAM_SUPPORTS_PER_SEAM = 4;
const QUARTER_TURNS = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, 1, 0, 1, 0, -1, 0, 0],
] as const;

export type ModuleEdge = "minX" | "maxX" | "minZ" | "maxZ";
type PartRole =
  | "baseplate"
  | "corner"
  | "edgeJoin"
  | "seamSupport"
  | "cover"
  | "road"
  | "roadArm"
  | "crosswalkArm"
  | "walkwayCourse"
  | "walkwayTile";
type ArmRole = "roadArm" | "crosswalkArm";

interface CitedValue {
  readonly value: number;
  readonly source: string;
}

interface ProfilePart {
  readonly part: string;
  readonly ldrawColor: number;
  readonly element: string;
}

interface ModuleSpec {
  readonly name: string;
  readonly title: string;
  readonly arms: Partial<Record<ModuleEdge, ArmRole>>;
}

export interface MilsRoadProfile {
  readonly moduleStuds: CitedValue;
  readonly roadStuds: CitedValue;
  readonly surfacePlates: CitedValue;
  readonly streetPlates: CitedValue;
  readonly walkwayPlates: CitedValue;
  readonly colorSource: string;
  readonly parts: Readonly<Record<PartRole, ProfilePart>>;
  readonly modules: ReadonlyArray<ModuleSpec>;
}

export function loadMilsRoadProfile(): MilsRoadProfile {
  return JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as MilsRoadProfile;
}

export function milsRoadParts(profile: MilsRoadProfile): ReadonlyArray<string> {
  return [...new Set(Object.values(profile.parts).map((entry) => entry.part))];
}

interface Footprint {
  readonly columns: number;
  readonly rows: number;
}

interface Placement {
  readonly part: string;
  readonly color: number;
  readonly transform: Affine;
}

function wholeStuds(ldu: number, what: string): number {
  const studs = ldu / LDU_PER_STUD;
  if (!Number.isInteger(studs)) throw new Error(`${what} is ${ldu} LDU, not whole studs`);
  return studs;
}

class ModuleBuilder {
  readonly placements: Placement[] = [];
  private readonly measured: ReadonlyMap<string, BaseplateMeasurement>;
  private readonly profile: MilsRoadProfile;
  private readonly studs: number;
  private readonly halfLdu: number;
  private readonly occupied: Uint8Array;

  constructor(
    measured: ReadonlyMap<string, BaseplateMeasurement>,
    profile: MilsRoadProfile,
    studs: number,
  ) {
    this.measured = measured;
    this.profile = profile;
    this.studs = studs;
    this.halfLdu = (studs * LDU_PER_STUD) / 2;
    this.occupied = new Uint8Array(studs * studs);
  }

  measure(role: PartRole): BaseplateMeasurement {
    const part = this.profile.parts[role].part;
    const measurement = this.measured.get(part);
    if (!measurement) throw new Error(`part ${part} for ${role} was not measured`);
    return measurement;
  }

  thickness(role: PartRole): number {
    return this.measure(role).thicknessLdu;
  }

  footprint(role: PartRole, turned: boolean): Footprint {
    const measurement = this.measure(role);
    const columns = wholeStuds(measurement.widthLdu, `${measurement.part} width`);
    const rows = wholeStuds(measurement.depthLdu, `${measurement.part} depth`);
    return turned ? { columns: rows, rows: columns } : { columns, rows };
  }

  place(role: PartRole, column: number, row: number, turned: boolean, restOn: number): Footprint {
    const measurement = this.measure(role);
    const footprint = this.footprint(role, turned);
    const [a, b, c, d, e, f, g, h, i] = QUARTER_TURNS[turned ? 1 : 0];
    const centreX = (measurement.xExtent.from + measurement.xExtent.to) / 2;
    const centreZ = (measurement.zExtent.from + measurement.zExtent.to) / 2;
    const rotatedCentreX = a * centreX + c * centreZ;
    const rotatedCentreZ = g * centreX + i * centreZ;
    const targetX = -this.halfLdu + (column + footprint.columns / 2) * LDU_PER_STUD;
    const targetZ = -this.halfLdu + (row + footprint.rows / 2) * LDU_PER_STUD;
    const y = -restOn - measurement.bodyBottomY;
    const entry = this.profile.parts[role];
    this.placements.push({
      part: entry.part,
      color: entry.ldrawColor,
      transform: [a, b, c, d, e, f, g, h, i, targetX - rotatedCentreX, y, targetZ - rotatedCentreZ],
    });
    return footprint;
  }

  claim(column: number, row: number, footprint: Footprint): void {
    for (let z = row; z < row + footprint.rows; z++) {
      for (let x = column; x < column + footprint.columns; x++) {
        const index = z * this.studs + x;
        if (x < 0 || z < 0 || x >= this.studs || z >= this.studs || this.occupied[index]) {
          throw new Error(`cell ${x},${z} is outside the module or already covered`);
        }
        this.occupied[index] = 1;
      }
    }
  }

  isFree(column: number, row: number, footprint: Footprint): boolean {
    for (let z = row; z < row + footprint.rows; z++) {
      for (let x = column; x < column + footprint.columns; x++) {
        if (x >= this.studs || z >= this.studs || this.occupied[z * this.studs + x]) return false;
      }
    }
    return true;
  }

  uncovered(): number {
    return this.occupied.reduce((count, cell) => count + (cell === 0 ? 1 : 0), 0);
  }
}

function sameThickness(builder: ModuleBuilder, roles: ReadonlyArray<PartRole>): number {
  const thicknesses = new Set(roles.map((role) => builder.thickness(role)));
  const [only] = thicknesses;
  if (thicknesses.size !== 1 || only === undefined) {
    throw new Error(`the substructure course parts ${roles.join(", ")} differ in height`);
  }
  return only;
}

function requireHeight(actual: number, cited: CitedValue, what: string): void {
  if (actual !== cited.value * LDU_PER_PLATE) {
    throw new Error(
      `${what} lands at ${actual} LDU, but the profile cites ${cited.value} plates (${cited.source})`,
    );
  }
}

function substructure(builder: ModuleBuilder, studs: number, courseTop: number): void {
  const corner = builder.footprint("corner", false);
  const join = builder.footprint("edgeJoin", false);
  const farCorner = studs - corner.columns;
  const joinFrom = corner.columns;
  const joinFarFrom = studs - corner.columns - join.columns;
  for (const [column, row] of [
    [0, 0],
    [farCorner, 0],
    [0, farCorner],
    [farCorner, farCorner],
  ] as const) {
    builder.place("corner", column, row, false, 0);
  }
  const edgeJoins: ReadonlyArray<readonly [number, number, boolean]> = [
    [joinFrom, 0, false],
    [joinFarFrom, 0, false],
    [joinFrom, studs - join.rows, false],
    [joinFarFrom, studs - join.rows, false],
    [0, joinFrom, true],
    [0, joinFarFrom, true],
    [studs - join.rows, joinFrom, true],
    [studs - join.rows, joinFarFrom, true],
  ];
  for (const [column, row, turned] of edgeJoins) builder.place("edgeJoin", column, row, turned, 0);
  const support = builder.footprint("seamSupport", false);
  const seam = studs / 2;
  const span = studs / SEAM_SUPPORTS_PER_SEAM;
  for (let k = 0; k < SEAM_SUPPORTS_PER_SEAM; k++) {
    const along = k * span + (span - support.columns) / 2;
    builder.place("seamSupport", along, seam - support.rows / 2, false, 0);
    builder.place("seamSupport", seam - support.rows / 2, along, true, 0);
  }
  const cover = builder.footprint("cover", false);
  for (let row = 0; row < studs; row += cover.rows) {
    for (let column = 0; column < studs; column += cover.columns) {
      builder.place("cover", column, row, false, courseTop);
    }
  }
}

function armCell(edge: ModuleEdge, studs: number, roadFrom: number, depth: number) {
  switch (edge) {
    case "minX":
      return { column: 0, row: roadFrom, turned: true };
    case "maxX":
      return { column: studs - depth, row: roadFrom, turned: true };
    case "minZ":
      return { column: roadFrom, row: 0, turned: false };
    case "maxZ":
      return { column: roadFrom, row: studs - depth, turned: false };
    default: {
      const unhandled: never = edge;
      throw new Error(`unhandled edge ${String(unhandled)}`);
    }
  }
}

function roadAndWalkway(
  builder: ModuleBuilder,
  profile: MilsRoadProfile,
  spec: ModuleSpec,
  surface: number,
): void {
  const studs = profile.moduleStuds.value;
  const roadStuds = profile.roadStuds.value;
  const roadFrom = (studs - roadStuds) / 2;
  const centre = builder.footprint("road", false);
  if (centre.columns !== roadStuds || centre.rows !== roadStuds) {
    throw new Error(`the road plate is ${centre.columns}×${centre.rows}, not ${roadStuds} square`);
  }
  builder.place("road", roadFrom, roadFrom, false, surface);
  builder.claim(roadFrom, roadFrom, centre);
  for (const [edge, role] of Object.entries(spec.arms) as Array<[ModuleEdge, ArmRole]>) {
    const unturned = builder.footprint(role, false);
    if (unturned.columns !== roadStuds || unturned.rows !== roadFrom) {
      throw new Error(
        `${role} is ${unturned.columns}×${unturned.rows}, not ${roadStuds}×${roadFrom}`,
      );
    }
    const { column, row, turned } = armCell(edge, studs, roadFrom, unturned.rows);
    builder.claim(column, row, builder.place(role, column, row, turned, surface));
  }
  const course = builder.footprint("walkwayCourse", false);
  const courseTop = surface + builder.thickness("walkwayCourse");
  for (let row = 0; row < studs; row += course.rows) {
    for (let column = 0; column < studs; column += course.columns) {
      if (!builder.isFree(column, row, course)) continue;
      builder.place("walkwayCourse", column, row, false, surface);
      builder.place("walkwayTile", column, row, false, courseTop);
      builder.claim(column, row, course);
    }
  }
  if (builder.uncovered() !== 0) {
    throw new Error(`${spec.name}: ${builder.uncovered()} cells are neither road nor walkway`);
  }
}

function formatNumber(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

function toLdraw(spec: ModuleSpec, placements: ReadonlyArray<Placement>): string {
  const lines = placements.map(({ part, color, transform }) => {
    const [a, b, c, d, e, f, g, h, i, x, y, z] = transform;
    return [1, color, x, y, z, a, b, c, d, e, f, g, h, i]
      .map((value) => formatNumber(value))
      .concat(`${part}.dat`)
      .join(" ");
  });
  return [
    `0 ${spec.title}`,
    `0 Name: ${spec.name}.ldr`,
    `0 Author: ${AUTHOR}, MILS road module from tools/asset-pipeline/src/road/mils-road-profile.json and measured part extents`,
    ...lines,
    "",
  ].join("\n");
}

export interface MilsRoadModule {
  readonly name: string;
  readonly ldraw: string;
}

export function milsRoadModules(library: LdrawLibrary): ReadonlyArray<MilsRoadModule> {
  const profile = loadMilsRoadProfile();
  const measured = new Map(
    milsRoadParts(profile).map((part) => [part, measureBaseplate(library, part)]),
  );
  const studs = profile.moduleStuds.value;
  return profile.modules.map((spec) => {
    const builder = new ModuleBuilder(measured, profile, studs);
    const baseplate = builder.footprint("baseplate", false);
    if (baseplate.columns !== studs || baseplate.rows !== studs) {
      throw new Error(
        `the baseplate is ${baseplate.columns}×${baseplate.rows}, not ${studs} square`,
      );
    }
    builder.place("baseplate", 0, 0, false, -builder.thickness("baseplate"));
    const courseTop = sameThickness(builder, ["corner", "edgeJoin", "seamSupport"]);
    substructure(builder, studs, courseTop);
    const surface = courseTop + builder.thickness("cover");
    requireHeight(surface, profile.surfacePlates, "the substructure top");
    requireHeight(surface + builder.thickness("road"), profile.streetPlates, "the street surface");
    requireHeight(
      surface + builder.thickness("walkwayCourse") + builder.thickness("walkwayTile"),
      profile.walkwayPlates,
      "the walkway surface",
    );
    roadAndWalkway(builder, profile, spec, surface);
    return { name: spec.name, ldraw: toLdraw(spec, builder.placements) };
  });
}
