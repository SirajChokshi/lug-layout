import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { BundleColor, ManifestPart } from "@brr/schema/bundle";
import type { Assembly, AssemblyPart, Vec3 } from "./assembly.ts";
import {
  holeLines,
  pinFrame,
  type Axis,
  type HoleLine,
  type LdrawBounds,
  type PinFrame,
} from "./technic-frames.ts";

export type GeneratedKind = "MILS-style module" | "modular" | "small MOC";
export type Section = "ground" | "edge" | "pins" | "scenery";

export interface GeneratedBuild {
  readonly name: string;
  readonly kind: GeneratedKind;
  readonly text: string;
  readonly collidingText: string;
  readonly assembly: Assembly;
  readonly collidingAssembly: Assembly;
}

export interface Block {
  readonly reference: string;
  readonly minX: number;
  readonly minZ: number;
  readonly width: number;
  readonly depth: number;
  readonly topY: number;
  readonly bottomY: number;
  readonly heightPlates: number;
  readonly holes: ReadonlyArray<HoleLine>;
}

export interface PinBlock {
  readonly reference: string;
  readonly frame: PinFrame;
}

export interface BlockPools {
  readonly baseplates: ReadonlyArray<Block>;
  readonly plates: ReadonlyArray<Block>;
  readonly bricks: ReadonlyArray<Block>;
  readonly tiles: ReadonlyArray<Block>;
  readonly technicBricks: ReadonlyArray<Block>;
  readonly pins: ReadonlyArray<PinBlock>;
  readonly colors: ReadonlyArray<number>;
}

export interface PoolCandidate {
  readonly part: ManifestPart;
  readonly studTopsY: ReadonlyArray<number>;
  readonly ldrawText: string | null;
}

export interface ModelNames {
  readonly file: string;
  readonly title: string;
  readonly sections: Readonly<Record<Section, string>>;
}

export interface ModuleModel {
  readonly names: ModelNames;
  readonly text: string;
  readonly assembly: Assembly;
}

export interface ModulePair {
  readonly seed: number;
  readonly subject: ModuleModel;
  readonly renamedSubject: ModuleModel;
  readonly partner: ModuleModel;
  readonly partnerOffset: Vec3;
  readonly alongEdge: Vec3;
  readonly pins: number;
}

const QUARTER_TURNS = 4;
const OPAQUE = 255;
const UINT32_RANGE = 2 ** 32;
const PLAIN_BASEPLATE = /^Baseplate\s+\d+ x\s+\d+( with Square Corners)?$/u;
const PLAIN_PLATE = /^Plate\s+\d+ x\s+\d+$/u;
const PLAIN_BRICK = /^Brick\s+\d+ x\s+\d+$/u;
const PLAIN_TILE = /^Tile\s+\d+ x\s+\d+( with Groove)?$/u;
const TECHNIC_BRICK_WITH_HOLES = /^Technic Brick\s+1 x\s+\d+ with Holes?$/u;
const FULL_TECHNIC_PIN = /^Technic Pin( with Friction)?( and Slots)?$/u;
const LIBRARY_PART_PREFIX = /^parts\//u;
const SQUARE_MODULE_STUDS = 32;
const SMALL_BASE_MIN_CELLS = 4;
const SMALL_BASE_MAX_STUDS = 12;
const MAX_STACK_PLATES = 36;
const EDGES = 4;
const EDGE_ATTEMPTS_PER_BRICK = 4;
const PINNED_BRICK_ATTEMPTS = 40;
const PIN_CHANCE = 0.5;
const NAME_LENGTH = 10;
const NAME_RADIX = 36;
const SECTIONS: ReadonlyArray<Section> = ["ground", "edge", "pins", "scenery"];
const AXES: ReadonlyArray<Axis> = [0, 1, 2];
const COS = [1, 0, -1, 0] as const;
const SIN = [0, 1, 0, -1] as const;

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  }

  int(below: number): number {
    return Math.floor(this.next() * below);
  }

  between(low: number, high: number): number {
    return low + this.int(high - low + 1);
  }

  pick<T>(items: ReadonlyArray<T>): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("cannot pick from an empty pool");
    return item;
  }

  token(): string {
    let out = "";
    while (out.length < NAME_LENGTH) out += this.int(NAME_RADIX).toString(NAME_RADIX);
    return out;
  }
}

