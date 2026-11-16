import type { PartFootprint } from "./part-footprint.ts";
import { CHUNK_STUDS, PlacementWriter, STUD_LDU, type ChunkPlacements } from "./placements.ts";

const LOTS_PER_SIDE = 3;
const LOT_CELLS = 10;
const LOT_AREA_FIRST_CELL = 1;
const LOT_MARGIN_CELLS = 1;
const BUILDING_MIN_CELLS = 6;
const MAX_LAYERS = 64;
const FLOOR_EVERY_LAYERS = 4;
const ROOF_DETAILS_PER_BUILDING = 4;
const SEGMENT_SCRATCH = 64;
const ROAD_COLUMN_EVERY = 3;

export interface RoadModule {
  readonly part: number;
  readonly color: number;
}

export interface CityParts {
  readonly ground: PartFootprint;
  readonly roads: ReadonlyArray<RoadModule>;
  readonly roofPlates: ReadonlyArray<PartFootprint>;
  readonly thinWall: ReadonlyArray<PartFootprint>;
  readonly thickWall: ReadonlyArray<PartFootprint>;
  readonly details: ReadonlyArray<PartFootprint>;
}

export interface CityColors {
  readonly ground: number;
  readonly roof: number;
  readonly walls: ReadonlyArray<number>;
  readonly details: ReadonlyArray<number>;
}

export interface CityOptions {
  readonly targetParts: number;
  readonly partsPerModule: number;
  readonly seed: number;
}

export interface CityLayout {
  readonly chunks: ReadonlyArray<ChunkPlacements>;
  readonly side: number;
  readonly firstChunk: number;
  readonly roadColumns: ReadonlyArray<number>;
}

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
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  pick<T>(items: ReadonlyArray<T>): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error("cannot pick from an empty list");
    return item;
  }

  evenBetween(min: number, max: number): number {
    const steps = Math.floor((max - min) / 2) + 1;
    return min + 2 * Math.floor(this.next() * steps);
  }
}

const segmentPieces = new Int32Array(SEGMENT_SCRATCH);
const segmentStarts = new Int32Array(SEGMENT_SCRATCH);

function fillSegment(
  length: number,
  pieces: ReadonlyArray<PartFootprint>,
  stagger: boolean,
): number {
  const shortest = pieces[pieces.length - 1];
  if (!shortest) throw new Error("no pieces to fill a wall segment");
  let remaining = length;
  let start = 0;
  let count = 0;
  while (remaining > 0) {
    let chosen = -1;
    const preferShort = stagger && count === 0 && remaining >= 2 * shortest.widthStuds;
    for (let p = preferShort ? pieces.length - 1 : 0; p < pieces.length; p++) {
      const width = pieces[p]?.widthStuds ?? 0;
      const rest = remaining - width;
      if (width > 0 && (rest === 0 || rest >= shortest.widthStuds)) {
        chosen = p;
        break;
      }
    }
    const piece = pieces[chosen];
    if (!piece || count === SEGMENT_SCRATCH) {
      throw new Error(`cannot fill a ${length}-stud segment with the available pieces`);
    }
    segmentPieces[count] = chosen;
    segmentStarts[count] = start;
    count++;
    start += piece.widthStuds;
    remaining -= piece.widthStuds;
  }
  return count;
}

interface Building {
  readonly x0: number;
  readonly z0: number;
  readonly width: number;
  readonly depth: number;
  readonly pieces: ReadonlyArray<PartFootprint>;
  readonly thickness: number;
  readonly layerPlates: number;
  readonly color: number;
  layers: number;
}

function cellCentre(startCell: number, spanCells: number): number {
  return startCell * STUD_LDU + (spanCells * STUD_LDU) / 2;
}

