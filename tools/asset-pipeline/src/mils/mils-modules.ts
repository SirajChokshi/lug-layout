import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Affine } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { measureBaseplate, type BaseplateMeasurement } from "../verify/geometry.ts";

const LDU_PER_STUD = 20;
const LDU_PER_PLATE = 8;
const SUPPORT_SPAN_STUDS = 8;
const PROFILE_PATH = fileURLToPath(new URL("./mils-profile.json", import.meta.url));
const TRACK_CATALOG_PATH = fileURLToPath(
  new URL("../../../../docs/verified-facts/track-catalog.json", import.meta.url),
);
const AUTHOR = "Brick Railroad tools/asset-pipeline (cli.ts facts)";
const QUARTER_TURNS = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, 1, 0, 1, 0, -1, 0, 0],
] as const;

export type ModuleEdge = "minX" | "maxX" | "minZ" | "maxZ";
type SurfaceFeature = "path" | "track" | "road" | "river";
type Feature = SurfaceFeature | "rail";
type Finish = "plate" | "tile";

interface CitedValue {
  readonly value: number;
  readonly source: string;
}

interface FeatureSpec {
  readonly widthStuds: CitedValue;
  readonly surfacePlates: CitedValue;
  readonly finish: Finish;
  readonly ldrawColor: number;
  readonly bedLdrawColor?: number;
  readonly bankStartPlates?: CitedValue;
  readonly bankRisePlatesPerStud?: CitedValue;
}

interface TemplateSpec {
  readonly name: string;
  readonly title: string;
  readonly feature: Feature | null;
  readonly edges: ReadonlyArray<ModuleEdge>;
}

export interface MilsProfile {
  readonly moduleStuds: CitedValue;
  readonly surfacePlates: CitedValue;
  readonly features: Readonly<Record<SurfaceFeature, FeatureSpec>>;
  readonly terrainLdrawColor: number;
  readonly structureLdrawColor: number;
  readonly parts: {
    readonly baseplate: string;
    readonly corner: string;
    readonly edgeJoin: string;
    readonly edgeCourse: ReadonlyArray<string>;
    readonly support: ReadonlyArray<string>;
    readonly plates: ReadonlyArray<string>;
    readonly tiles: ReadonlyArray<string>;
  };
  readonly rail: { readonly part: string; readonly ldrawColor: number; readonly source: string };
  readonly elementSource: string;
  readonly elements: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly templates: ReadonlyArray<TemplateSpec>;
}

interface TrackPieceFrame {
  readonly part: string;
  readonly partFrame: { readonly xLdu: number; readonly zLdu: number };
  readonly routes: ReadonlyArray<{ readonly lengthLdu: number }>;
}

export function loadMilsProfile(): MilsProfile {
  return JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as MilsProfile;
}

export function milsParts(profile: MilsProfile): ReadonlyArray<string> {
  const { parts } = profile;
  return [
    ...new Set([
      parts.baseplate,
      parts.corner,
      parts.edgeJoin,
      ...parts.edgeCourse,
      ...parts.support,
      ...parts.plates,
      ...parts.tiles,
      profile.rail.part,
    ]),
  ];
}