export function ldrawBounds(part: ManifestPart): LdrawBounds {
  const [minX, minY, minZ] = part.bounds.min;
  const [maxX, maxY, maxZ] = part.bounds.max;
  return { min: [minX, -maxY, -maxZ], max: [maxX, -minY, -minZ] };
}

function wholeStuds(ldu: number): number | null {
  const studs = ldu / STUD_LDU;
  return Number.isInteger(studs) && studs > 0 ? studs : null;
}

function blockOf(
  { part, studTopsY, ldrawText: source }: PoolCandidate,
  stacked: boolean,
): Block | null {
  const bounds = ldrawBounds(part);
  const width = wholeStuds(bounds.max[0] - bounds.min[0]);
  const depth = wholeStuds(bounds.max[2] - bounds.min[2]);
  const heightPlates = (bounds.max[1] - bounds.min[1]) / PLATE_LDU;
  if (width === null || depth === null) return null;
  if (stacked && !Number.isInteger(heightPlates)) return null;
  if (studTopsY.some((y) => -y !== bounds.min[1])) return null;
  return {
    reference: part.path.replace(LIBRARY_PART_PREFIX, ""),
    minX: bounds.min[0],
    minZ: bounds.min[2],
    width,
    depth,
    topY: bounds.min[1],
    bottomY: bounds.max[1],
    heightPlates,
    holes: source === null ? [] : holeLines(source),
  };
}

function isHorizontal(axis: Axis): boolean {
  return axis !== 1;
}

export function needsLdrawText(title: string): boolean {
  return TECHNIC_BRICK_WITH_HOLES.test(title) || FULL_TECHNIC_PIN.test(title);
}

export function isPoolCandidate(title: string): boolean {
  return (
    needsLdrawText(title) ||
    [PLAIN_BASEPLATE, PLAIN_PLATE, PLAIN_BRICK, PLAIN_TILE].some((pattern) => pattern.test(title))
  );
}

export function producedColors(
  parts: Iterable<ManifestPart>,
  colors: ReadonlyArray<BundleColor>,
): ReadonlyArray<number> {
  const opaque = new Set(
    colors.filter((color) => color.alpha === OPAQUE).map((color) => color.code),
  );
  const produced = new Set<number>();
  for (const part of parts) {
    for (const color of part.producedColors?.colors ?? []) {
      if (opaque.has(color.ldraw)) produced.add(color.ldraw);
    }
  }
  return [...produced].toSorted((a, b) => a - b);
}

export function blockPools(
  candidates: ReadonlyArray<PoolCandidate>,
  parts: Iterable<ManifestPart>,
  colors: ReadonlyArray<BundleColor>,
): BlockPools {
  const pool = (title: RegExp, stacked: boolean, requireStuds: boolean): Block[] =>
    candidates.flatMap((candidate) => {
      if (!title.test(candidate.part.title)) return [];
      if (requireStuds && candidate.studTopsY.length === 0) return [];
      const block = blockOf(candidate, stacked);
      return block ? [block] : [];
    });
  const pins = candidates.flatMap((candidate): PinBlock[] => {
    if (!FULL_TECHNIC_PIN.test(candidate.part.title) || candidate.ldrawText === null) return [];
    const frame = pinFrame(candidate.ldrawText, ldrawBounds(candidate.part));
    if (!frame || !isHorizontal(frame.axis)) return [];
    return [{ reference: candidate.part.path.replace(LIBRARY_PART_PREFIX, ""), frame }];
  });
  const pools: BlockPools = {
    baseplates: pool(PLAIN_BASEPLATE, false, true),
    plates: pool(PLAIN_PLATE, true, true),
    bricks: pool(PLAIN_BRICK, true, true),
    tiles: pool(PLAIN_TILE, true, false),
    technicBricks: pool(TECHNIC_BRICK_WITH_HOLES, true, true).filter((block) =>
      block.holes.some((hole) => isHorizontal(hole.axis)),
    ),
    pins,
    colors: producedColors(parts, colors),
  };
  for (const [name, items] of Object.entries(pools)) {
    if (items.length === 0) throw new Error(`the bundle offers the generator no ${name}`);
  }
  return pools;
}

