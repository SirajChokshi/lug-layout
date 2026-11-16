import {
  PART_BUNDLE_LOADER,
  type BundleLod,
  type IPartBundleLoader,
  type PartBundle,
} from "@brr/catalog";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type FrameStats,
  type ISceneBackend,
  type SceneBackendConfig,
} from "@brr/render";
import { inject, injectable } from "inversify";
import { footprintOf, type PartFootprint } from "./part-footprint.ts";
import { CHUNK_LDU, CHUNK_STUDS, placementsToInstances } from "./placements.ts";
import {
  generateCity,
  type CityColors,
  type CityParts,
  type RoadModule,
} from "./procedural-city.ts";
import {
  ColorTable,
  partPalette,
  summarize,
  type IViewerScene,
  type SceneSummary,
} from "./viewer-scene.ts";

export type CityCamera = "aerial" | "street";

export interface CityRequest {
  readonly targetParts: number;
  readonly seed: number;
  readonly camera: CityCamera;
}

export interface ICityScene extends IViewerScene {
  configure(request: CityRequest): void;
}

const PARTS_PER_BUILDING_MODULE = 2_000;
const STREET_EYE_HEIGHT_LDU = 120;
const STREET_LOOK_AHEAD_LDU = 900;
const STREET_LOOK_DOWN_FACTOR = 0.5;
const AERIAL_RADIUS_FACTOR = 0.85;
const AERIAL_HEIGHT_FACTOR = 0.6;

const CITY_COLOR_NAMES = {
  ground: "Green",
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
  bundle.parts.forEach((part, index) => {
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
  return { ground, roads, roofPlates, thinWall, thickWall, details };
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
  private request: CityRequest = { targetParts: 20_000, seed: 1, camera: "aerial" };
  private minX = 0;
  private extent = CHUNK_LDU;
  private streetX = CHUNK_LDU / 2;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
  ) {}

  configure(request: CityRequest): void {
    this.request = request;
  }

  attach(config: SceneBackendConfig): Promise<BackendInfo> {
    return this.backend.init(config);
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const bundle = await this.loader.load(lod);
    const colors = new ColorTable(bundle);
    const parts = cityParts(bundle, colors);
    const layout = generateCity(
      {
        targetParts: this.request.targetParts,
        partsPerModule: PARTS_PER_BUILDING_MODULE,
        seed: this.request.seed,
      },
      parts,
      cityColors(colors),
    );
    this.backend.setPalette(partPalette(bundle, colors));
    for (const chunk of layout.chunks)
      this.backend.setChunk(chunk.key, placementsToInstances(chunk));
    this.minX = layout.firstChunk * CHUNK_LDU;
    this.extent = layout.side * CHUNK_LDU;
    const middleRoad =
      layout.roadColumns[Math.floor(layout.roadColumns.length / 2)] ?? layout.firstChunk;
    this.streetX = middleRoad * CHUNK_LDU + CHUNK_LDU / 2;
    return summarize(bundle, layout.chunks, []);
  }

  setCamera(t: number): void {
    const centre = this.minX + this.extent / 2;
    if (this.request.camera === "aerial") {
      const angle = t * 2 * Math.PI;
      const radius = this.extent * AERIAL_RADIUS_FACTOR;
      this.backend.setView(
        centre + radius * Math.cos(angle),
        this.extent * AERIAL_HEIGHT_FACTOR,
        centre + radius * Math.sin(angle),
        centre,
        0,
        centre,
      );
      return;
    }
    const z = this.minX + this.extent * t;
    this.backend.setView(
      this.streetX,
      STREET_EYE_HEIGHT_LDU,
      z,
      this.streetX,
      STREET_EYE_HEIGHT_LDU * STREET_LOOK_DOWN_FACTOR,
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
