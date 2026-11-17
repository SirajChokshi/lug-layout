import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MilsProfile,
  TrackCatalog,
  type MilsEdgeFeatureRule,
  type MilsEdgeRules,
  type MilsBuildFeature,
  type MilsBuildRiver,
  type MilsFinish,
  type MilsModuleEdge,
  type MilsTemplate,
  type TrackPiece,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import {
  CERTIFIED_RESIDUAL_LIMIT_LDU,
  attachPose16,
  composePose16,
  pose16,
  pose16Equals,
  zeta16,
  type Pose16,
} from "@brr/math";
import type { Affine } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { ldrawPlacement } from "../track/catalog-scenes.ts";
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
  [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  [0, 0, -1, 0, 1, 0, 1, 0, 0],
] as const;
const ENTRY_CONNECTOR = 0;
const EXIT_CONNECTOR = 1;
const MODULE_EDGES: ReadonlyArray<MilsModuleEdge> = ["minX", "maxX", "minZ", "maxZ"];

export function loadMilsProfile(): MilsProfile {
  return decodedOrThrow(
    decode(MilsProfile, JSON.parse(readFileSync(PROFILE_PATH, "utf8"))),
    PROFILE_PATH,
  );
}

export function loadTrackCatalog(): TrackCatalog {
  return decodedOrThrow(
    decode(TrackCatalog, JSON.parse(readFileSync(TRACK_CATALOG_PATH, "utf8"))),
    TRACK_CATALOG_PATH,
  );
}

export function milsParts(profile: MilsProfile): ReadonlyArray<string> {
  const { parts, rail } = profile.build;
  return [
    ...new Set([
      parts.baseplate,
      parts.corner,
      parts.edgeJoin,
      ...parts.edgeCourse,
      ...parts.support,
      ...parts.plates,
      ...parts.tiles,
      rail.part,
    ]),
  ];
}

function railPiece(catalog: TrackCatalog, part: string): TrackPiece {
  const piece = catalog.pieces.find((entry) => entry.part === `ldraw:${part}`);
  if (!piece) throw new Error(`track catalog has no piece for ${part}`);
  return piece;
}

function connectorPose(piece: TrackPiece, index: number): Pose16 {
  const connector = piece.connectors[index];
  if (!connector) throw new Error(`${piece.id} has no connector ${index}`);
  return connector.pose;
}