interface Placed {
  readonly block: Block;
  readonly color: number;
  readonly turn: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly section: Section;
}

interface PlacedPin {
  readonly pin: PinBlock;
  readonly color: number;
  readonly turn: number;
  readonly position: Vec3;
}

function rotation(turn: number): readonly [number, number] {
  return [COS[turn % QUARTER_TURNS] ?? 1, SIN[turn % QUARTER_TURNS] ?? 0];
}

function rotated(point: Vec3, turn: number): Vec3 {
  const [c, s] = rotation(turn);
  return [c * point[0] + s * point[2] + 0, point[1], -s * point[0] + c * point[2] + 0];
}

function turnedAxis(axis: Axis, turn: number): Axis {
  if (axis === 1 || turn % 2 === 0) return axis;
  return axis === 0 ? 2 : 0;
}

function turnedSize(block: Block, turn: number): readonly [number, number] {
  return turn % 2 === 0 ? [block.width, block.depth] : [block.depth, block.width];
}

function turnedMin(block: Block, turn: number): readonly [number, number] {
  let minX = Infinity;
  let minZ = Infinity;
  for (const x of [block.minX, block.minX + block.width * STUD_LDU]) {
    for (const z of [block.minZ, block.minZ + block.depth * STUD_LDU]) {
      const [rx, , rz] = rotated([x, 0, z], turn);
      minX = Math.min(minX, rx);
      minZ = Math.min(minZ, rz);
    }
  }
  return [minX, minZ];
}

function acrossAxes(axis: Axis): readonly [Axis, Axis] {
  const [first = 0, second = 2] = AXES.filter((other) => other !== axis);
  return [first, second];
}

function pointOn(line: HoleLine, along: number): Vec3 {
  const point: [number, number, number] = [0, 0, 0];
  const [first, second] = acrossAxes(line.axis);
  point[line.axis] = along;
  point[first] = line.at[0];
  point[second] = line.at[1];
  return point;
}

function placedLine(line: HoleLine, turn: number, origin: Vec3): HoleLine {
  const axis = turnedAxis(line.axis, turn);
  const ends = [line.from, line.to].map((along) => {
    const point = rotated(pointOn(line, along), turn);
    return [point[0] + origin[0], point[1] + origin[1], point[2] + origin[2]] as const;
  });
  const start = ends[0] ?? origin;
  const alongValues = ends.map((end) => end[axis]).toSorted((p, q) => p - q);
  const [first, second] = acrossAxes(axis);
  return {
    axis,
    at: [start[first], start[second]],
    from: alongValues[0] ?? 0,
    to: alongValues[1] ?? 0,
  };
}

interface EdgeFrame {
  readonly normal: Axis;
  readonly outward: number;
  readonly along: Axis;
}

function edgeFrame(edge: number): EdgeFrame {
  return edge < 2
    ? { normal: 2, outward: edge === 0 ? -1 : 1, along: 0 }
    : { normal: 0, outward: edge === 2 ? -1 : 1, along: 2 };
}

function oppositeEdge(edge: number): number {
  return edge % 2 === 0 ? edge + 1 : edge - 1;
}

class Build {
  readonly placed: Placed[] = [];
  readonly pins: PlacedPin[] = [];
  readonly base: Placed;
  readonly cellsX: number;
  readonly cellsZ: number;
  private readonly heights: Int16Array;