function emitRun(
  out: PlacementWriter,
  b: Building,
  alongX: boolean,
  fixed: number,
  from: number,
  length: number,
  stagger: boolean,
  yPlates: number,
): void {
  const n = fillSegment(length, b.pieces, stagger);
  for (let i = 0; i < n; i++) {
    const piece = b.pieces[segmentPieces[i] ?? 0];
    if (!piece) continue;
    const along = cellCentre(from + (segmentStarts[i] ?? 0), piece.widthStuds);
    const across = cellCentre(fixed, piece.depthStuds);
    if (alongX) out.push(piece.index, b.color, along, across, yPlates, 0);
    else out.push(piece.index, b.color, across, along, yPlates, 1);
  }
}

function emitLayer(out: PlacementWriter, b: Building): void {
  const yPlates = (b.layers + 1) * b.layerPlates;
  const xFull = b.layers % 2 === 0;
  const stagger = b.layers % 4 >= 2;
  const t = b.thickness;
  const xFrom = xFull ? b.x0 : b.x0 + t;
  const xLength = xFull ? b.width : b.width - 2 * t;
  const zFrom = xFull ? b.z0 + t : b.z0;
  const zLength = xFull ? b.depth - 2 * t : b.depth;
  emitRun(out, b, true, b.z0, xFrom, xLength, stagger, yPlates);
  emitRun(out, b, true, b.z0 + b.depth - t, xFrom, xLength, !stagger, yPlates);
  emitRun(out, b, false, b.x0, zFrom, zLength, stagger, yPlates);
  emitRun(out, b, false, b.x0 + b.width - t, zFrom, zLength, !stagger, yPlates);
}

function emitPlates(
  out: PlacementWriter,
  plates: ReadonlyArray<PartFootprint>,
  x0: number,
  z0: number,
  width: number,
  depth: number,
  base: number,
  color: number,
): void {
  const rowDepth = plates[0]?.depthStuds ?? 1;
  for (let row = 0; row < depth / rowDepth; row++) {
    const n = fillSegment(width, plates, false);
    for (let i = 0; i < n; i++) {
      const plate = plates[segmentPieces[i] ?? 0];
      if (!plate) continue;
      out.push(
        plate.index,
        color,
        cellCentre(x0 + (segmentStarts[i] ?? 0), plate.widthStuds),
        cellCentre(z0 + row * rowDepth, plate.depthStuds),
        base + plate.heightPlates,
        0,
      );
    }
  }
}

function roofPlateCount(b: Building, roof: ReadonlyArray<PartFootprint>): number {
  const rowDepth = roof[0]?.depthStuds ?? 1;
  return (b.depth / rowDepth) * fillSegment(b.width, roof, false);
}

function emitRoof(
  out: PlacementWriter,
  b: Building,
  parts: CityParts,
  colors: CityColors,
  random: SeededRandom,
): void {
  const roofBase = b.layers * b.layerPlates;
  emitPlates(out, parts.roofPlates, b.x0, b.z0, b.width, b.depth, roofBase, colors.roof);
  const roofTop = roofBase + (parts.roofPlates[0]?.heightPlates ?? 0);
  for (let d = 0; d < ROOF_DETAILS_PER_BUILDING; d++) {
    const detail = random.pick(parts.details);
    const cornerX = d % 2 === 0 ? b.x0 : b.x0 + b.width - 1;
    const cornerZ = d < 2 ? b.z0 : b.z0 + b.depth - 1;
    out.push(
      detail.index,
      random.pick(colors.details),
      cellCentre(cornerX, 1),
      cellCentre(cornerZ, 1),
      roofTop + detail.heightPlates,
      0,
    );
  }
}

