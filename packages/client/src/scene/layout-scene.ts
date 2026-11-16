import {
  PART_BUNDLE_LOADER,
  type IPartBundleLoader,
  type PartBundle,
  type PartFilter,
  type PartMesh,
} from "@brr/catalog";
import type { BundleLod } from "@brr/schema/bundle";
import { EditHistory, World } from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ChunkInstances,
  type ChunkTier,
  type EdgeMarker,
  type FarModelPlacement,
  type FrameStats,
  type ISceneBackend,
  type PartPalette,
  type PlanOverlay,
  type RebaseEvent,
  type SceneBackendConfig,
  type SuperChunkMesh,
  type TrackEndMarker,
  type WorldBox,
} from "@brr/render";
import { inject, injectable } from "inversify";
import { MergedParts } from "../edit/merged-parts.ts";
import { PlacedChunks } from "../edit/placed-chunks.ts";
import { modelPlaceable, partPlaceable, type Placeable } from "../edit/placeable.ts";
import { TrackDrawing } from "../edit/track-drawing.ts";
import { layoutClash } from "./layout-clashes.ts";
import type { CityCamera } from "./city-scene.ts";
import {
  ColorTable,
  ldrawColors,
  summarizeChunks,
  type IViewerScene,
  type KeyedChunk,
  type ModelCredit,
  type SceneSummary,
} from "./viewer-scene.ts";

export interface LayoutRequest {
  readonly camera: CityCamera;
  readonly tiles: number;
}

export interface ILayoutScene extends IViewerScene {
  configure(request: LayoutRequest): void;
}

interface LayoutModel {
  readonly name: string;
  readonly column: number;
  readonly row: number;
  readonly rot: number;
}

interface LayoutTile {
  readonly history: EditHistory;
  readonly placed: PlacedChunks;
  readonly x: number;
  readonly z: number;
}

interface DisplayRow {
  readonly models: ReadonlyArray<string>;
  readonly zStuds: number;
}

const MODULE_NAME = "mils-plain";
const BASEPLATE_ID = "ldraw:3811";
const BASEPLATE_COLOR_NAME = "Green";
const MODULES_PER_SIDE = 4;
const INNER_FIRST = 1;
const INNER_LAST = 2;
const BUILDINGS: ReadonlyArray<LayoutModel> = [
  { name: "10190-1", column: 1, row: 1, rot: 2 },
  { name: "10218-1", column: 2, row: 1, rot: 2 },
  { name: "10185-1", column: 1, row: 2, rot: 0 },
  { name: "10190-1", column: 2, row: 2, rot: 0 },
];
const DISPLAY_ROWS: ReadonlyArray<DisplayRow> = [
  { models: ["10133-1", "10022-1_Dining-Car", "10025-1_Baggage-Car"], zStuds: 10 },
  { models: ["10205-1", "10017-1", "10014-1"], zStuds: 118 },
];
const DISPLAY_START_STUDS = 4;
const TRACK_CORNERS_STUDS: ReadonlyArray<readonly [number, number]> = [
  [48, 24],
  [80, 24],
  [80, 104],
  [48, 104],
];
const AERIAL_RADIUS_FACTOR = 0.85;
const AERIAL_HEIGHT_FACTOR = 0.6;
const STREET_RADIUS_FACTOR = 0.45;
const STREET_EYE_LDU = 260;
const STREET_TARGET_LDU = 200;
const EDITOR_PARTS: PartFilter = (part) =>
  part.role === "ground" || part.role === "road" || part.role === "track";

class ChunkCapture implements ISceneBackend {
  readonly chunks = new Map<number, ChunkInstances>();

  constructor(private readonly inner: ISceneBackend) {}

