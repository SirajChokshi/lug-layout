import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { BundleColor, ManifestPart } from "@brr/schema/bundle";

export type GeneratedKind = "MILS-style module" | "modular" | "small MOC";

export interface GeneratedBuild {
  readonly name: string;
  readonly kind: GeneratedKind;
  readonly text: string;
  readonly collidingText: string;
  readonly parts: number;
  readonly edgeTechnicBricks: number;
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
}

export interface BlockPools {
  readonly baseplates: ReadonlyArray<Block>;
  readonly plates: ReadonlyArray<Block>;
  readonly bricks: ReadonlyArray<Block>;
  readonly tiles: ReadonlyArray<Block>;
  readonly technicBricks: ReadonlyArray<Block>;
  readonly colors: ReadonlyArray<number>;
}

export interface PoolCandidate {
  readonly part: ManifestPart;
  readonly studTopsY: ReadonlyArray<number>;
}

const QUARTER_TURNS = 4;
const OPAQUE = 255;
const UINT32_RANGE = 2 ** 32;
const PLAIN_BASEPLATE = /^Baseplate\s+\d+ x\s+\d+( with Square Corners)?$/u;
const PLAIN_PLATE = /^Plate\s+\d+ x\s+\d+$/u;
const PLAIN_BRICK = /^Brick\s+\d+ x\s+\d+$/u;
const PLAIN_TILE = /^Tile\s+\d+ x\s+\d+( with Groove)?$/u;
const TECHNIC_BRICK_WITH_HOLE = /^Technic Brick\s+1 x\s+\d+ with Hole$/u;
const LIBRARY_PART_PREFIX = /^parts\//u;
const MILS_BASEPLATE_STUDS = 32;
const SMALL_BASE_MIN_CELLS = 4;
const SMALL_BASE_MAX_STUDS = 12;
const MAX_STACK_PLATES = 36;
const EDGES = 4;
const EDGE_ATTEMPTS_PER_BRICK = 4;

class SeededRandom {
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
}

function wholeStuds(ldu: number): number | null {
  const studs = ldu / STUD_LDU;
  return Number.isInteger(studs) && studs > 0 ? studs : null;
}

function blockOf({ part, studTopsY }: PoolCandidate, stacked: boolean): Block | null {
  const [minX, minY, minZ] = part.bounds.min;
  const [maxX, maxY, maxZ] = part.bounds.max;
  const width = wholeStuds(maxX - minX);
  const depth = wholeStuds(maxZ - minZ);
  const heightPlates = (maxY - minY) / PLATE_LDU;
  if (width === null || depth === null) return null;
  if (stacked && !Number.isInteger(heightPlates)) return null;
  if (studTopsY.some((y) => y !== maxY)) return null;
  return {
    reference: part.path.replace(LIBRARY_PART_PREFIX, ""),
    minX,
    minZ: -maxZ,
    width,
    depth,
    topY: -maxY,
    bottomY: -minY,
    heightPlates,
  };
}

export function isPoolCandidate(title: string): boolean {
  return [PLAIN_BASEPLATE, PLAIN_PLATE, PLAIN_BRICK, PLAIN_TILE, TECHNIC_BRICK_WITH_HOLE].some(
    (pattern) => pattern.test(title),
  );
}

