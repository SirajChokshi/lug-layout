import {
  PART_BUNDLE_LOADER,
  type BundleLod,
  type IPartBundleLoader,
  type PartBundle,
  type PartRole,
} from "@brr/catalog";
import { SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { World } from "@brr/domain";
import { inject, injectable } from "inversify";
import { footprintOf, plateDepthBelowOrigin, type PartFootprint } from "./part-footprint.ts";
import { CHUNK_LDU, CHUNK_STUDS } from "@brr/math";
import { chunkInstances, dumpPlacements, type PlacementDump } from "./placements.ts";
import {
  generateCity,
  type CityColors,
  type CityParts,
  type RailModule,
  type RoadModule,
} from "./procedural-city.ts";
import { withStuds } from "./stud-stream.ts";
import { straightRunPitchStuds } from "./straight-track.ts";
import {
  ColorTable,
  PALETTE_PARTS,
  showChunks,
  type IViewerScene,
  type SceneSummary,
} from "./viewer-scene.ts";

export type CityCamera = "aerial" | "street";

export interface CityRequest {
  readonly targetParts: number;
  readonly seed: number;
  readonly camera: CityCamera;
  readonly originChunkX: number;
  readonly originChunkZ: number;
}

export interface ICityScene extends IViewerScene {
  configure(request: CityRequest): void;
  placementDump(): PlacementDump;
}

const PARTS_PER_BUILDING_MODULE = 2_000;
const COVERING_ROLES: ReadonlySet<PartRole> = new Set<PartRole>(["wall", "roof", "detail"]);
const STREET_EYE_HEIGHT_LDU = 120;
const STREET_LOOK_AHEAD_LDU = 900;
const STREET_LOOK_DOWN_FACTOR = 0.5;
const AERIAL_RADIUS_FACTOR = 0.85;
const AERIAL_HEIGHT_FACTOR = 0.6;

const CITY_COLOR_NAMES = {
  ground: "Green",
  track: "Dark_Bluish_Grey",
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

function cityParts(bundle: PartBundle, colors: ColorTable): CityParts {
  const grounds: PartFootprint[] = [];
  const roofs: PartFootprint[] = [];
  const walls: PartFootprint[] = [];
  const detailParts: PartFootprint[] = [];
  const roads: RoadModule[] = [];
  let rail: RailModule | undefined;
  bundle.parts.forEach((part, index) => {
    const pitchStuds = part.role === "track" ? straightRunPitchStuds(part) : undefined;
    if (pitchStuds !== undefined && !rail) {
      rail = {
        track: index,
        color: colors.indexOfName(CITY_COLOR_NAMES.track),
        pitchStuds,
        yPlates: plateDepthBelowOrigin(part),
      };
    }
    if (part.role === "road") {
      if (part.producedColor === undefined)
        throw new Error(`${part.id}: road plate has no sourced produced colour`);
      roads.push({ part: index, color: colors.indexOfCode(part.producedColor) });
    } else if (part.role === "ground") {
      grounds.push(footprintOf(part, index));
    } else if (part.role === "roof") {
      roofs.push(footprintOf(part, index));
    } else if (part.role === "wall") {
      walls.push(footprintOf(part, index));
    } else if (part.role === "detail") {
      detailParts.push(footprintOf(part, index));
    }
  });
  const ground = grounds.find((f) => f.widthStuds === CHUNK_STUDS && f.depthStuds === CHUNK_STUDS);
  const roofPlates = roofs.filter((f) => f.depthStuds === 2).toSorted(byWidthDescending);
  walls.sort(byWidthDescending);
  const thinWall = walls.filter((f) => f.depthStuds === 1);
  const thickWall = walls.filter((f) => f.depthStuds === 2);
  const details = detailParts.filter((f) => f.widthStuds === 1 && f.depthStuds === 1);
  const railRun: RailModule | undefined = rail;
  if (!railRun)
    throw new Error("bundle has no straight track with certified end poses for rail runs");
  if (
    !ground ||
    roads.length === 0 ||
    roofPlates.length === 0 ||
    thinWall.length === 0 ||
    thickWall.length === 0 ||
    details.length === 0
  ) {
    throw new Error("bundle lacks the part roles the city needs");
  }
  return { ground, roads, rail: railRun, roofPlates, thinWall, thickWall, details };
}

function cityColors(colors: ColorTable): CityColors {
  return {
    ground: colors.indexOfName(CITY_COLOR_NAMES.ground),
    roof: colors.indexOfName(CITY_COLOR_NAMES.roof),
    walls: CITY_COLOR_NAMES.walls.map((name) => colors.indexOfName(name)),
    details: CITY_COLOR_NAMES.details.map((name) => colors.indexOfName(name)),
  };
}

@injectable()
export class CityScene implements ICityScene {
  private request: CityRequest = {
    targetParts: 20_000,
    seed: 1,
    camera: "aerial",
    originChunkX: 0,
    originChunkZ: 0,
  };
  private world = new World();
  private minX = 0;
  private minZ = 0;
  private extent = CHUNK_LDU;
  private streetX = CHUNK_LDU / 2;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
  ) {}

  configure(request: CityRequest): void {
    this.request = request;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const [bundle, far] = await Promise.all([
      this.loader.load(lod, PALETTE_PARTS),
      this.loader.load("far", PALETTE_PARTS),
    ]);
    const colors = new ColorTable(bundle);
    const parts = cityParts(bundle, colors);
    const layout = generateCity(
      {
        targetParts: this.request.targetParts,
        partsPerModule: PARTS_PER_BUILDING_MODULE,
        seed: this.request.seed,
        originChunkX: this.request.originChunkX,
        originChunkZ: this.request.originChunkZ,
      },
      parts,
      cityColors(colors),
    );
    this.world = layout.world;
    const chunks = layout.world.chunks().map((chunk) => ({
      key: chunk.key,
      instances: withStuds(chunkInstances(chunk), bundle.parts, colors, COVERING_ROLES),
    }));
    this.minX = layout.firstChunkX * CHUNK_LDU;
    this.minZ = layout.firstChunkZ * CHUNK_LDU;
    this.extent = layout.side * CHUNK_LDU;
    const middleRoad =
      layout.roadColumns[Math.floor(layout.roadColumns.length / 2)] ?? layout.firstChunkX;
    this.streetX = middleRoad * CHUNK_LDU + CHUNK_LDU / 2;
    return showChunks(this.backend, bundle, far, colors, chunks, null);
  }

  placementDump(): PlacementDump {
    return dumpPlacements(this.world);
  }

  setCamera(t: number): void {
    const centreX = this.minX + this.extent / 2;
    const centreZ = this.minZ + this.extent / 2;
    if (this.request.camera === "aerial") {
      const angle = t * 2 * Math.PI;
      const radius = this.extent * AERIAL_RADIUS_FACTOR;
      this.backend.setView(
        centreX + radius * Math.cos(angle),
        this.extent * AERIAL_HEIGHT_FACTOR,
        centreZ + radius * Math.sin(angle),
        centreX,
        0,
        centreZ,
      );
      return;
    }
    const drivableLength = Math.max(this.extent - STREET_LOOK_AHEAD_LDU, 0);
    const z = this.minZ + drivableLength * t;
    this.backend.setView(
      this.streetX,
      STREET_EYE_HEIGHT_LDU,
      z,
      this.streetX,
      STREET_EYE_HEIGHT_LDU * STREET_LOOK_DOWN_FACTOR,
      z + STREET_LOOK_AHEAD_LDU,
    );
  }
}