  init(config: SceneBackendConfig): Promise<BackendInfo> {
    return this.inner.init(config);
  }
  setPalette(palette: PartPalette): void {
    this.inner.setPalette(palette);
  }
  setChunk(key: number, chunk: ChunkInstances): void {
    this.chunks.set(key, chunk);
    this.inner.setChunk(key, chunk);
  }
  deleteChunk(key: number): void {
    this.chunks.delete(key);
    this.inner.deleteChunk(key);
  }
  setSuperChunk(key: number, mesh: SuperChunkMesh): void {
    this.inner.setSuperChunk(key, mesh);
  }
  setSuperChunkVisible(key: number, visible: boolean): void {
    this.inner.setSuperChunkVisible(key, visible);
  }
  deleteSuperChunk(key: number): void {
    this.inner.deleteSuperChunk(key);
  }
  studPitchPx(distanceLdu: number): number {
    return this.inner.studPitchPx(distanceLdu);
  }
  forceTier(tier: ChunkTier | null): void {
    this.inner.forceTier(tier);
  }
  setFarModel(id: number, placement: FarModelPlacement | null): void {
    this.inner.setFarModel(id, placement);
  }
  setGhost(model: ChunkInstances | null): void {
    this.inner.setGhost(model);
  }
  placeGhost(x: number, yLdu: number, z: number, rot: number): void {
    this.inner.placeGhost(x, yLdu, z, rot);
  }
  setSelectionBox(box: WorldBox | null): void {
    this.inner.setSelectionBox(box);
  }
  setMarkers(markers: ReadonlyArray<EdgeMarker>): void {
    this.inner.setMarkers(markers);
  }
  setTrackEnds(markers: ReadonlyArray<TrackEndMarker>): void {
    this.inner.setTrackEnds(markers);
  }
  setPlanOverlays(overlays: ReadonlyArray<PlanOverlay>): void {
    this.inner.setPlanOverlays(overlays);
  }
  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void {
    this.inner.setIssueBoxes(boxes);
  }
  rayThrough(ndcX: number, ndcY: number, out: Float64Array): void {
    this.inner.rayThrough(ndcX, ndcY, out);
  }
  setVehicle(vehicle: number, model: ChunkInstances): void {
    this.inner.setVehicle(vehicle, model);
  }
  setVehiclePose(vehicle: number, x: number, y: number, z: number, yaw: number): void {
    this.inner.setVehiclePose(vehicle, x, y, z, yaw);
  }
  setView(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    atX: number,
    atY: number,
    atZ: number,
    orthoHalfHeightLdu?: number,
  ): void {
    this.inner.setView(eyeX, eyeY, eyeZ, atX, atY, atZ, orthoHalfHeightLdu);
  }
  resize(width: number, height: number): void {
    this.inner.resize(width, height);
  }
  renderFrame(out: FrameStats): void {
    this.inner.renderFrame(out);
  }
  waitForGpu(): Promise<void> {
    return this.inner.waitForGpu();
  }
  bufferMemory(): BufferMemory {
    return this.inner.bufferMemory();
  }
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return this.inner.rebaseLog();
  }
}

function placeableNamed(placeables: ReadonlyMap<string, Placeable>, name: string): Placeable {
  const placeable = placeables.get(name);
  if (!placeable) throw new Error(`the layout needs ${name}, which has no stud lattice`);
  return placeable;
}

function layoutModelNames(): ReadonlyArray<string> {
  return [
    ...new Set([
      MODULE_NAME,
      ...BUILDINGS.map((model) => model.name),
      ...DISPLAY_ROWS.flatMap((row) => row.models),
    ]),
  ];
}

function lengthAlongX(placeable: Placeable): number {
  return placeable.box.max[0] - placeable.box.min[0];
}

function snapToStud(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU;
}

function sharedDirectory(sources: ReadonlyArray<string>): string | null {
  const first = sources[0];
  if (first === undefined) return null;
  const directory = first.slice(0, first.lastIndexOf("/") + 1);
  if (directory === "") return null;
  return sources.every((source) => source.startsWith(directory)) ? directory : null;
}

function mergedCredit(placeables: Iterable<Placeable>): ModelCredit {
  const credits: ModelCredit[] = [];
  for (const placeable of placeables) if (placeable.credit) credits.push(placeable.credit);
  const sources = [...new Set(credits.map((credit) => credit.source))];
  return {
    name: credits.map((credit) => credit.name).join(" + "),
    source:
      sources.length === 1 ? (sources[0] ?? "") : (sharedDirectory(sources) ?? sources.join(" ")),
    sections: credits.flatMap((credit) => credit.sections),
  };
}