function buildingModule(
  chunkX: number,
  chunkZ: number,
  target: number,
  parts: CityParts,
  colors: CityColors,
  random: SeededRandom,
): ChunkPlacements {
  const out = new PlacementWriter();
  const half = (CHUNK_STUDS * STUD_LDU) / 2;
  out.push(parts.ground.index, colors.ground, half, half, 0, 0);
  const inner = LOT_CELLS - 2 * LOT_MARGIN_CELLS;
  const buildings: Building[] = [];
  for (let lot = 0; lot < LOTS_PER_SIDE * LOTS_PER_SIDE; lot++) {
    const pieces = random.next() < 0.5 ? parts.thickWall : parts.thinWall;
    const width = random.evenBetween(BUILDING_MIN_CELLS, inner);
    const depth = random.evenBetween(BUILDING_MIN_CELLS, inner);
    const lotX = LOT_AREA_FIRST_CELL + (lot % LOTS_PER_SIDE) * LOT_CELLS + LOT_MARGIN_CELLS;
    const lotZ =
      LOT_AREA_FIRST_CELL + Math.floor(lot / LOTS_PER_SIDE) * LOT_CELLS + LOT_MARGIN_CELLS;
    buildings.push({
      x0: lotX + (inner - width) / 2,
      z0: lotZ + (inner - depth) / 2,
      width,
      depth,
      pieces,
      thickness: pieces[0]?.depthStuds ?? 1,
      layerPlates: pieces[0]?.heightPlates ?? 0,
      color: random.pick(colors.walls),
      layers: 0,
    });
  }
  let reserved = 0;
  for (const b of buildings)
    reserved += roofPlateCount(b, parts.roofPlates) + ROOF_DETAILS_PER_BUILDING;
  let grew = true;
  while (grew && out.count + reserved < target) {
    grew = false;
    for (const b of buildings) {
      if (out.count + reserved >= target || b.layers >= MAX_LAYERS) continue;
      emitLayer(out, b);
      b.layers++;
      if (b.layers % FLOOR_EVERY_LAYERS === 0 && b.layers < MAX_LAYERS) {
        const t = b.thickness;
        emitPlates(
          out,
          parts.roofPlates,
          b.x0 + t,
          b.z0 + t,
          b.width - 2 * t,
          b.depth - 2 * t,
          b.layers * b.layerPlates,
          colors.roof,
        );
      }
      grew = true;
    }
  }
  for (const b of buildings) emitRoof(out, b, parts, colors, random);
  return out.finish(chunkX, chunkZ);
}

function roadModule(chunkX: number, chunkZ: number, road: RoadModule): ChunkPlacements {
  const out = new PlacementWriter();
  const half = (CHUNK_STUDS * STUD_LDU) / 2;
  out.push(road.part, road.color, half, half, 0, 0);
  return out.finish(chunkX, chunkZ);
}

function isRoadColumn(column: number): boolean {
  return column % ROAD_COLUMN_EVERY === 0;
}

function buildingCellsFor(side: number): number {
  let columns = 0;
  for (let c = 0; c < side; c++) if (!isRoadColumn(c)) columns++;
  return columns * side;
}

export function generateCity(
  options: CityOptions,
  parts: CityParts,
  colors: CityColors,
): CityLayout {
  const wantedBuildings = Math.max(1, Math.ceil(options.targetParts / options.partsPerModule));
  let side = 2;
  while (buildingCellsFor(side) < wantedBuildings) side++;
  const buildingCells = buildingCellsFor(side);
  const perModule = Math.ceil(options.targetParts / buildingCells);
  const firstChunk = -Math.floor(side / 2);
  const random = new SeededRandom(options.seed);
  const chunks: ChunkPlacements[] = [];
  const roadColumns: number[] = [];
  let roadOrdinal = 0;
  for (let column = 0; column < side; column++) {
    const chunkX = firstChunk + column;
    if (isRoadColumn(column)) {
      const road = parts.roads[roadOrdinal % parts.roads.length];
      if (!road) throw new Error("city needs at least one road module");
      roadOrdinal++;
      roadColumns.push(chunkX);
      for (let row = 0; row < side; row++) chunks.push(roadModule(chunkX, firstChunk + row, road));
      continue;
    }
    for (let row = 0; row < side; row++) {
      chunks.push(buildingModule(chunkX, firstChunk + row, perModule, parts, colors, random));
    }
  }
  return { chunks, side, firstChunk, roadColumns };
}