  constructor(
    base: Block,
    private readonly random: SeededRandom,
    private readonly colors: ReadonlyArray<number>,
  ) {
    this.base = {
      block: base,
      color: random.pick(colors),
      turn: 0,
      x: 0,
      y: 0,
      z: 0,
      section: "ground",
    };
    this.cellsX = base.width;
    this.cellsZ = base.depth;
    this.heights = new Int16Array(this.cellsX * this.cellsZ);
  }

  private fits(cellX: number, cellZ: number, sizeX: number, sizeZ: number): boolean {
    return cellX >= 0 && cellZ >= 0 && cellX + sizeX <= this.cellsX && cellZ + sizeZ <= this.cellsZ;
  }

  private footprintLayers(
    cellX: number,
    cellZ: number,
    sizeX: number,
    sizeZ: number,
  ): readonly [number, number] {
    let low = Infinity;
    let high = 0;
    for (let j = cellZ; j < cellZ + sizeZ; j++) {
      for (let i = cellX; i < cellX + sizeX; i++) {
        const layer = this.heights[j * this.cellsX + i] ?? 0;
        low = Math.min(low, layer);
        high = Math.max(high, layer);
      }
    }
    return [low, high];
  }

  place(
    block: Block,
    turn: number,
    cellX: number,
    cellZ: number,
    section: Section,
    flatOnly = false,
  ): Placed | null {
    const [sizeX, sizeZ] = turnedSize(block, turn);
    if (!this.fits(cellX, cellZ, sizeX, sizeZ)) return null;
    const [low, layer] = this.footprintLayers(cellX, cellZ, sizeX, sizeZ);
    if (flatOnly && low !== layer) return null;
    if (layer + block.heightPlates > MAX_STACK_PLATES) return null;
    const [minX, minZ] = turnedMin(block, turn);
    const [baseMinX, baseMinZ] = turnedMin(this.base.block, this.base.turn);
    const placed: Placed = {
      block,
      color: this.random.pick(this.colors),
      turn,
      x: this.base.x + baseMinX + cellX * STUD_LDU - minX,
      y: this.base.y + this.base.block.topY - layer * PLATE_LDU - block.bottomY,
      z: this.base.z + baseMinZ + cellZ * STUD_LDU - minZ,
      section,
    };
    this.placed.push(placed);
    for (let j = cellZ; j < cellZ + sizeZ; j++) {
      for (let i = cellX; i < cellX + sizeX; i++) {
        this.heights[j * this.cellsX + i] = layer + block.heightPlates;
      }
    }
    return placed;
  }

  scatter(pool: ReadonlyArray<Block>, attempts: number, section: Section, flatOnly = false): void {
    for (let k = 0; k < attempts; k++) {
      const block = this.random.pick(pool);
      const turn = this.random.int(QUARTER_TURNS);
      const [sizeX, sizeZ] = turnedSize(block, turn);
      const cellX = this.random.int(Math.max(1, this.cellsX - sizeX + 1));
      const cellZ = this.random.int(Math.max(1, this.cellsZ - sizeZ + 1));
      this.place(block, turn, cellX, cellZ, section, flatOnly);
    }
  }

  private edgePlane(frame: EdgeFrame): number {
    const [baseMinX, baseMinZ] = turnedMin(this.base.block, this.base.turn);
    const min = frame.normal === 0 ? this.base.x + baseMinX : this.base.z + baseMinZ;
    const cells = frame.normal === 0 ? this.cellsX : this.cellsZ;
    return frame.outward < 0 ? min : min + cells * STUD_LDU;
  }

  holeTurn(block: Block, edge: number): number | null {
    const frame = edgeFrame(edge);
    const hole = block.holes.find((line) => isHorizontal(line.axis));
    if (!hole) return null;
    return (hole.axis === frame.normal ? 0 : 1) + 2 * this.random.int(2);
  }

  alongCellCount(block: Block, edge: number, turn: number): number {
    const frame = edgeFrame(edge);
    const [sizeX, sizeZ] = turnedSize(block, turn);
    const alongSize = frame.along === 0 ? sizeX : sizeZ;
    const alongCells = frame.along === 0 ? this.cellsX : this.cellsZ;
    return Math.max(1, alongCells - alongSize + 1);
  }