@injectable()
export class LayoutScene implements ILayoutScene {
  private request: LayoutRequest = { camera: "aerial", tiles: 1 };
  private extent = 0;
  private readonly capture: ChunkCapture;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
  ) {
    this.capture = new ChunkCapture(backend);
  }

  configure(request: LayoutRequest): void {
    this.request = request;
  }

  async load(lod: BundleLod): Promise<SceneSummary> {
    const [bundle, farBundle] = await Promise.all([
      this.loader.load(lod, EDITOR_PARTS),
      this.loader.load("far", EDITOR_PARTS),
    ]);
    const colors = new ColorTable(bundle);
    const palette = new MergedParts(bundle.parts);
    const farPalette = new MergedParts(farBundle.parts);
    const farModels: PartMesh[] = [];
    const placeables = await this.loadPlaceables(lod, palette, farPalette, farModels, colors);
    const baseplate = this.baseplate(bundle, palette, colors);
    const track = new TrackDrawing(bundle.trackCatalog, palette.parts, colors);
    this.capture.setPalette({
      detailed: { parts: palette.parts, studPrimitives: bundle.studPrimitives },
      far: { parts: farPalette.parts, studPrimitives: farBundle.studPrimitives },
      farModels,
      colorsSrgb: colors.toSrgb(),
      colorsAlpha: colors.toAlpha(),
      ldrawColors: ldrawColors(bundle),
    });
    this.extent = lengthAlongX(placeableNamed(placeables, MODULE_NAME)) * MODULES_PER_SIDE;
    const world = new World();
    const history = new EditHistory(world);
    const placed = new PlacedChunks(this.capture);
    const touched = new Set<number>();
    for (let tileZ = 0; tileZ < this.request.tiles; tileZ++) {
      for (let tileX = 0; tileX < this.request.tiles; tileX++) {
        const tile = { history, placed, x: tileX * this.extent, z: tileZ * this.extent };
        this.placeModels(placeables, baseplate, tile);
        this.layTrack(track, tile, touched);
      }
    }
    const trackChunks = new Map<number, ChunkInstances>();
    for (const key of touched) {
      const chunk = track.chunkInstances(key);
      if (chunk) trackChunks.set(key, chunk);
    }
    const clash = layoutClash(placed.models(), [...trackChunks.values()], palette.parts);
    if (clash) throw new Error(`the bench layout is not buildable: ${clash}`);
    for (const [key, chunk] of trackChunks) this.capture.setChunk(key, chunk);
    const chunks: KeyedChunk[] = [];
    for (const [key, instances] of this.capture.chunks) chunks.push({ key, instances });
    return summarizeChunks(
      {
        bundleVersion: bundle.bundleVersion,
        parts: palette.parts,
        studPrimitives: bundle.studPrimitives,
        creditedFiles: bundle.credits.length,
      },
      chunks,
      mergedCredit(placeables.values()),
    );
  }

  private baseplate(bundle: PartBundle, palette: MergedParts, colors: ColorTable): Placeable {
    const part = bundle.parts.find((p) => p.id === BASEPLATE_ID);
    const color = bundle.colors.find((c) => c.name === BASEPLATE_COLOR_NAME);
    if (!part || !color)
      throw new Error(`the bundle has no ${BASEPLATE_ID} or ${BASEPLATE_COLOR_NAME}`);
    if (!part.producedColors.includes(color.code)) {
      throw new Error(`${BASEPLATE_ID} was never produced in ${BASEPLATE_COLOR_NAME}`);
    }
    return partPlaceable(
      part,
      null,
      palette.indexOf(part.id),
      color.code,
      color.name,
      palette.parts,
      colors,
    );
  }

  private async loadPlaceables(
    lod: BundleLod,
    palette: MergedParts,
    farPalette: MergedParts,
    farModels: PartMesh[],
    colors: ColorTable,
  ): Promise<ReadonlyMap<string, Placeable>> {
    const loaded = await Promise.all(
      layoutModelNames().map((name) =>
        Promise.all([this.loader.loadModel(lod, name), this.loader.loadModel("far", name)]),
      ),
    );
    const placeables = new Map<string, Placeable>();
    for (const [{ bundle: modelBundle, entry, model }, far] of loaded) {
      if (model.lattice === null) continue;
      farPalette.remap(far.model, far.bundle.parts);
      let farModel: number | null = null;
      if (far.farMesh) {
        farModels.push(far.farMesh.mesh);
        farModel = farModels.length - 1;
      }
      const credit = { name: entry.name, source: entry.source, sections: model.sections };
      placeables.set(
        entry.name,
        modelPlaceable(
          entry.name,
          entry.name,
          entry.role,
          palette.remap(model, modelBundle.parts),
          credit,
          palette.parts,
          colors,
          farModel,
          null,
        ),
      );
    }
    return placeables;
  }

  private placeModels(
    placeables: ReadonlyMap<string, Placeable>,
    baseplate: Placeable,
    tile: LayoutTile,
  ): void {
    const refs = [...placeables.values(), baseplate];
    const { history, placed } = tile;
    const refOf = (refId: number): Placeable => {
      const placeable = refs[refId];
      if (!placeable) throw new Error(`layout ref ${refId} is out of range`);
      return placeable;
    };
    const place = (placeable: Placeable, x: number, z: number, yPlates: number, rot: number) => {
      const edit = history.place({
        refId: refs.indexOf(placeable),
        colorId: placeable.worldColor,
        x: tile.x + x,
        z: tile.z + z,
        yPlates,
        rot,
      });
      placed.apply(edit, refOf);
    };
    const module = placeableNamed(placeables, MODULE_NAME);
    const moduleLdu = lengthAlongX(module);
    const surfacePlates = module.box.max[1] / PLATE_LDU;
    if (!Number.isInteger(surfacePlates)) {
      throw new Error(`${MODULE_NAME}'s surface is not a whole plate above its baseplate`);
    }
    for (let row = 0; row < MODULES_PER_SIDE; row++) {
      for (let column = 0; column < MODULES_PER_SIDE; column++) {
        const inner =
          row >= INNER_FIRST && row <= INNER_LAST && column >= INNER_FIRST && column <= INNER_LAST;
        place(
          inner ? module : baseplate,
          (column + 0.5) * moduleLdu,
          (row + 0.5) * moduleLdu,
          0,
          0,
        );
      }
    }
    for (const building of BUILDINGS) {
      place(
        placeableNamed(placeables, building.name),
        (building.column + 0.5) * moduleLdu,
        (building.row + 0.5) * moduleLdu,
        surfacePlates,
        building.rot,
      );
    }
    for (const row of DISPLAY_ROWS) {
      let x = DISPLAY_START_STUDS * STUD_LDU;
      for (const name of row.models) {
        const model = placeableNamed(placeables, name);
        const length = lengthAlongX(model);
        place(model, snapToStud(x - model.box.min[0]), row.zStuds * STUD_LDU, 0, 0);
        x += length + STUD_LDU;
      }
    }
  }

  private layTrack(track: TrackDrawing, tile: LayoutTile, touched: Set<number>): void {
    for (let i = 0; i < TRACK_CORNERS_STUDS.length; i++) {
      const from = TRACK_CORNERS_STUDS[i];
      const to = TRACK_CORNERS_STUDS[(i + 1) % TRACK_CORNERS_STUDS.length];
      if (!from || !to) continue;
      const fx = tile.x + from[0] * STUD_LDU;
      const fz = tile.z + from[1] * STUD_LDU;
      track.beginDrag(fx, fz, fx, fz);
      track.moveDrag(tile.x + to[0] * STUD_LDU, tile.z + to[1] * STUD_LDU);
      for (const key of track.endDrag().chunks) touched.add(key);
    }
    if (track.openEnds().length > 0) {
      throw new Error(`the layout's track loop has ${track.openEnds().length} open ends`);
    }
  }

  setCamera(t: number): void {
    const side = this.extent * this.request.tiles;
    const centre = side / 2;
    const angle = t * 2 * Math.PI;
    if (this.request.camera === "aerial") {
      const radius = side * AERIAL_RADIUS_FACTOR;
      this.backend.setView(
        centre + radius * Math.cos(angle),
        side * AERIAL_HEIGHT_FACTOR,
        centre + radius * Math.sin(angle),
        centre,
        0,
        centre,
      );
      return;
    }
    const radius = this.extent * STREET_RADIUS_FACTOR;
    this.backend.setView(
      centre + radius * Math.cos(angle),
      STREET_EYE_LDU,
      centre + radius * Math.sin(angle),
      centre,
      STREET_TARGET_LDU,
      centre,
    );
  }
}
