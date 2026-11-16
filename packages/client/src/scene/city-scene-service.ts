import {
  PART_BUNDLE_LOADER,
  type BundleLod,
  type IPartBundleLoader,
  type PartBundle,
} from "@brr/catalog";
import {
  COLOR_CHANNELS,
  SCENE_BACKEND,
  type BackendInfo,
  type FrameStats,
  type ISceneBackend,
  type SceneBackendConfig,
} from "@brr/render";
import { inject, injectable } from "inversify";
import { footprintOf, STUD_LDU, type PartFootprint } from "../city/part-footprint.ts";
import { placementsToInstances } from "../city/placements-to-instances.ts";
import {
  CHUNK_STUDS,
  generateCity,
  STREET_CELLS,
  type ChunkPlacements,
  type CityColors,
  type CityParts,
} from "../city/procedural-city.ts";

export type CameraPath = "aerial" | "street";

export interface CitySceneOptions {
  readonly lod: BundleLod;
  readonly targetParts: number;
  readonly partsPerModule: number;
  readonly seed: number;
}

export interface PartUsage {
  readonly id: string;
  readonly title: string;
  readonly instances: number;
  readonly trianglesPerInstance: number;
}

export interface CitySceneSummary {
  readonly parts: number;
  readonly modules: number;
  readonly studInstances: number;
  readonly bodyTriangles: number;
  readonly studTriangles: number;
  readonly usage: ReadonlyArray<PartUsage>;
  readonly creditedFiles: number;
  readonly disclaimer: string;
}

export interface ICitySceneService {
  attach(config: SceneBackendConfig): Promise<BackendInfo>;
  load(options: CitySceneOptions): Promise<CitySceneSummary>;
  setCamera(path: CameraPath, t: number): void;
  resize(width: number, height: number): void;
  renderFrame(out: FrameStats): void;
  waitForGpu(): Promise<void>;
}

const CHUNK_LDU = CHUNK_STUDS * STUD_LDU;
const STREET_CENTRE_LDU = (STREET_CELLS * STUD_LDU) / 2;
const STREET_EYE_HEIGHT_LDU = 140;
const STREET_LOOK_AHEAD_LDU = 900;
const AERIAL_RADIUS_FACTOR = 0.8;
const AERIAL_HEIGHT_FACTOR = 0.55;
const AERIAL_MIN_EXTENT_LDU = 1200;

const CITY_COLOR_NAMES = {
  ground: "Green",
  street: "Light_Bluish_Grey",
  roof: "Dark_Bluish_Grey",
  walls: [
    "Red",
    "White",
    "Tan",
    "Yellow",
    "Blue",
    "Dark_Tan",
    "Reddish_Brown",
    "Light_Bluish_Grey",
  ],
  details: ["Yellow", "White", "Red", "Black"],
} as const;

function byWidthDescending(a: PartFootprint, b: PartFootprint): number {
  return b.widthStuds - a.widthStuds;
}

function selectCityParts(bundle: PartBundle): CityParts {
  const footprints = bundle.parts.map(footprintOf);
  const studless = (f: PartFootprint): boolean =>
    (bundle.parts[f.index]?.studPrimitiveIndex.length ?? 0) === 0;
  const ground = footprints.find(
    (f) => f.role === "ground" && f.widthStuds === CHUNK_STUDS && f.depthStuds === CHUNK_STUDS,
  );
  const streetTile = footprints.find(
    (f) => f.role === "detail" && studless(f) && f.widthStuds === f.depthStuds && f.widthStuds > 1,
  );
  const roofPlates = footprints.filter((f) => f.role === "roof").toSorted(byWidthDescending);
  const walls = footprints.filter((f) => f.role === "wall").toSorted(byWidthDescending);
  const thinWall = walls.filter((f) => f.depthStuds === 1);
  const thickWall = walls.filter((f) => f.depthStuds === 2);
  const details = footprints.filter(
    (f) => f.role === "detail" && f.widthStuds === 1 && f.depthStuds === 1,
  );
  if (
    !ground ||
    !streetTile ||
    roofPlates.length === 0 ||
    thinWall.length === 0 ||
    thickWall.length === 0 ||
    details.length === 0
  ) {
    throw new Error("bundle does not contain the part roles the benchmark city needs");
  }
  return { ground, streetTile, roofPlates, thinWall, thickWall, details };
}

function colorTable(bundle: PartBundle): { colors: CityColors; srgb: Uint8Array } {
  const names: string[] = [];
  const indexOf = (name: string): number => {
    const existing = names.indexOf(name);
    if (existing >= 0) return existing;
    names.push(name);
    return names.length - 1;
  };
  const colors: CityColors = {
    ground: indexOf(CITY_COLOR_NAMES.ground),
    street: indexOf(CITY_COLOR_NAMES.street),
    roof: indexOf(CITY_COLOR_NAMES.roof),
    walls: CITY_COLOR_NAMES.walls.map(indexOf),
    details: CITY_COLOR_NAMES.details.map(indexOf),
  };
  const srgb = new Uint8Array(names.length * COLOR_CHANNELS);
  names.forEach((name, i) => {
    const entry = bundle.colors.find((c) => c.name === name);
    if (!entry) throw new Error(`LDConfig colour ${name} is missing from the bundle`);
    const value = Number.parseInt(entry.rgb.slice(1), 16);
    srgb[i * 3] = (value >> 16) & 0xff;
    srgb[i * 3 + 1] = (value >> 8) & 0xff;
    srgb[i * 3 + 2] = value & 0xff;
  });
  return { colors, srgb };
}