function railFrame(part: string): TrackPieceFrame {
  const catalog = JSON.parse(readFileSync(TRACK_CATALOG_PATH, "utf8")) as {
    readonly pieces: ReadonlyArray<TrackPieceFrame>;
  };
  const piece = catalog.pieces.find((entry) => entry.part === `ldraw:${part}`);
  if (!piece) throw new Error(`track catalog has no piece for ${part}`);
  return piece;
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

interface Column {
  readonly topPlates: number;
  readonly finish: Finish;
  readonly color: number;
  readonly fillColor: number;
}

function wholeStuds(ldu: number, what: string): number {
  const studs = ldu / LDU_PER_STUD;
  if (!Number.isInteger(studs)) throw new Error(`${what} is ${ldu} LDU, not whole studs`);
  return studs;
}

class ModuleBuilder {
  readonly placements: Placement[] = [];
  private readonly measured: ReadonlyMap<string, BaseplateMeasurement>;
  private readonly profile: MilsProfile;
  private readonly halfLdu: number;

  constructor(measured: ReadonlyMap<string, BaseplateMeasurement>, profile: MilsProfile) {
    this.measured = measured;
    this.profile = profile;
    this.halfLdu = (profile.moduleStuds.value * LDU_PER_STUD) / 2;
  }

  measure(part: string): BaseplateMeasurement {
    const measurement = this.measured.get(part);
    if (!measurement) throw new Error(`part ${part} was not measured`);
    return measurement;
  }

  footprint(part: string, turned: boolean): Footprint {
    const measurement = this.measure(part);
    const columns = wholeStuds(measurement.widthLdu, `${part} width`);
    const rows = wholeStuds(measurement.depthLdu, `${part} depth`);
    return turned ? { columns: rows, rows: columns } : { columns, rows };
  }

  isProduced(part: string, color: number): boolean {
    return (this.profile.elements[`${part}@${color}`]?.length ?? 0) > 0;
  }

  place(
    part: string,
    color: number,
    column: number,
    row: number,
    turned: boolean,
    restOnLdu: number,
  ): Footprint {
    if (!this.isProduced(part, color)) {
      throw new Error(`${part} in colour ${color} has no Rebrickable element in the profile`);
    }
    const measurement = this.measure(part);
    const footprint = this.footprint(part, turned);
    const [a, b, c, d, e, f, g, h, i] = QUARTER_TURNS[turned ? 1 : 0];
    const centreX = (measurement.xExtent.from + measurement.xExtent.to) / 2;
    const centreZ = (measurement.zExtent.from + measurement.zExtent.to) / 2;
    const rotatedCentreX = a * centreX + c * centreZ;
    const rotatedCentreZ = g * centreX + i * centreZ;
    const targetX = -this.halfLdu + (column + footprint.columns / 2) * LDU_PER_STUD;
    const targetZ = -this.halfLdu + (row + footprint.rows / 2) * LDU_PER_STUD;
    const y = -restOnLdu - measurement.bodyBottomY;
    this.placements.push({
      part,
      color,
      transform: [a, b, c, d, e, f, g, h, i, targetX - rotatedCentreX, y, targetZ - rotatedCentreZ],
    });
    return footprint;
  }

  placeTrack(part: string, color: number, centreX: number, centreZ: number, restOn: number): void {
    if (!this.isProduced(part, color)) {
      throw new Error(`${part} in colour ${color} has no Rebrickable element in the profile`);
    }
    const y = -restOn - this.measure(part).bodyBottomY;
    this.placements.push({
      part,
      color,
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, centreX, y, centreZ],
    });
  }
}

interface Candidate {
  readonly part: string;
  readonly turned: boolean;
  readonly footprint: Footprint;
}

function candidates(
  builder: ModuleBuilder,
  parts: ReadonlyArray<string>,
  color: number,
): ReadonlyArray<Candidate> {
  const list: Candidate[] = [];
  for (const part of parts) {
    if (!builder.isProduced(part, color)) continue;
    for (const turned of [false, true]) {
      const footprint = builder.footprint(part, turned);
      if (turned && footprint.columns === footprint.rows) continue;
      list.push({ part, turned, footprint });
    }
  }
  return list.toSorted(
    (p, q) =>
      q.footprint.columns * q.footprint.rows - p.footprint.columns * p.footprint.rows ||
      q.footprint.columns - p.footprint.columns,
  );
}

function fits(mask: Uint8Array, studs: number, column: number, row: number, size: Footprint) {
  if (column + size.columns > studs || row + size.rows > studs) return false;
  for (let z = row; z < row + size.rows; z++) {
    for (let x = column; x < column + size.columns; x++) {
      if (!mask[z * studs + x]) return false;
    }
  }
  return true;
}