function onAxisStuds(studs: number): Pose16 {
  return pose16(zeta16([BigInt(studs), 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0);
}

function wholeLdu(value: number, what: string): number {
  const whole = Math.round(value);
  if (Math.abs(value - whole) > CERTIFIED_RESIDUAL_LIMIT_LDU) {
    throw new Error(
      `${what} is ${value}, not within ${CERTIFIED_RESIDUAL_LIMIT_LDU} of a lattice value`,
    );
  }
  return whole;
}

function latticeTransform(transform: Affine, what: string): Affine {
  const whole = (value: number) => wholeLdu(value, what);
  const rotation = transform.slice(0, 9).map(whole);
  const turn = QUARTER_TURNS.find((candidate) =>
    candidate.every((value, k) => value === rotation[k]),
  );
  if (!turn) throw new Error(`${what} is not a quarter turn about the vertical axis`);
  return [...turn, whole(transform[9]), whole(transform[10]), whole(transform[11])];
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
  readonly finish: MilsFinish;
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
    this.halfLdu = (profile.spec.moduleStuds.value * LDU_PER_STUD) / 2;
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

  placeTrack(part: string, color: number, onLattice: Affine, restOn: number): void {
    if (!this.isProduced(part, color)) {
      throw new Error(`${part} in colour ${color} has no Rebrickable element in the profile`);
    }
    const [a, b, c, d, e, f, g, h, i, x, , z] = onLattice;
    const y = -restOn - this.measure(part).bodyBottomY;
    this.placements.push({ part, color, transform: [a, b, c, d, e, f, g, h, i, x, y, z] });
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

function edgeMidpoint(edge: MilsModuleEdge, studs: number): Point {
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

function edgeAxis(edge: MilsModuleEdge): string {
  return edge.slice(3);
}

function isOpposite(a: MilsModuleEdge, b: MilsModuleEdge): boolean {
  return edgeAxis(a) === edgeAxis(b);
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

function centrelineDistance(edges: ReadonlyArray<MilsModuleEdge>, studs: number) {
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

function columnsFor(profile: MilsProfile, template: MilsTemplate): ReadonlyArray<Column> {
  const studs = profile.spec.moduleStuds.value;
  const land: Column = {
    topPlates: profile.spec.surfacePlates.value,
    finish: "plate",
    color: profile.build.terrainLdrawColor,
    fillColor: profile.build.terrainLdrawColor,
  };
  const { feature } = template;
  if (feature === null || feature === "rail") {
    return Array.from({ length: studs * studs }, () => land);
  }
  const build = profile.build.features[feature];
  const halfWidth = build.widthStuds / 2;
  const distance = centrelineDistance(template.edges, studs);
  const columns: Column[] = [];
  for (let row = 0; row < studs; row++) {
    for (let column = 0; column < studs; column++) {
      const offset = distance({ x: column + 0.5, z: row + 0.5 });
      columns.push(featureColumn(build, land, offset - halfWidth));
    }
  }
  return columns;
}

function isRiver(build: MilsBuildFeature | MilsBuildRiver): build is MilsBuildRiver {
  return "bankStartPlates" in build;
}

function featureColumn(
  build: MilsBuildFeature | MilsBuildRiver,
  land: Column,
  beyondFeature: number,
): Column {
  if (beyondFeature < 0) {
    return {
      topPlates: build.plates,
      finish: build.finish,
      color: build.ldrawColor,
      fillColor: isRiver(build)
        ? build.bedLdrawColor
        : build.finish === "plate"
          ? build.ldrawColor
          : land.color,
    };
  }
  if (!isRiver(build)) return land;
  const bankPlates =
    build.bankStartPlates + Math.floor(beyondFeature) * build.bankRisePlatesPerStud;
  if (bankPlates >= land.topPlates) return land;
  return { topPlates: bankPlates, finish: "plate", color: land.color, fillColor: land.color };
}

function substructureCells(
  builder: ModuleBuilder,
  profile: MilsProfile,
  columns: ReadonlyArray<Column>,
): { readonly solid: Uint8Array; readonly hollow: Uint8Array } {
  const studs = profile.spec.moduleStuds.value;
  const surface = profile.spec.surfacePlates.value;
  const color = profile.build.structureLdrawColor;
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
  const corner = builder.footprint(profile.build.parts.corner, false);
  const far = studs - corner.columns;
  for (const [column, row] of [
    [0, 0],
    [far, 0],
    [0, far],
    [far, far],
  ] as const) {
    claim(column, row, builder.place(profile.build.parts.corner, color, column, row, false, 0));
  }
  const join = builder.footprint(profile.build.parts.edgeJoin, false);
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
    claim(column, row, builder.place(profile.build.parts.edgeJoin, color, column, row, turned, 0));
  }
  const ring = new Uint8Array(studs * studs);
  for (let row = 0; row < studs; row++) {
    for (let column = 0; column < studs; column++) {
      const index = row * studs + column;
      const onEdge = row === 0 || column === 0 || row === studs - 1 || column === studs - 1;
      if (onEdge && raised[index] && !solid[index]) ring[index] = 1;
    }
  }
  for (const rect of pack(builder, studs, ring, profile.build.parts.edgeCourse, color, 0)) {
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
  const studs = profile.spec.moduleStuds.value;
  const options = candidates(
    builder,
    profile.build.parts.support,
    profile.build.structureLdrawColor,
  );
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
  const studs = profile.spec.moduleStuds.value;
  for (const option of options) {
    const { columns, rows } = option.footprint;
    if (columns > block.columns || rows > block.rows) continue;
    const column = block.column + Math.floor((block.columns - columns) / 2);
    const row = block.row + Math.floor((block.rows - rows) / 2);
    if (!fits(hollow, studs, column, row, option.footprint)) continue;
    builder.place(option.part, profile.build.structureLdrawColor, column, row, option.turned, 0);
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

interface StudRule {
  readonly minPlates: number;
  readonly maxPlates: number;
  readonly colors: ReadonlyArray<number> | null;
  readonly what: string;
}

interface MeasuredTops {
  readonly plates: Float64Array;
  readonly colors: Int32Array;
}

function measureTops(
  measured: ReadonlyMap<string, BaseplateMeasurement>,
  placements: ReadonlyArray<Placement>,
  studs: number,
): MeasuredTops {
  const half = (studs * LDU_PER_STUD) / 2;
  const topLdu = new Float64Array(studs * studs).fill(Number.NEGATIVE_INFINITY);
  const colors = new Int32Array(studs * studs);
  for (const { part, color, transform } of placements) {
    const measurement = measured.get(part);
    if (!measurement) throw new Error(`part ${part} was not measured`);
    const [a, , c, , , , g, , i, x, y, z] = transform;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const px of [measurement.xExtent.from, measurement.xExtent.to]) {
      for (const pz of [measurement.zExtent.from, measurement.zExtent.to]) {
        minX = Math.min(minX, a * px + c * pz + x);
        maxX = Math.max(maxX, a * px + c * pz + x);
        minZ = Math.min(minZ, g * px + i * pz + z);
        maxZ = Math.max(maxZ, g * px + i * pz + z);
      }
    }
    const top = -(y + measurement.bodyTopY);
    for (let row = 0; row < studs; row++) {
      const centreZ = -half + (row + 0.5) * LDU_PER_STUD;
      if (centreZ <= minZ || centreZ >= maxZ) continue;
      for (let column = 0; column < studs; column++) {
        const centreX = -half + (column + 0.5) * LDU_PER_STUD;
        const cell = row * studs + column;
        if (centreX <= minX || centreX >= maxX || top <= (topLdu[cell] ?? 0)) continue;
        topLdu[cell] = top;
        colors[cell] = color;
      }
    }
  }
  return { plates: topLdu.map((top) => top / LDU_PER_PLATE), colors };
}

function centredBand(studs: number, width: number, what: string) {
  const spare = studs - width;
  if (spare < 0 || spare % 2 !== 0) throw new Error(`${what} of ${width} studs can't be centred`);
  return { from: spare / 2, to: spare / 2 + width };
}

function setBand(
  rules: StudRule[],
  rule: StudRule,
  from: number,
  to: number,
): ReadonlyArray<StudRule> {
  for (let stud = from; stud < to; stud++) rules[stud] = rule;
  return rules;
}

function expectedEdge(
  profile: MilsProfile,
  template: MilsTemplate,
  edge: MilsModuleEdge,
  rail: BaseplateMeasurement,
): ReadonlyArray<StudRule> {
  const { spec } = profile;
  const studs = spec.moduleStuds.value;
  const surface = spec.surfacePlates.value;
  const land: StudRule = { minPlates: surface, maxPlates: surface, colors: null, what: "land" };
  const rules: StudRule[] = Array.from({ length: studs }, () => land);
  const { feature } = template;
  if (feature === null || !template.edges.includes(edge)) return rules;
  if (feature === "rail") {
    const width = wholeStuds(rail.depthLdu, `${rail.part} width across the track`);
    const { from, to } = centredBand(studs, width, "the rail");
    const plates = surface + rail.thicknessLdu / LDU_PER_PLATE;
    const track = {
      minPlates: plates,
      maxPlates: plates,
      colors: [profile.build.rail.ldrawColor],
      what: "rail on the surface",
    };
    return setBand(rules, track, from, to);
  }
  if (feature === "river") {
    const river = spec.features.river;
    const { from, to } = centredBand(studs, river.widthStuds.value, "the river");
    const water = river.waterPlates.value;
    if (water >= surface)
      throw new Error(`the cited river level ${water} is not below the surface`);
    setBand(
      rules,
      { minPlates: water, maxPlates: water, colors: river.ldrawColors.values, what: "river water" },
      from,
      to,
    );
    for (let bank = 0; ; bank++) {
      const plates = river.bankStartPlates.value + bank * river.bankRisePlatesPerStud.value;
      if (plates >= surface) break;
      const rule = {
        minPlates: plates,
        maxPlates: plates,
        colors: null,
        what: `river bank stud ${bank + 1}`,
      };
      if (from - 1 - bank < 0 || to + bank >= studs)
        throw new Error("the river banks run off the edge");
      rules[from - 1 - bank] = rule;
      rules[to + bank] = rule;
    }
    return rules;
  }
  const level = spec.features[feature];
  const { from, to } = centredBand(studs, level.widthStuds.value, `the ${feature}`);
  return setBand(
    rules,
    {
      minPlates: surface + level.aboveSurfacePlates.min,
      maxPlates: surface + level.aboveSurfacePlates.max,
      colors: level.ldrawColors.values,
      what: feature,
    },
    from,
    to,
  );
}

function requireSpecEdges(
  profile: MilsProfile,
  template: MilsTemplate,
  tops: MeasuredTops,
  rail: BaseplateMeasurement,
): void {
  const studs = profile.spec.moduleStuds.value;
  for (const edge of MODULE_EDGES) {
    expectedEdge(profile, template, edge, rail).forEach((rule, along) => {
      const cell = edgeCell(edge, along, studs);
      const plates = tops.plates[cell] ?? Number.NaN;
      const color = tops.colors[cell] ?? 0;
      const heightFits = plates >= rule.minPlates && plates <= rule.maxPlates;
      if (heightFits && (rule.colors === null || rule.colors.includes(color))) return;
      const range =
        rule.minPlates === rule.maxPlates
          ? `${rule.minPlates}`
          : `${rule.minPlates}–${rule.maxPlates}`;
      const colors = rule.colors === null ? "" : ` in colour ${rule.colors.join("/")}`;
      throw new Error(
        `${template.name}: edge ${edge} stud ${along} measures ${plates} plates in colour ${color}, but the spec needs ${rule.what} at ${range} plates${colors}`,
      );
    });
  }
}

function edgeRuns(tops: MeasuredTops, studs: number): Readonly<Record<MilsModuleEdge, string>> {
  const runs = (edge: MilsModuleEdge): string => {
    const labels = Array.from({ length: studs }, (_, along) => {
      const cell = edgeCell(edge, along, studs);
      return `${tops.plates[cell]}:${tops.colors[cell]}`;
    });
    const grouped: Array<{ label: string; count: number }> = [];
    for (const label of labels) {
      const last = grouped.at(-1);
      if (last?.label === label) last.count++;
      else grouped.push({ label, count: 1 });
    }
    return grouped.map(({ label, count }) => `${count}@${label}`).join(" ");
  };
  return { minX: runs("minX"), maxX: runs("maxX"), minZ: runs("minZ"), maxZ: runs("maxZ") };
}

function edgeCell(edge: MilsModuleEdge, along: number, studs: number): number {
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
  catalog: TrackCatalog,
  template: MilsTemplate,
): ReadonlyArray<Placement> {
  const studs = profile.spec.moduleStuds.value;
  const surface = profile.spec.surfacePlates.value;
  const builder = new ModuleBuilder(measured, profile);
  const baseplate = builder.footprint(profile.build.parts.baseplate, false);
  if (baseplate.columns !== studs || baseplate.rows !== studs) {
    throw new Error(`the baseplate is ${baseplate.columns}×${baseplate.rows}, not ${studs} square`);
  }
  requireThickness(builder, profile.build.parts.plates, 1, "packing plates");
  requireThickness(builder, profile.build.parts.tiles, 1, "packing tiles");
  const { parts } = profile.build;
  const courseParts = [parts.corner, parts.edgeJoin, ...parts.edgeCourse, ...parts.support];
  requireThickness(builder, courseParts, surface - 1, "substructure bricks");
  const baseplateThickness = builder.measure(profile.build.parts.baseplate).thicknessLdu;
  builder.place(
    profile.build.parts.baseplate,
    profile.build.terrainLdrawColor,
    0,
    0,
    false,
    -baseplateThickness,
  );
  const columns = columnsFor(profile, template);
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
  if (template.feature === "rail") placeRail(builder, profile, catalog, surface * LDU_PER_PLATE);
  return builder.placements;
}

function placeRail(
  builder: ModuleBuilder,
  profile: MilsProfile,
  catalog: TrackCatalog,
  restOn: number,
): void {
  const { part, ldrawColor } = profile.build.rail;
  const piece = railPiece(catalog, part);
  const halfStuds = profile.spec.moduleStuds.value / 2;
  const maxXEdge = onAxisStuds(halfStuds);
  let open = onAxisStuds(-halfStuds);
  for (let laid = 0; !pose16Equals(open, maxXEdge); laid++) {
    if (laid === profile.spec.moduleStuds.value) {
      throw new Error(`${part} pieces laid from the minX edge never end on the maxX edge`);
    }
    const pose = attachPose16(connectorPose(piece, ENTRY_CONNECTOR), open);
    const transform = latticeTransform(
      ldrawPlacement({ piece, pose }),
      `${part} piece ${laid + 1} of the rail`,
    );
    builder.placeTrack(part, ldrawColor, transform, restOn);
    open = composePose16(pose, connectorPose(piece, EXIT_CONNECTOR));
  }
}

function formatNumber(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

function toLdraw(template: MilsTemplate, placements: ReadonlyArray<Placement>): string {
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
  readonly edges: Readonly<Record<MilsModuleEdge, string>>;
}

export function buildMilsModules(
  library: LdrawLibrary,
  profile: MilsProfile,
  catalog: TrackCatalog,
): ReadonlyArray<MilsModule> {
  const measured = new Map(
    milsParts(profile).map((part) => [part, measureBaseplate(library, part)]),
  );
  const rail = measureBaseplate(library, profile.build.rail.part);
  const studs = profile.spec.moduleStuds.value;
  return profile.templates.map((template) => {
    const placements = buildModule(measured, profile, catalog, template);
    const tops = measureTops(measured, placements, studs);
    requireSpecEdges(profile, template, tops, rail);
    return {
      name: template.name,
      ldraw: toLdraw(template, placements),
      edges: edgeRuns(tops, studs),
    };
  });
}

export function milsModules(library: LdrawLibrary): ReadonlyArray<MilsModule> {
  return buildMilsModules(library, loadMilsProfile(), loadTrackCatalog());
}

function levelFeatureRule(
  profile: MilsProfile,
  kind: "path" | "track" | "road",
): MilsEdgeFeatureRule {
  const { surfacePlates } = profile.spec;
  const level = profile.spec.features[kind];
  return {
    kind,
    standard: "mils",
    widthStuds: level.widthStuds.value,
    plates: surfacePlates.value + level.aboveSurfacePlates.min,
    belowPlates: level.sideVariationPlates.belowPlates,
    abovePlates:
      level.aboveSurfacePlates.max -
      level.aboveSurfacePlates.min +
      level.sideVariationPlates.abovePlates,
    bankStuds: 0,
    bankStartPlates: 0,
    bankRisePlatesPerStud: 0,
    bankVariationPlates: 0,
    ldrawColors: level.ldrawColors.values,
  };
}

function riverRule(profile: MilsProfile): MilsEdgeFeatureRule {
  const river = profile.spec.features.river;
  return {
    kind: "river",
    standard: "mils",
    widthStuds: river.widthStuds.value,
    plates: river.waterPlates.value,
    belowPlates: 0,
    abovePlates: 0,
    bankStuds: Math.ceil(
      (profile.spec.surfacePlates.value - river.bankStartPlates.value) /
        river.bankRisePlatesPerStud.value,
    ),
    bankStartPlates: river.bankStartPlates.value,
    bankRisePlatesPerStud: river.bankRisePlatesPerStud.value,
    bankVariationPlates: river.bankVariationPlates.value,
    ldrawColors: river.ldrawColors.values,
  };
}

function railRule(profile: MilsProfile, rail: BaseplateMeasurement): MilsEdgeFeatureRule {
  return {
    kind: "rail",
    standard: "project",
    widthStuds: wholeStuds(rail.depthLdu, `${rail.part} width across the track`),
    plates: profile.spec.surfacePlates.value + rail.thicknessLdu / LDU_PER_PLATE,
    belowPlates: 0,
    abovePlates: 0,
    bankStuds: 0,
    bankStartPlates: 0,
    bankRisePlatesPerStud: 0,
    bankVariationPlates: 0,
    ldrawColors: [profile.build.rail.ldrawColor],
  };
}

export function milsEdgeRules(library: LdrawLibrary): MilsEdgeRules {
  const profile = loadMilsProfile();
  const rail = measureBaseplate(library, profile.build.rail.part);
  const features = [
    levelFeatureRule(profile, "road"),
    levelFeatureRule(profile, "track"),
    riverRule(profile),
    railRule(profile, rail),
    levelFeatureRule(profile, "path"),
  ];
  return {
    source:
      "tools/asset-pipeline/src/mils/mils-profile.json spec (MILS rows of docs/verified-facts.md, S1 and S2); the rail rule is the project rail module, its width and height measured from the rail part at the pin",
    moduleStuds: profile.spec.moduleStuds.value,
    surfacePlates: profile.spec.surfacePlates.value,
    surfaceTolerancePlates: profile.spec.surfaceTolerancePlates.value,
    features: features.toSorted((a, b) => b.widthStuds - a.widthStuds),
  };
}