function studTrianglesOf(bundle: PartBundle, partIndex: number): number {
  const part = bundle.parts[partIndex];
  if (!part) return 0;
  let total = 0;
  for (let s = 0; s < part.studPrimitiveIndex.length; s++) {
    total += (bundle.studPrimitives[part.studPrimitiveIndex[s] ?? 0]?.mesh.indices.length ?? 0) / 3;
  }
  return total;
}

@injectable()
export class CitySceneService implements ICitySceneService {
  private chunks: ReadonlyArray<ChunkPlacements> = [];
  private minX = 0;
  private maxX = 0;
  private minZ = 0;
  private maxZ = 0;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
  ) {}

  attach(config: SceneBackendConfig): Promise<BackendInfo> {
    return this.backend.init(config);
  }

  async load(options: CitySceneOptions): Promise<CitySceneSummary> {
    const bundle = await this.loader.load(options.lod);
    const parts = selectCityParts(bundle);
    const { colors, srgb } = colorTable(bundle);
    this.backend.setPalette({
      parts: bundle.parts,
      studPrimitives: bundle.studPrimitives,
      colorsSrgb: srgb,
    });
    this.chunks = generateCity(options, parts, colors);
    const instances = new Float64Array(bundle.parts.length);
    this.minX = Infinity;
    this.minZ = Infinity;
    this.maxX = -Infinity;
    this.maxZ = -Infinity;
    for (const chunk of this.chunks) {
      this.backend.setChunk(chunk.key, placementsToInstances(chunk));
      for (let i = 0; i < chunk.count; i++)
        instances[chunk.partIndex[i] ?? 0] = (instances[chunk.partIndex[i] ?? 0] ?? 0) + 1;
      this.minX = Math.min(this.minX, chunk.chunkX * CHUNK_LDU);
      this.minZ = Math.min(this.minZ, chunk.chunkZ * CHUNK_LDU);
      this.maxX = Math.max(this.maxX, (chunk.chunkX + 1) * CHUNK_LDU);
      this.maxZ = Math.max(this.maxZ, (chunk.chunkZ + 1) * CHUNK_LDU);
    }
    let total = 0;
    let studInstances = 0;
    let bodyTriangles = 0;
    let studTriangles = 0;
    const usage: PartUsage[] = bundle.parts.map((part, p) => {
      const count = instances[p] ?? 0;
      const body = part.body.indices.length / 3;
      const studs = studTrianglesOf(bundle, p);
      total += count;
      studInstances += count * part.studPrimitiveIndex.length;
      bodyTriangles += count * body;
      studTriangles += count * studs;
      return {
        id: part.id,
        title: part.title,
        instances: count,
        trianglesPerInstance: body + studs,
      };
    });
    return {
      parts: total,
      modules: this.chunks.length,
      studInstances,
      bodyTriangles,
      studTriangles,
      usage,
      creditedFiles: bundle.credits.length,
      disclaimer: bundle.disclaimer,
    };
  }

  setCamera(path: CameraPath, t: number): void {
    const centreX = (this.minX + this.maxX) / 2;
    const centreZ = (this.minZ + this.maxZ) / 2;
    if (path === "aerial") {
      const extent = Math.max(this.maxX - this.minX, this.maxZ - this.minZ, AERIAL_MIN_EXTENT_LDU);
      const angle = t * 2 * Math.PI;
      const radius = extent * AERIAL_RADIUS_FACTOR;
      this.backend.setView(
        centreX + radius * Math.cos(angle),
        extent * AERIAL_HEIGHT_FACTOR,
        centreZ + radius * Math.sin(angle),
        centreX,
        0,
        centreZ,
      );
      return;
    }
    const streetX = Math.floor(centreX / CHUNK_LDU) * CHUNK_LDU + STREET_CENTRE_LDU;
    const z = this.minZ + (this.maxZ - this.minZ) * t;
    this.backend.setView(
      streetX,
      STREET_EYE_HEIGHT_LDU,
      z,
      streetX,
      STREET_EYE_HEIGHT_LDU * 0.6,
      z + STREET_LOOK_AHEAD_LDU,
    );
  }

  resize(width: number, height: number): void {
    this.backend.resize(width, height);
  }

  renderFrame(out: FrameStats): void {
    this.backend.renderFrame(out);
  }

  waitForGpu(): Promise<void> {
    return this.backend.waitForGpu();
  }
}