  placeOnEdge(block: Block, edge: number, alongCell: number, turn: number): Placed | null {
    const frame = edgeFrame(edge);
    const [sizeX, sizeZ] = turnedSize(block, turn);
    const acrossSize = frame.normal === 0 ? sizeX : sizeZ;
    const acrossCells = frame.normal === 0 ? this.cellsX : this.cellsZ;
    const across = frame.outward < 0 ? 0 : acrossCells - acrossSize;
    return frame.normal === 0
      ? this.place(block, turn, across, alongCell, "edge")
      : this.place(block, turn, alongCell, across, "edge");
  }

  alongCellOf(placed: Placed, edge: number): number {
    const [minX, minZ] = turnedMin(placed.block, placed.turn);
    const [baseMinX, baseMinZ] = turnedMin(this.base.block, this.base.turn);
    return edgeFrame(edge).along === 0
      ? (placed.x + minX - this.base.x - baseMinX) / STUD_LDU
      : (placed.z + minZ - this.base.z - baseMinZ) / STUD_LDU;
  }

  insertPins(placed: Placed, edge: number, pin: PinBlock): number {
    const frame = edgeFrame(edge);
    const plane = this.edgePlane(frame);
    let inserted = 0;
    for (const local of placed.block.holes) {
      const line = placedLine(local, placed.turn, [placed.x, placed.y, placed.z]);
      if (line.axis !== frame.normal) continue;
      if ((frame.outward < 0 ? line.from : line.to) !== plane) continue;
      this.pins.push({
        pin,
        color: this.random.pick(this.colors),
        turn: pin.frame.axis === frame.normal ? 0 : 1,
        position: pointOn(line, plane),
      });
      inserted++;
    }
    return inserted;
  }

  edgeBricks(pool: ReadonlyArray<Block>, count: number, pins: ReadonlyArray<PinBlock>): void {
    let placedCount = 0;
    for (let k = 0; k < count * EDGE_ATTEMPTS_PER_BRICK && placedCount < count; k++) {
      const block = this.random.pick(pool);
      const edge = this.random.int(EDGES);
      const turn = this.holeTurn(block, edge);
      if (turn === null) continue;
      const alongCell = this.random.int(this.alongCellCount(block, edge, turn));
      const placed = this.placeOnEdge(block, edge, alongCell, turn);
      if (!placed) continue;
      placedCount++;
      if (pins.length > 0 && this.random.next() < PIN_CHANCE) {
        this.insertPins(placed, edge, this.random.pick(pins));
      }
    }
  }

  fillEdgeRow(edge: number, pool: ReadonlyArray<Block>): void {
    const frame = edgeFrame(edge);
    const singleWide = pool
      .filter((block) => Math.min(block.width, block.depth) === 1)
      .toSorted((a, b) => Math.max(b.width, b.depth) - Math.max(a.width, a.depth));
    const length = frame.along === 0 ? this.cellsX : this.cellsZ;
    const acrossCells = frame.normal === 0 ? this.cellsX : this.cellsZ;
    const across = frame.outward < 0 ? 0 : acrossCells - 1;
    const free = (at: number): boolean => {
      const [i, j] = frame.along === 0 ? [at, across] : [across, at];
      return (this.heights[j * this.cellsX + i] ?? 0) === 0;
    };
    let at = 0;
    while (at < length) {
      if (!free(at)) {
        at++;
        continue;
      }
      let run = 0;
      while (at + run < length && free(at + run)) run++;
      const block = singleWide.find(
        (candidate) => Math.max(candidate.width, candidate.depth) <= run,
      );
      if (!block) {
        at += run;
        continue;
      }
      const turn = block.width >= block.depth === (frame.along === 0) ? 0 : 1;
      this.placeOnEdge(block, edge, at, turn);
      at += Math.max(block.width, block.depth);
    }
  }