function clear(mask: Uint8Array, studs: number, column: number, row: number, size: Footprint) {
  for (let z = row; z < row + size.rows; z++) {
    for (let x = column; x < column + size.columns; x++) mask[z * studs + x] = 0;
  }
}

interface PackedRect {
  readonly column: number;
  readonly row: number;
  readonly footprint: Footprint;
}

function pack(
  builder: ModuleBuilder,
  studs: number,
  region: Uint8Array,
  parts: ReadonlyArray<string>,
  color: number,
  restOnLdu: number,
): ReadonlyArray<PackedRect> {
  const mask = Uint8Array.from(region);
  const options = candidates(builder, parts, color);
  const packed: PackedRect[] = [];
  for (let row = 0; row < studs; row++) {
    for (let column = 0; column < studs; column++) {
      if (!mask[row * studs + column]) continue;
      const choice = options.find((option) => fits(mask, studs, column, row, option.footprint));
      if (!choice) throw new Error(`no part in colour ${color} fits cell ${column},${row}`);
      builder.place(choice.part, color, column, row, choice.turned, restOnLdu);
      clear(mask, studs, column, row, choice.footprint);
      packed.push({ column, row, footprint: choice.footprint });
    }
  }
  return packed;
}

interface Point {
  readonly x: number;
  readonly z: number;
}

function edgeMidpoint(edge: ModuleEdge, studs: number): Point {
  const half = studs / 2;
  switch (edge) {
    case "minX":
      return { x: 0, z: half };
    case "maxX":
      return { x: studs, z: half };
    case "minZ":
      return { x: half, z: 0 };
    case "maxZ":
      return { x: half, z: studs };
    default: {
      const unhandled: never = edge;
      throw new Error(`unhandled edge ${String(unhandled)}`);
    }
  }
}