export function blockPools(
  candidates: ReadonlyArray<PoolCandidate>,
  colors: ReadonlyArray<BundleColor>,
): BlockPools {
  const pool = (title: RegExp, stacked: boolean, requireStuds: boolean): Block[] =>
    candidates.flatMap((candidate) => {
      if (!title.test(candidate.part.title)) return [];
      if (requireStuds && candidate.studTopsY.length === 0) return [];
      const block = blockOf(candidate, stacked);
      return block ? [block] : [];
    });
  const pools: BlockPools = {
    baseplates: pool(PLAIN_BASEPLATE, false, true),
    plates: pool(PLAIN_PLATE, true, true),
    bricks: pool(PLAIN_BRICK, true, true),
    tiles: pool(PLAIN_TILE, true, false),
    technicBricks: pool(TECHNIC_BRICK_WITH_HOLE, true, true),
    colors: colors.filter((color) => color.alpha === OPAQUE).map((color) => color.code),
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
}

const COS = [1, 0, -1, 0] as const;
const SIN = [0, 1, 0, -1] as const;

function rotation(turn: number): readonly [number, number] {
  return [COS[turn % QUARTER_TURNS] ?? 1, SIN[turn % QUARTER_TURNS] ?? 0];
}

function turnedSize(block: Block, turn: number): readonly [number, number] {
  return turn % 2 === 0 ? [block.width, block.depth] : [block.depth, block.width];
}

function turnedMin(block: Block, turn: number): readonly [number, number] {
  const [c, s] = rotation(turn);
  let minX = Infinity;
  let minZ = Infinity;
  for (const x of [block.minX, block.minX + block.width * STUD_LDU]) {
    for (const z of [block.minZ, block.minZ + block.depth * STUD_LDU]) {
      minX = Math.min(minX, c * x + s * z);
      minZ = Math.min(minZ, -s * x + c * z);
    }
  }
  return [minX, minZ];
}

class Build {
  readonly placed: Placed[] = [];
  readonly base: Placed;
  readonly cellsX: number;
  readonly cellsZ: number;
  private readonly heights: Int16Array;

  constructor(
    base: Block,
    private readonly random: SeededRandom,
    private readonly colors: ReadonlyArray<number>,
  ) {
    this.base = { block: base, color: random.pick(colors), turn: 0, x: 0, y: 0, z: 0 };
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

  place(block: Block, turn: number, cellX: number, cellZ: number, flatOnly = false): boolean {
    const [sizeX, sizeZ] = turnedSize(block, turn);
    if (!this.fits(cellX, cellZ, sizeX, sizeZ)) return false;
    const [low, layer] = this.footprintLayers(cellX, cellZ, sizeX, sizeZ);
    if (flatOnly && low !== layer) return false;
    if (layer + block.heightPlates > MAX_STACK_PLATES) return false;
    const [minX, minZ] = turnedMin(block, turn);
    const [baseMinX, baseMinZ] = turnedMin(this.base.block, this.base.turn);
    const surfaceY = this.base.y + this.base.block.topY;
    this.placed.push({
      block,
      color: this.random.pick(this.colors),
      turn,
      x: this.base.x + baseMinX + cellX * STUD_LDU - minX,
      y: surfaceY - layer * PLATE_LDU - block.bottomY,
      z: this.base.z + baseMinZ + cellZ * STUD_LDU - minZ,
    });
    for (let j = cellZ; j < cellZ + sizeZ; j++) {
      for (let i = cellX; i < cellX + sizeX; i++) {
        this.heights[j * this.cellsX + i] = layer + block.heightPlates;
      }
    }
    return true;
  }

  scatter(pool: ReadonlyArray<Block>, attempts: number, flatOnly = false): void {
    for (let k = 0; k < attempts; k++) {
      const block = this.random.pick(pool);
      const turn = this.random.int(QUARTER_TURNS);
      const [sizeX, sizeZ] = turnedSize(block, turn);
      const cellX = this.random.int(Math.max(1, this.cellsX - sizeX + 1));
      const cellZ = this.random.int(Math.max(1, this.cellsZ - sizeZ + 1));
      this.place(block, turn, cellX, cellZ, flatOnly);
    }
  }

  edgeBricks(pool: ReadonlyArray<Block>, count: number): void {
    let placed = 0;
    for (let k = 0; k < count * EDGE_ATTEMPTS_PER_BRICK && placed < count; k++) {
      const block = this.random.pick(pool);
      const edge = this.random.int(EDGES);
      const edgeRunsAlongX = edge < 2;
      const blockRunsAlongX = block.width >= block.depth;
      const turn = (edgeRunsAlongX === blockRunsAlongX ? 0 : 1) + 2 * this.random.int(2);
      const [sizeX, sizeZ] = turnedSize(block, turn);
      const alongX = this.random.int(Math.max(1, this.cellsX - sizeX + 1));
      const alongZ = this.random.int(Math.max(1, this.cellsZ - sizeZ + 1));
      const cellX = edge === 2 ? 0 : edge === 3 ? this.cellsX - sizeX : alongX;
      const cellZ = edge === 0 ? 0 : edge === 1 ? this.cellsZ - sizeZ : alongZ;
      if (this.place(block, turn, cellX, cellZ)) placed++;
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
        this.place(block, turn, alongX ? at : line, alongX ? line : at);
        at += Math.max(block.width, block.depth);
      }
    }
  }
}

function matrixText(turn: number): string {
  const [c, s] = rotation(turn);
  return [c, 0, s, 0, 1, 0, -s, 0, c].map((value) => String(value + 0)).join(" ");
}

function lineOf(placed: Placed): string {
  const position = [placed.x, placed.y, placed.z].map((value) => String(value + 0)).join(" ");
  return `1 ${placed.color} ${position} ${matrixText(placed.turn)} ${placed.block.reference}`;
}

function ldrawText(name: string, title: string, lines: ReadonlyArray<string>): string {
  return [
    `0 ${title}`,
    `0 Name: ${name}`,
    "0 Author: lug-layout held-out generator",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    ...lines,
    "",
  ].join("\n");
}

function milsModule(pools: BlockPools, random: SeededRandom): Build {
  const square = pools.baseplates.filter(
    (block) => block.width === MILS_BASEPLATE_STUDS && block.depth === MILS_BASEPLATE_STUDS,
  );
  const build = new Build(
    random.pick(square.length > 0 ? square : pools.baseplates),
    random,
    pools.colors,
  );
  for (let layer = random.between(0, 3); layer > 0; layer--) {
    build.scatter(pools.plates, random.between(40, 160), true);
  }
  build.edgeBricks(pools.technicBricks, random.between(2, 10));
  build.scatter([...pools.bricks, ...pools.plates, ...pools.tiles], random.between(5, 40));
  return build;
}

function modular(pools: BlockPools, random: SeededRandom): Build {
  const build = new Build(random.pick(pools.baseplates), random, pools.colors);
  build.edgeBricks(pools.technicBricks, random.between(2, 8));
  for (let walls = random.between(1, 4); walls > 0; walls--) {
    build.wall(pools.bricks, random.between(1, 8));
  }
  build.scatter([...pools.plates, ...pools.tiles], random.between(5, 30));
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
  build.scatter([...pools.bricks, ...pools.plates, ...pools.tiles], random.between(3, 30));
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
      const lines = [build.base, ...build.placed].map(lineOf);
      const duplicate = lineOf(build.placed.length > 0 ? random.pick(build.placed) : build.base);
      const title = `Held-out generated ${kind} (seed ${seed})`;
      builds.push({
        name,
        kind,
        text: ldrawText(name, title, lines),
        collidingText: ldrawText(name, `${title} with one part doubled in place`, [
          ...lines,
          duplicate,
        ]),
        parts: lines.length,
        edgeTechnicBricks: build.placed.filter((placed) =>
          pools.technicBricks.includes(placed.block),
        ).length,
      });
    }
  }
  return builds;
}