  wall(pool: ReadonlyArray<Block>, courses: number): void {
    const singleWide = pool.filter((block) => Math.min(block.width, block.depth) === 1);
    if (singleWide.length === 0) return;
    const alongX = this.random.int(2) === 0;
    const line = this.random.int(alongX ? this.cellsZ : this.cellsX);
    const length = alongX ? this.cellsX : this.cellsZ;
    for (let course = 0; course < courses; course++) {
      let at = this.random.int(2);
      while (at < length) {
        const block = this.random.pick(singleWide);
        const turn = block.width >= block.depth === alongX ? 0 : 1;
        this.place(block, turn, alongX ? at : line, alongX ? line : at, "scenery");
        at += Math.max(block.width, block.depth);
      }
    }
  }

  assembly(extra: ReadonlyArray<Placed> = []): Assembly {
    return [...[this.base, ...this.placed, ...extra].map(blockPart), ...this.pins.map(pinPart)];
  }
}

function blockPart(placed: Placed): AssemblyPart {
  const { block, turn } = placed;
  const origin: Vec3 = [placed.x, placed.y, placed.z];
  const min: [number, number, number] = [Infinity, placed.y + block.topY, Infinity];
  const max: [number, number, number] = [-Infinity, placed.y + block.bottomY, -Infinity];
  for (const x of [block.minX, block.minX + block.width * STUD_LDU]) {
    for (const z of [block.minZ, block.minZ + block.depth * STUD_LDU]) {
      const [rx, , rz] = rotated([x, 0, z], turn);
      min[0] = Math.min(min[0], rx + origin[0]);
      max[0] = Math.max(max[0], rx + origin[0]);
      min[2] = Math.min(min[2], rz + origin[2]);
      max[2] = Math.max(max[2], rz + origin[2]);
    }
  }
  return {
    reference: block.reference,
    min,
    max,
    holes: block.holes.map((hole) => placedLine(hole, turn, origin)),
    pin: null,
  };
}

function pinPart(placed: PlacedPin): AssemblyPart {
  const axis = turnedAxis(placed.pin.frame.axis, placed.turn);
  const { halfLength, radius } = placed.pin.frame;
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (const each of AXES) {
    const reach = each === axis ? halfLength : radius;
    min[each] = placed.position[each] - reach;
    max[each] = placed.position[each] + reach;
  }
  const [first, second] = acrossAxes(axis);
  return {
    reference: placed.pin.reference,
    min,
    max,
    holes: [],
    pin: {
      axis,
      at: [placed.position[first], placed.position[second]],
      from: placed.position[axis] - halfLength,
      to: placed.position[axis] + halfLength,
      radius,
    },
  };
}

function matrixText(turn: number): string {
  const [c, s] = rotation(turn);
  return [c, 0, s, 0, 1, 0, -s, 0, c].map((value) => String(value + 0)).join(" ");
}

function numbers(values: ReadonlyArray<number>): string {
  return values.map((value) => String(value + 0)).join(" ");
}

function lineOf(placed: Placed): string {
  const position = numbers([placed.x, placed.y, placed.z]);
  return `1 ${placed.color} ${position} ${matrixText(placed.turn)} ${placed.block.reference}`;
}

function pinLine(placed: PlacedPin): string {
  const position = numbers(placed.position);
  return `1 ${placed.color} ${position} ${matrixText(placed.turn)} ${placed.pin.reference}`;
}

const AUTHOR = "0 Author: lug-layout held-out generator";
const LICENSE = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt";
const IDENTITY_PLACEMENT = "0 0 0 1 0 0 0 1 0 0 0 1";
const INHERITED_COLOUR = 16;

function ldrawText(name: string, title: string, lines: ReadonlyArray<string>): string {
  return [`0 ${title}`, `0 Name: ${name}`, AUTHOR, LICENSE, ...lines, ""].join("\n");
}

function sectionLines(build: Build, section: Section): string[] {
  const blocks = [build.base, ...build.placed].filter((placed) => placed.section === section);
  return [...blocks.map(lineOf), ...(section === "pins" ? build.pins.map(pinLine) : [])];
}