function isOpposite(a: ModuleEdge, b: ModuleEdge): boolean {
  const axis = (edge: ModuleEdge) => edge.slice(3);
  return axis(a) === axis(b);
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

function centrelineDistance(edges: ReadonlyArray<ModuleEdge>, studs: number) {
  const centre = { x: studs / 2, z: studs / 2 };
  const [first, second] = edges;
  if (edges.length === 2 && first && second && !isOpposite(first, second)) {
    const a = edgeMidpoint(first, studs);
    const b = edgeMidpoint(second, studs);
    const corner = { x: a.x === centre.x ? b.x : a.x, z: a.z === centre.z ? b.z : a.z };
    return (p: Point) => Math.abs(Math.hypot(p.x - corner.x, p.z - corner.z) - studs / 2);
  }
  const ends = edges.map((edge) => edgeMidpoint(edge, studs));
  return (p: Point) => Math.min(...ends.map((end) => distanceToSegment(p, centre, end)));
}

function columnsFor(profile: MilsProfile, template: TemplateSpec): ReadonlyArray<Column> {
  const studs = profile.moduleStuds.value;
  const surface = profile.surfacePlates.value;
  const land: Column = {
    topPlates: surface,
    finish: "plate",
    color: profile.terrainLdrawColor,
    fillColor: profile.terrainLdrawColor,
  };
  const { feature } = template;
  if (feature === null || feature === "rail")
    return Array.from({ length: studs * studs }, () => land);
  const spec = profile.features[feature];
  const halfWidth = spec.widthStuds.value / 2;
  const distance = centrelineDistance(template.edges, studs);
  const columns: Column[] = [];
  for (let row = 0; row < studs; row++) {
    for (let column = 0; column < studs; column++) {
      const offset = distance({ x: column + 0.5, z: row + 0.5 });
      columns.push(featureColumn(profile, spec, land, offset - halfWidth));
    }
  }
  return columns;
}

function featureColumn(
  profile: MilsProfile,
  spec: FeatureSpec,
  land: Column,
  beyondFeature: number,
): Column {
  if (beyondFeature < 0) {
    return {
      topPlates: spec.surfacePlates.value,
      finish: spec.finish,
      color: spec.ldrawColor,
      fillColor: spec.bedLdrawColor ?? (spec.finish === "plate" ? spec.ldrawColor : land.color),
    };
  }
  const bankStart = spec.bankStartPlates?.value;
  const rise = spec.bankRisePlatesPerStud?.value;
  if (bankStart === undefined || rise === undefined) return land;
  const bankPlates = bankStart + Math.floor(beyondFeature) * rise;
  if (bankPlates >= profile.surfacePlates.value) return land;
  return { topPlates: bankPlates, finish: "plate", color: land.color, fillColor: land.color };
}

function substructureCells(
  builder: ModuleBuilder,
  profile: MilsProfile,
  columns: ReadonlyArray<Column>,
): { readonly solid: Uint8Array; readonly hollow: Uint8Array } {
  const studs = profile.moduleStuds.value;
  const surface = profile.surfacePlates.value;
  const color = profile.structureLdrawColor;
  const raised = Uint8Array.from(columns, (column) => (column.topPlates >= surface ? 1 : 0));
  const solid = new Uint8Array(studs * studs);
  const claim = (column: number, row: number, footprint: Footprint) => {
    for (let z = row; z < row + footprint.rows; z++) {
      for (let x = column; x < column + footprint.columns; x++) {
        if (!raised[z * studs + x] || solid[z * studs + x]) {
          throw new Error(`substructure cell ${x},${z} is not free raised ground`);
        }
        solid[z * studs + x] = 1;
      }
    }
  };
  const corner = builder.footprint(profile.parts.corner, false);
  const far = studs - corner.columns;
  for (const [column, row] of [
    [0, 0],
    [far, 0],
    [0, far],
    [far, far],
  ] as const) {
    claim(column, row, builder.place(profile.parts.corner, color, column, row, false, 0));
  }
  const join = builder.footprint(profile.parts.edgeJoin, false);
  const near = corner.columns;
  const farJoin = studs - corner.columns - join.columns;
  const depth = join.rows;
  const joins: ReadonlyArray<readonly [number, number, boolean]> = [
    [near, 0, false],
    [farJoin, 0, false],
    [near, studs - depth, false],
    [farJoin, studs - depth, false],
    [0, near, true],
    [0, farJoin, true],
    [studs - depth, near, true],
    [studs - depth, farJoin, true],
  ];
  for (const [column, row, turned] of joins) {
    claim(column, row, builder.place(profile.parts.edgeJoin, color, column, row, turned, 0));
  }
  const ring = new Uint8Array(studs * studs);
  for (let row = 0; row < studs; row++) {
    for (let column = 0; column < studs; column++) {
      const index = row * studs + column;
      const onEdge = row === 0 || column === 0 || row === studs - 1 || column === studs - 1;
      if (onEdge && raised[index] && !solid[index]) ring[index] = 1;
    }
  }
  for (const rect of pack(builder, studs, ring, profile.parts.edgeCourse, color, 0)) {
    claim(rect.column, rect.row, rect.footprint);
  }
  const hollow = Uint8Array.from(raised, (cell, index) => (cell && !solid[index] ? 1 : 0));
  return { solid, hollow };
}

function supportCovers(
  builder: ModuleBuilder,
  profile: MilsProfile,
  covers: ReadonlyArray<PackedRect>,
  solid: Uint8Array,
  hollow: Uint8Array,
): void {
  const studs = profile.moduleStuds.value;
  const options = candidates(builder, profile.parts.support, profile.structureLdrawColor);
  for (const cover of covers) {
    for (let fromRow = 0; fromRow < cover.footprint.rows; fromRow += SUPPORT_SPAN_STUDS) {
      for (
        let fromColumn = 0;
        fromColumn < cover.footprint.columns;
        fromColumn += SUPPORT_SPAN_STUDS
      ) {
        const block = {
          column: cover.column + fromColumn,
          row: cover.row + fromRow,
          columns: Math.min(SUPPORT_SPAN_STUDS, cover.footprint.columns - fromColumn),
          rows: Math.min(SUPPORT_SPAN_STUDS, cover.footprint.rows - fromRow),
        };
        if (blockIsHeld(solid, studs, block)) continue;
        placeSupport(builder, profile, options, solid, hollow, block);
      }
    }
  }
}

interface Block {
  readonly column: number;
  readonly row: number;
  readonly columns: number;
  readonly rows: number;
}

function blockIsHeld(solid: Uint8Array, studs: number, block: Block): boolean {
  for (let z = block.row; z < block.row + block.rows; z++) {
    for (let x = block.column; x < block.column + block.columns; x++) {
      if (solid[z * studs + x]) return true;
    }
  }
  return false;
}

function placeSupport(
  builder: ModuleBuilder,
  profile: MilsProfile,
  options: ReadonlyArray<Candidate>,
  solid: Uint8Array,
  hollow: Uint8Array,
  block: Block,
): void {
  const studs = profile.moduleStuds.value;
  for (const option of options) {
    const { columns, rows } = option.footprint;
    if (columns > block.columns || rows > block.rows) continue;
    const column = block.column + Math.floor((block.columns - columns) / 2);
    const row = block.row + Math.floor((block.rows - rows) / 2);
    if (!fits(hollow, studs, column, row, option.footprint)) continue;
    builder.place(option.part, profile.structureLdrawColor, column, row, option.turned, 0);
    clear(hollow, studs, column, row, option.footprint);
    for (let z = row; z < row + rows; z++) {
      for (let x = column; x < column + columns; x++) solid[z * studs + x] = 1;
    }
    return;
  }
  throw new Error(`no support brick fits under the cover block at ${block.column},${block.row}`);
}

function layerRegions(
  columns: ReadonlyArray<Column>,
  level: number,
  surface: number,
): ReadonlyMap<string, Uint8Array> {
  const regions = new Map<string, Uint8Array>();
  columns.forEach((column, index) => {
    if (column.topPlates < level) return;
    if (column.topPlates >= surface && level < surface) return;
    const isTop = column.topPlates === level;
    const key = isTop ? `${column.finish}@${column.color}` : `plate@${column.fillColor}`;
    const region = regions.get(key) ?? new Uint8Array(columns.length);
    region[index] = 1;
    regions.set(key, region);
  });
  return regions;
}

function requireEdges(
  profile: MilsProfile,
  template: TemplateSpec,
  columns: ReadonlyArray<Column>,
) {
  const studs = profile.moduleStuds.value;
  const { feature } = template;
  if (feature === null || feature === "rail") return;
  const spec = profile.features[feature];
  const width = spec.widthStuds.value;
  const from = (studs - width) / 2;
  const allEdges: ReadonlyArray<ModuleEdge> = ["minX", "maxX", "minZ", "maxZ"];
  for (const edge of allEdges) {
    const carries = template.edges.includes(edge);
    for (let along = 0; along < studs; along++) {
      const index = edgeCell(edge, along, studs);
      const column = columns[index];
      const isFeature =
        column?.color === spec.ldrawColor && column.topPlates === spec.surfacePlates.value;
      const expected = carries && along >= from && along < from + width;
      if (isFeature !== expected) {
        throw new Error(
          `${template.name}: edge ${edge} stud ${along} ${expected ? "lacks" : "has"} the ${feature}`,
        );
      }
    }
  }
}

function edgeCell(edge: ModuleEdge, along: number, studs: number): number {
  switch (edge) {
    case "minX":
      return along * studs;
    case "maxX":
      return along * studs + studs - 1;
    case "minZ":
      return along;
    case "maxZ":
      return (studs - 1) * studs + along;
    default: {
      const unhandled: never = edge;
      throw new Error(`unhandled edge ${String(unhandled)}`);
    }
  }
}

function requireThickness(
  builder: ModuleBuilder,
  parts: ReadonlyArray<string>,
  plates: number,
  what: string,
): void {
  const wrong = parts.filter(
    (part) => builder.measure(part).thicknessLdu !== plates * LDU_PER_PLATE,
  );
  if (wrong.length > 0) {
    throw new Error(`the ${what} ${wrong.join(", ")} are not ${plates} plates thick`);
  }
}

function buildModule(
  measured: ReadonlyMap<string, BaseplateMeasurement>,
  profile: MilsProfile,
  template: TemplateSpec,
): ReadonlyArray<Placement> {
  const studs = profile.moduleStuds.value;
  const surface = profile.surfacePlates.value;
  const builder = new ModuleBuilder(measured, profile);
  const baseplate = builder.footprint(profile.parts.baseplate, false);
  if (baseplate.columns !== studs || baseplate.rows !== studs) {
    throw new Error(`the baseplate is ${baseplate.columns}×${baseplate.rows}, not ${studs} square`);
  }
  requireThickness(builder, profile.parts.plates, 1, "packing plates");
  requireThickness(builder, profile.parts.tiles, 1, "packing tiles");
  const { parts } = profile;
  const courseParts = [parts.corner, parts.edgeJoin, ...parts.edgeCourse, ...parts.support];
  requireThickness(builder, courseParts, surface - 1, "substructure bricks");
  const baseplateThickness = builder.measure(profile.parts.baseplate).thicknessLdu;
  builder.place(
    profile.parts.baseplate,
    profile.terrainLdrawColor,
    0,
    0,
    false,
    -baseplateThickness,
  );
  const columns = columnsFor(profile, template);
  requireEdges(profile, template, columns);
  const { solid, hollow } = substructureCells(builder, profile, columns);
  const topLevel = Math.max(...columns.map((column) => column.topPlates));
  for (let level = 1; level <= topLevel; level++) {
    for (const [key, region] of layerRegions(columns, level, surface)) {
      const [finish, colorText] = key.split("@");
      const options = finish === "tile" ? parts.tiles : parts.plates;
      const restOn = (level - 1) * LDU_PER_PLATE;
      const packed = pack(builder, studs, region, options, Number(colorText), restOn);
      if (level === surface) supportCovers(builder, profile, packed, solid, hollow);
    }
  }
  if (template.feature === "rail") placeRail(builder, profile, surface * LDU_PER_PLATE);
  return builder.placements;
}

function placeRail(builder: ModuleBuilder, profile: MilsProfile, restOn: number): void {
  const { part, ldrawColor } = profile.rail;
  const frame = railFrame(part);
  const length = frame.routes[0]?.lengthLdu;
  const moduleLdu = profile.moduleStuds.value * LDU_PER_STUD;
  if (length === undefined || moduleLdu % length !== 0) {
    throw new Error(`${part} does not divide the ${moduleLdu} LDU module edge`);
  }
  for (let start = -moduleLdu / 2; start < moduleLdu / 2; start += length) {
    builder.placeTrack(
      part,
      ldrawColor,
      start + frame.partFrame.xLdu,
      frame.partFrame.zLdu,
      restOn,
    );
  }
}

function formatNumber(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

function toLdraw(template: TemplateSpec, placements: ReadonlyArray<Placement>): string {
  const lines = placements.map(({ part, color, transform }) => {
    const [a, b, c, d, e, f, g, h, i, x, y, z] = transform;
    return [1, color, x, y, z, a, b, c, d, e, f, g, h, i]
      .map((value) => formatNumber(value))
      .concat(`${part}.dat`)
      .join(" ");
  });
  return [
    `0 ${template.title}`,
    `0 Name: ${template.name}.ldr`,
    `0 Author: ${AUTHOR}, MILS module template from tools/asset-pipeline/src/mils/mils-profile.json and measured part extents`,
    ...lines,
    "",
  ].join("\n");
}

export interface MilsModule {
  readonly name: string;
  readonly ldraw: string;
}

export function milsModules(library: LdrawLibrary): ReadonlyArray<MilsModule> {
  const profile = loadMilsProfile();
  const measured = new Map(
    milsParts(profile).map((part) => [part, measureBaseplate(library, part)]),
  );
  return profile.templates.map((template) => ({
    name: template.name,
    ldraw: toLdraw(template, buildModule(measured, profile, template)),
  }));
}