function mpdText(build: Build, names: ModelNames): string {
  const present = SECTIONS.filter((section) => sectionLines(build, section).length > 0);
  const main = [
    `0 FILE ${names.file}`,
    `0 ${names.title}`,
    `0 Name: ${names.file}`,
    AUTHOR,
    LICENSE,
    ...present.map(
      (section) => `1 ${INHERITED_COLOUR} ${IDENTITY_PLACEMENT} ${names.sections[section]}`,
    ),
  ];
  const submodels = present.flatMap((section) => [
    `0 FILE ${names.sections[section]}`,
    `0 ${names.sections[section]}`,
    `0 Name: ${names.sections[section]}`,
    AUTHOR,
    LICENSE,
    ...sectionLines(build, section),
  ]);
  return [...main, ...submodels, ""].join("\n");
}

function squareModuleBase(pools: BlockPools, random: SeededRandom): Block {
  const square = pools.baseplates.filter(
    (block) => block.width === SQUARE_MODULE_STUDS && block.depth === SQUARE_MODULE_STUDS,
  );
  return random.pick(square.length > 0 ? square : pools.baseplates);
}

function landscape(build: Build, pools: BlockPools, random: SeededRandom): void {
  for (let layer = random.between(0, 3); layer > 0; layer--) {
    build.scatter(pools.plates, random.between(40, 160), "ground", true);
  }
  build.scatter(
    [...pools.bricks, ...pools.plates, ...pools.tiles],
    random.between(5, 40),
    "scenery",
  );
}

function milsModule(pools: BlockPools, random: SeededRandom): Build {
  const build = new Build(squareModuleBase(pools, random), random, pools.colors);
  build.edgeBricks(pools.technicBricks, random.between(2, 10), pools.pins);
  landscape(build, pools, random);
  return build;
}

function modular(pools: BlockPools, random: SeededRandom): Build {
  const build = new Build(random.pick(pools.baseplates), random, pools.colors);
  build.edgeBricks(pools.technicBricks, random.between(2, 8), []);
  for (let walls = random.between(1, 4); walls > 0; walls--) {
    build.wall(pools.bricks, random.between(1, 8));
  }
  build.scatter([...pools.plates, ...pools.tiles], random.between(5, 30), "scenery");
  return build;
}

function smallMoc(pools: BlockPools, random: SeededRandom): Build {
  const bases = pools.plates.filter(
    (block) =>
      block.width * block.depth >= SMALL_BASE_MIN_CELLS &&
      Math.max(block.width, block.depth) <= SMALL_BASE_MAX_STUDS,
  );
  const build = new Build(
    random.pick(bases.length > 0 ? bases : pools.plates),
    random,
    pools.colors,
  );
  build.scatter(
    [...pools.bricks, ...pools.plates, ...pools.tiles],
    random.between(3, 30),
    "scenery",
  );
  return build;
}

const KINDS: ReadonlyArray<
  readonly [GeneratedKind, (pools: BlockPools, random: SeededRandom) => Build]
> = [
  ["MILS-style module", milsModule],
  ["modular", modular],
  ["small MOC", smallMoc],
];

export function generateBuilds(
  pools: BlockPools,
  seed: number,
  perKind: number,
): ReadonlyArray<GeneratedBuild> {
  const random = new SeededRandom(seed);
  const builds: GeneratedBuild[] = [];
  for (const [kind, make] of KINDS) {
    for (let k = 0; k < perKind; k++) {
      const build = make(pools, random);
      const name = `held-out-${seed}-${builds.length + 1}.ldr`;
      const lines = [...[build.base, ...build.placed].map(lineOf), ...build.pins.map(pinLine)];
      const duplicate = build.placed.length > 0 ? random.pick(build.placed) : build.base;
      const title = `Held-out generated ${kind} (seed ${seed})`;
      builds.push({
        name,
        kind,
        text: ldrawText(name, title, lines),
        collidingText: ldrawText(name, `${title} with one part doubled in place`, [
          ...lines,
          lineOf(duplicate),
        ]),
        assembly: build.assembly(),
        collidingAssembly: build.assembly([duplicate]),
      });
    }
  }
  return builds;
}

function namedModule(base: string, title: string): ModelNames {
  return {
    file: `${base}.mpd`,
    title,
    sections: {
      ground: `${base}-ground.ldr`,
      edge: `${base}-edge-technic.ldr`,
      pins: `${base}-pins.ldr`,
      scenery: `${base}-scenery.ldr`,
    },
  };
}

function randomNames(random: SeededRandom): ModelNames {
  return {
    file: `${random.token()}.mpd`,
    title: random.token(),
    sections: {
      ground: `${random.token()}.ldr`,
      edge: `${random.token()}.ldr`,
      pins: `${random.token()}.ldr`,
      scenery: `${random.token()}.ldr`,
    },
  };
}

function pinnedSubject(
  pools: BlockPools,
  random: SeededRandom,
  edge: number,
): { readonly build: Build; readonly onEdge: ReadonlyArray<Placed> } {
  const build = new Build(squareModuleBase(pools, random), random, pools.colors);
  const pin = random.pick(pools.pins);
  const onEdge: Placed[] = [];
  const wanted = random.between(1, 4);
  for (let attempt = 0; attempt < PINNED_BRICK_ATTEMPTS && onEdge.length < wanted; attempt++) {
    const block = random.pick(pools.technicBricks);
    const turn = build.holeTurn(block, edge);
    if (turn === null) continue;
    const alongCell = random.int(build.alongCellCount(block, edge, turn));
    const placed = build.placeOnEdge(block, edge, alongCell, turn);
    if (!placed) continue;
    onEdge.push(placed);
    build.insertPins(placed, edge, pin);
  }
  if (build.pins.length === 0) throw new Error("no Technic brick took a pin on the subject's edge");
  return { build, onEdge };
}

export function modulePair(pools: BlockPools, seed: number): ModulePair {
  const random = new SeededRandom(seed);
  const edge = random.int(EDGES);
  const { build: subject, onEdge } = pinnedSubject(pools, random, edge);
  subject.edgeBricks(pools.technicBricks, random.between(1, 6), []);
  landscape(subject, pools, random);

  const partner = new Build(subject.base.block, random, pools.colors);
  const facing = oppositeEdge(edge);
  for (const brick of onEdge) {
    const alongCell = subject.alongCellOf(brick, edge);
    if (
      !Number.isInteger(alongCell) ||
      !partner.placeOnEdge(brick.block, facing, alongCell, brick.turn)
    ) {
      throw new Error("the partner can't take a hole brick opposite a pinned one");
    }
  }
  partner.fillEdgeRow(facing, pools.bricks);
  partner.edgeBricks(pools.technicBricks, random.between(1, 6), []);
  landscape(partner, pools, random);

  const frame = edgeFrame(edge);
  const size = (frame.normal === 0 ? subject.cellsX : subject.cellsZ) * STUD_LDU;
  const partnerOffset: [number, number, number] = [0, 0, 0];
  partnerOffset[frame.normal] = frame.outward * size;
  const alongEdge: [number, number, number] = [0, 0, 0];
  alongEdge[frame.along] = STUD_LDU;
  const subjectNames = namedModule(`mils-module-${seed}`, `MILS module ${seed}`);
  const renamedNames = randomNames(random);
  const partnerNames = namedModule(`mils-partner-${seed}`, `MILS partner ${seed}`);
  return {
    seed,
    subject: {
      names: subjectNames,
      text: mpdText(subject, subjectNames),
      assembly: subject.assembly(),
    },
    renamedSubject: {
      names: renamedNames,
      text: mpdText(subject, renamedNames),
      assembly: subject.assembly(),
    },
    partner: {
      names: partnerNames,
      text: mpdText(partner, partnerNames),
      assembly: partner.assembly(),
    },
    partnerOffset,
    alongEdge,
    pins: subject.pins.length,
  };
}
