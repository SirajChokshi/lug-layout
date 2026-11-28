import {
  TrackClearance,
  WORLD_TRACK_FRAME,
  type PlacementHandle,
  type PlanDelta,
  type PlateHeights,
  type PlacedOutline,
  type RoadPlacement,
  type TrackChange,
} from "@brr/domain";
import { PLATE_LDU } from "@brr/math";
import {
  PLAN_SCENE_BACKEND,
  SCENE_BACKEND,
  type IPlanSceneBackend,
  type ISceneBackend,
} from "@brr/render";
import type { BundleIndex, TrackCatalog } from "@brr/schema/bundle";
import type { Issue } from "@brr/schema/decode";
import type { TrackRecordV1 } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import type { IConnectorTables } from "../connect/connector-tables.ts";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import {
  heldPieces,
  heldRuns,
  latticeFrame,
  modelTrackEnds,
  type FramedTrackPiece,
  type ModelTrackEnds,
} from "../connect/model-track-ends.ts";
import type { PlanTrackSource } from "../plan/plan-producer.ts";
import { CONNECTOR_TABLES, PLACEABLE_CATALOG, RAIL_YARD } from "../tokens.ts";
import type { RailCarrier } from "../trains/rail-track.ts";
import type { IRailYard } from "../trains/rail-yard.ts";
import { CrossingRamps, type SuggestedCrossing } from "./crossing-ramps.ts";
import type { Placeable } from "./placeable.ts";
import type { PlanReach } from "./plan-reach.ts";
import type {
  CarriedTrackParts,
  PlacedModels,
  PlacedModel,
  RebuildReport,
} from "./placed-chunks.ts";
import {
  TrackDrawing,
  type LowClearance,
  type PlacedTrackPiece,
  type PlayTrack,
  type TrackBlockView,
  type TrackCarrier,
  type TrackEndView,
  type TrackRouteView,
  type UnsupportedPiece,
} from "./track-drawing.ts";
import { ModelBands } from "./model-bands.ts";
import { planPartLines } from "./plan-part-lines.ts";
import type { SupportBand } from "./track-bands.ts";
import { OBSTACLE_RECT_FLOATS, solidRectsIn, withStanding } from "./track-obstacles.ts";
import { TrackSupport, antiStudsOf } from "./track-support.ts";

export interface TrackUnsupportedView {
  readonly pieces: number;
  readonly block: TrackBlockView | null;
  readonly tilted: number;
}

export interface TrackLowClearanceView {
  readonly pieces: number;
  readonly needPlates: number;
  readonly hasPlates: number;
  readonly train: string;
}

export interface LowClearanceRows {
  readonly laid: ReadonlyMap<number, PlateHeights>;
  readonly carriers: ReadonlyMap<number, PlateHeights>;
}

export interface ModelTrackCounts {
  readonly pieces: number;
  readonly runFrame: number;
  readonly offField: number;
  readonly unanchored: number;
}

export interface CrossingRampView {
  readonly part: string;
  readonly title: string;
  readonly count: number;
}

export interface CrossingView {
  readonly tracks: number;
  readonly roadwayCells: number;
  readonly ramps: ReadonlyArray<CrossingRampView>;
}

export interface PlayRails {
  readonly track: PlayTrack | null;
  readonly carriers: ReadonlyArray<RailCarrier>;
}

export interface UnsupportedTrack {
  readonly laid: ReadonlySet<number>;
  readonly carriers: ReadonlySet<number>;
}

export type TrackBundle = Pick<BundleIndex, "trackCatalog" | "trackShapes" | "levelCrossing">;

interface CrossingInputs {
  readonly ramps: CrossingRamps;
  readonly roads: ReadonlyArray<RoadPlacement>;
  readonly pieces: ReadonlyArray<PlacedTrackPiece>;
}

export interface ITrackWorld extends PlanTrackSource {
  start(bundle: TrackBundle, placed: PlacedModels): void;
  setRoads(roads: ReadonlyArray<RoadPlacement>): void;
  loadSupport(): Promise<void> | null;
  support(): TrackSupport | null;
  drawing(): TrackDrawing | null;
  pieceCatalog(): TrackCatalog["pieces"];
  requestPieceMeshes(): void;
  apply(change: TrackChange): RebuildReport;
  syncModelTrack(): boolean;
  modelTrack(placeable: Placeable): ModelTrackEnds | null;
  carriedParts(placeable: Placeable): ReadonlySet<number>;
  carriedTrackAt(placeable: Placeable, handle: PlacementHandle): CarriedTrackParts | null;
  carriedModels(): ReadonlyArray<PlacedModel>;
  carriedRange(model: PlacedModel): readonly [number, number] | null;
  carrierOf(piece: number): PlacedModel | null;
  modelCounts(): ModelTrackCounts;
  playRails(): PlayRails;
  invalidateObstacles(): void;
  setObstacles(): void;
  ensureObstacles(): void;
  measureSupport(): void;
  unsupported(): UnsupportedTrack;
  unsupportedCount(): number | null;
  unsupportedSince(firstPiece: number): TrackUnsupportedView | null;
  measureClearance(): LowClearanceRows | null;
  lowClearanceCount(): number | null;
  lowClearanceSince(firstPiece: number): TrackLowClearanceView | null;
  refreshCrossings(): void;
  crossings(): ReadonlyArray<SuggestedCrossing>;
  crossingViews(): ReadonlyArray<CrossingView>;
  crossingOutlines(): ReadonlyArray<PlacedOutline>;
  restore(records: ReadonlyArray<TrackRecordV1>): ReadonlyArray<Issue>;
  adoptRestored(): void;
  records(): TrackRecordV1[];
  routes(): ReadonlyArray<TrackRouteView>;
  openEnds(): ReadonlyArray<TrackEndView>;
}

export const NOTHING_REBUILT: RebuildReport = { chunks: 0, instances: 0, studs: 0 };
const NO_TRACK_PARTS: ReadonlySet<number> = new Set();
const NO_IDS: ReadonlySet<number> = new Set();
const TRACK_SUPPORT_TABLES = "track-drawing-kit";
const NO_PLACED_MODELS: PlacedModels = { models: () => [], version: 0 };

@injectable()
export class TrackWorld implements ITrackWorld {
  private bundle: TrackBundle | null = null;
  private trackCatalog: TrackCatalog | null = null;
  private placed: PlacedModels = NO_PLACED_MODELS;
  private roads: ReadonlyArray<RoadPlacement> = [];
  private track: TrackDrawing | null = null;
  private pendingRestored: TrackDrawing | null = null;
  private readonly modelTracks = new Map<string, ModelTrackEnds>();
  private readonly carriedPartSets = new WeakMap<ModelTrackEnds, ReadonlySet<number>>();
  private readonly exactTrackParts = new Map<string, ReadonlySet<number>>();
  private heldTrackModels: ReadonlyArray<PlacedModel> = [];
  private readonly heldRanges = new Map<PlacedModel, readonly [number, number]>();
  private layoutVersion = 0;
  private obstaclesVersion = -1;
  private trackSupport: TrackSupport | null = null;
  private supportLoading = false;
  private unsupportedTrack: ReadonlyArray<UnsupportedPiece> | null = null;
  private unsupportedLaid: ReadonlySet<number> = NO_IDS;
  private unsupportedCarriers: ReadonlySet<number> = NO_IDS;
  private lowTrack: ReadonlyArray<LowClearance> | null = null;
  private crossingRamps: CrossingRamps | null = null;
  private suggested: ReadonlyArray<SuggestedCrossing> = [];
  private suggestedViews: ReadonlyArray<CrossingView> | null = null;
  private crossingInputs: CrossingInputs | null = null;
  private rampChunks: ReadonlyArray<number> = [];
  private countedModels: PlacedModels | null = null;
  private countedVersion = -1;
  private counts: ModelTrackCounts | null = null;
  private readonly modelBands = new ModelBands((model) => this.carriedParts(model.placeable));

  constructor(
    @inject(SCENE_BACKEND)
    private readonly backend: Pick<ISceneBackend, "setChunk" | "deleteChunk">,
    @inject(PLACEABLE_CATALOG)
    private readonly catalog: Pick<IPlaceableCatalog, "parts" | "colors" | "requestMeshes">,
    @inject(CONNECTOR_TABLES) private readonly connectorTables: Pick<IConnectorTables, "load">,
    @inject(RAIL_YARD) private readonly railYard: Pick<IRailYard, "standingFootprints">,
    @inject(PLAN_SCENE_BACKEND) private readonly plan: Pick<IPlanSceneBackend, "setPartLines">,
  ) {}

  start(bundle: TrackBundle, placed: PlacedModels): void {
    this.modelBands.clear();
    this.bundle = bundle;
    this.trackCatalog = bundle.trackCatalog;
    this.placed = placed;
    this.track = this.newDrawing(bundle);
    this.catalog.parts().forEach((part, index) => {
      const lines = planPartLines(part, bundle.trackCatalog.pieces);
      if (lines) this.plan.setPartLines(index, lines);
    });
    this.crossingRamps = new CrossingRamps(
      bundle.levelCrossing,
      this.catalog.parts(),
      this.catalog.colors(),
    );
  }

  setRoads(roads: ReadonlyArray<RoadPlacement>): void {
    this.roads = roads;
  }

  loadSupport(): Promise<void> | null {
    const track = this.track;
    if (!track || this.supportLoading) return null;
    this.supportLoading = true;
    const kit = track.supportParts();
    const tables: Pick<Placeable, "id" | "partTransforms"> = {
      id: TRACK_SUPPORT_TABLES,
      partTransforms: {
        count: kit.length,
        partIndex: kit.map((part) => part.partIndex),
        matrices: new Float64Array(0),
      },
    };
    return this.connectorTables.load(tables).then(
      (loaded) => {
        const parts = this.catalog.parts();
        const antiStuds = new Map<number, Int32Array>();
        for (const { catalogIndex, partIndex } of kit) {
          const table = loaded.tables[partIndex];
          const part = parts[partIndex];
          if (table && part) antiStuds.set(catalogIndex, antiStudsOf(table, part.boundsMin[1]));
        }
        this.supportLoading = false;
        this.trackSupport = new TrackSupport(antiStuds);
        this.track?.setSupport(this.trackSupport);
      },
      (error: unknown) => {
        this.supportLoading = false;
        throw error;
      },
    );
  }

  support(): TrackSupport | null {
    return this.trackSupport;
  }

  drawing(): TrackDrawing | null {
    return this.track;
  }

  pieceCatalog(): TrackCatalog["pieces"] {
    return this.trackCatalog?.pieces ?? [];
  }

  requestPieceMeshes(): void {
    const track = this.track;
    if (track) this.catalog.requestMeshes(track.pieceParts().map((kit) => kit.partIndex));
  }

  apply(change: TrackChange): RebuildReport {
    const track = this.track;
    if (!track || change.lift.length + change.lay.length === 0) return NOTHING_REBUILT;
    let instances = 0;
    let studs = 0;
    const chunks = track.applyTrack(change);
    for (const key of chunks) {
      const chunk = track.chunkInstances(key);
      if (!chunk) {
        this.backend.deleteChunk(key);
        continue;
      }
      this.backend.setChunk(key, chunk);
      instances += chunk.count;
      studs += chunk.studs.count;
    }
    return { chunks: chunks.length, instances, studs };
  }

  syncModelTrack(): boolean {
    const drawing = this.track;
    if (!drawing) return false;
    const carrying = this.placed.models().filter((model) => {
      const track = this.modelTrack(model.placeable);
      if (!track) return false;
      const { pieces, runs, unverified, unidentified } = track;
      return pieces.length + runs.length + unverified.length + unidentified.length > 0;
    });
    const unchanged =
      carrying.length === this.heldTrackModels.length &&
      carrying.every((model, i) => model === this.heldTrackModels[i]);
    if (unchanged) return false;
    this.heldTrackModels = carrying;
    this.heldRanges.clear();
    const held: FramedTrackPiece[] = [];
    const carriers: TrackCarrier[] = [];
    let nextRunFrame = WORLD_TRACK_FRAME.id + 1;
    for (const model of carrying) {
      const track = this.modelTrack(model.placeable);
      if (!track) continue;
      const { x, z, yPlates, rot } = model.handle;
      const frame = latticeFrame(x, z, rot);
      const first = held.length;
      if (frame) {
        held.push(
          ...heldPieces(track, frame, yPlates),
          ...heldRuns(track, frame, yPlates, nextRunFrame),
        );
        nextRunFrame += track.runs.length;
      }
      if (held.length > first) this.heldRanges.set(model, [first, held.length]);
      carriers.push({
        model,
        held: held.length - first,
        unverified: track.unverified,
        unidentified: track.unidentified,
      });
    }
    drawing.syncHeld(held, carriers);
    return true;
  }

  modelTrack(placeable: Placeable): ModelTrackEnds | null {
    const catalog = this.trackCatalog;
    if (!catalog) return null;
    let track = this.modelTracks.get(placeable.id);
    if (!track) {
      track = modelTrackEnds(placeable.partTransforms, this.catalog.parts(), catalog);
      this.modelTracks.set(placeable.id, track);
    }
    return track;
  }

  carriedParts(placeable: Placeable): ReadonlySet<number> {
    const track = this.modelTrack(placeable);
    if (!track || (track.pieces.length === 0 && track.runs.length === 0)) return NO_TRACK_PARTS;
    const known = this.carriedPartSets.get(track);
    if (known) return known;
    const pieces = [...track.pieces, ...track.runs.flatMap((run) => run.pieces)];
    const parts = new Set(pieces.map((piece) => piece.instance));
    this.carriedPartSets.set(track, parts);
    return parts;
  }

  carriedTrackAt(placeable: Placeable, handle: PlacementHandle): CarriedTrackParts | null {
    const drawing = this.track;
    const carried = this.modelTrack(placeable);
    const frame = latticeFrame(handle.x, handle.z, handle.rot);
    if (!drawing || !carried || !frame || carried.pieces.length === 0) return null;
    let instances = this.exactTrackParts.get(placeable.id);
    if (!instances) {
      instances = new Set(carried.pieces.map((piece) => piece.instance));
      this.exactTrackParts.set(placeable.id, instances);
    }
    return {
      instances,
      outlines: heldPieces(carried, frame, 0).map((piece) =>
        drawing.outlineAt(piece.catalogIndex, piece.placement),
      ),
    };
  }

  carriedModels(): ReadonlyArray<PlacedModel> {
    return this.heldTrackModels;
  }

  carriedRange(model: PlacedModel): readonly [number, number] | null {
    return this.heldRanges.get(model) ?? null;
  }

  carrierOf(placement: number): PlacedModel | null {
    const laid = this.track?.pieceCount ?? 0;
    for (const [model, [first, last]] of this.heldRanges) {
      if (placement >= laid + first && placement < laid + last) return model;
    }
    return null;
  }

  modelCounts(): ModelTrackCounts {
    const cached = this.counts;
    if (
      cached &&
      this.countedModels === this.placed &&
      this.countedVersion === this.placed.version
    ) {
      return cached;
    }
    const counts = this.countModelTrack();
    this.counts = counts;
    this.countedModels = this.placed;
    this.countedVersion = this.placed.version;
    return counts;
  }

  private countModelTrack(): ModelTrackCounts {
    let pieces = 0;
    let runFrame = 0;
    let offField = 0;
    let unanchored = 0;
    for (const model of this.placed.models()) {
      const track = this.modelTrack(model.placeable);
      pieces += track?.pieces.length ?? 0;
      for (const run of track?.runs ?? []) runFrame += run.pieces.length;
      for (const piece of track?.uncertified ?? []) {
        if (piece.reason === "noAnchor") unanchored++;
        else offField++;
      }
    }
    return { pieces, runFrame, offField, unanchored };
  }

  playRails(): PlayRails {
    const track = this.track;
    const laid = track?.pieceCount ?? 0;
    const carriers = this.heldTrackModels.flatMap((model) => {
      const range = this.heldRanges.get(model);
      if (!range) return [];
      const { refId, colorId, x, z, yPlates, rot } = model.handle;
      const pose = { refId, colorId, x, z, yPlates, rot };
      return [{ pose, first: laid + range[0], count: range[1] - range[0] }];
    });
    return { track: track?.playTrack() ?? null, carriers };
  }

  invalidateObstacles(): void {
    this.layoutVersion++;
  }

  setObstacles(): void {
    const drawing = this.track;
    if (!drawing) return;
    drawing.setBands((low, high, reach) => this.supportBand(drawing, low, high, reach));
    this.obstaclesVersion = this.layoutVersion;
  }

  ensureObstacles(): void {
    if (this.obstaclesVersion !== this.layoutVersion) this.setObstacles();
  }

  measureSupport(): void {
    const track = this.track;
    if (!track) return;
    if (track.pieceCount + this.heldTrackModels.length > 0) this.ensureObstacles();
    const unsupported = track.unsupportedPieces();
    this.unsupportedTrack = unsupported;
    if (!unsupported) {
      this.unsupportedLaid = NO_IDS;
      this.unsupportedCarriers = NO_IDS;
      return;
    }
    const laid = new Set<number>();
    const carriers = new Set<number>();
    for (const { piece } of unsupported) {
      if (piece < track.pieceCount) laid.add(piece);
      else {
        const carrier = this.carrierOf(piece);
        if (carrier) carriers.add(carrier.id);
      }
    }
    this.unsupportedLaid = laid;
    this.unsupportedCarriers = carriers;
  }

  unsupported(): UnsupportedTrack {
    return { laid: this.unsupportedLaid, carriers: this.unsupportedCarriers };
  }

  unsupportedCount(): number | null {
    return this.unsupportedTrack?.length ?? null;
  }

  unsupportedSince(firstPiece: number): TrackUnsupportedView | null {
    const pieceCount = this.track?.pieceCount ?? 0;
    const laid = (this.unsupportedTrack ?? []).filter(
      ({ piece }) => piece >= firstPiece && piece < pieceCount,
    );
    const flat = laid.find((piece) => !piece.tilted);
    const tilted = laid.filter((piece) => piece.tilted).length;
    return laid.length > 0 ? { pieces: laid.length, block: flat?.block ?? null, tilted } : null;
  }

  measureClearance(): LowClearanceRows | null {
    const track = this.track;
    if (!track) return null;
    const low = track.lowClearances();
    this.lowTrack = low;
    if (!low) return null;
    const laid = new Map<number, PlateHeights>();
    const carriers = new Map<number, PlateHeights>();
    for (const { piece, needPlates, hasPlates } of low) {
      const heights = { needPlates, hasPlates };
      if (piece < track.pieceCount) {
        laid.set(piece, heights);
        continue;
      }
      const carrier = this.carrierOf(piece);
      const known = carrier ? carriers.get(carrier.id) : undefined;
      if (carrier && (!known || known.needPlates < needPlates)) carriers.set(carrier.id, heights);
    }
    return { laid, carriers };
  }

  lowClearanceCount(): number | null {
    return this.lowTrack?.length ?? null;
  }

  lowClearanceSince(firstPiece: number): TrackLowClearanceView | null {
    const pieceCount = this.track?.pieceCount ?? 0;
    const laid = (this.lowTrack ?? []).filter(
      ({ piece }) => piece >= firstPiece && piece < pieceCount,
    );
    const worst = laid.reduce<LowClearance | null>(
      (most, low) => (most === null || low.needPlates > most.needPlates ? low : most),
      null,
    );
    if (!worst) return null;
    const { needPlates, hasPlates, train } = worst;
    return { pieces: laid.length, needPlates, hasPlates, train: train.model };
  }

  refreshCrossings(): void {
    const track = this.track;
    const ramps = this.crossingRamps;
    if (!track || !ramps) return;
    const pieces = track.crossingPieces();
    const roads = this.roads;
    const inputs = this.crossingInputs;
    if (
      this.suggested.length === 0 &&
      inputs?.ramps === ramps &&
      inputs.roads === roads &&
      inputs.pieces === pieces
    ) {
      return;
    }
    this.crossingInputs = { ramps, roads, pieces };
    const placed = this.placed;
    this.suggested = ramps.suggest(
      roads,
      pieces,
      placed,
      (band) => this.rampClearance(track, placed.models(), band),
      (model) => (this.modelTrack(model.placeable)?.runs.length ?? 0) > 0,
    );
    this.suggestedViews = null;
    const chunks = ramps.instances(this.suggested);
    for (const key of this.rampChunks) if (!chunks.has(key)) this.backend.deleteChunk(key);
    for (const [key, chunk] of chunks) {
      this.catalog.requestMeshes(new Set(chunk.partIndex));
      this.backend.setChunk(key, chunk);
    }
    this.rampChunks = [...chunks.keys()];
  }

  crossings(): ReadonlyArray<SuggestedCrossing> {
    return this.suggested;
  }

  crossingViews(): ReadonlyArray<CrossingView> {
    this.suggestedViews ??= this.viewCrossings();
    return this.suggestedViews;
  }

  private viewCrossings(): ReadonlyArray<CrossingView> {
    return this.suggested.map((crossing) => this.crossingView(crossing));
  }

  private crossingView({ crossing, ramps }: SuggestedCrossing): CrossingView {
    const parts = this.catalog.parts();
    const counts = new Map<string, number>();
    for (const ramp of ramps) counts.set(ramp.part, (counts.get(ramp.part) ?? 0) + 1);
    return {
      tracks: crossing.tracks.length,
      roadwayCells: crossing.roadwayCells,
      ramps: [...counts].map(([part, count]) => ({
        part: part.replace("ldraw:", ""),
        title: parts.find((asset) => asset.id === part)?.title ?? part,
        count,
      })),
    };
  }

  crossingOutlines(): ReadonlyArray<PlacedOutline> {
    return this.crossingRamps?.outlines(this.suggested) ?? [];
  }

  restore(records: ReadonlyArray<TrackRecordV1>): ReadonlyArray<Issue> {
    const bundle = this.bundle;
    const track = bundle ? this.newDrawing(bundle) : null;
    this.pendingRestored = track;
    const decoded = track?.restore(records);
    return decoded && !decoded.ok ? decoded.issues : [];
  }

  adoptRestored(): void {
    const track = this.pendingRestored;
    this.pendingRestored = null;
    this.modelBands.clear();
    for (const key of this.track?.chunkKeys() ?? []) this.backend.deleteChunk(key);
    this.track = track;
    if (track && this.trackSupport) track.setSupport(this.trackSupport);
    for (const key of track?.chunkKeys() ?? []) {
      const chunk = track?.chunkInstances(key);
      if (chunk) this.backend.setChunk(key, chunk);
    }
    this.heldTrackModels = [];
    this.unsupportedTrack = null;
    this.unsupportedLaid = NO_IDS;
    this.unsupportedCarriers = NO_IDS;
    this.lowTrack = null;
  }

  records(): TrackRecordV1[] {
    return this.track?.records() ?? [];
  }

  routes(): ReadonlyArray<TrackRouteView> {
    return this.track?.routes() ?? [];
  }

  openEnds(): ReadonlyArray<TrackEndView> {
    return this.track?.openEnds() ?? [];
  }

  get pieceCount(): number {
    return this.track?.pieceCount ?? 0;
  }

  writeFootprint(piece: number, delta: PlanDelta, kind: number): void {
    this.track?.writeFootprint(piece, delta, kind);
  }

  writeIssues(delta: PlanDelta): void {
    this.track?.writeIssues(delta);
  }

  private newDrawing(bundle: TrackBundle): TrackDrawing {
    return new TrackDrawing(bundle, this.catalog.parts(), this.catalog.colors());
  }

  private supportBand(
    track: TrackDrawing,
    lowPlates: number,
    highPlates: number,
    reach: PlanReach | null,
  ): SupportBand {
    const [bottom, top] = track.verticalRange();
    const band = [bottom + lowPlates * PLATE_LDU, top + highPlates * PLATE_LDU] as const;
    const modelBand = this.modelBands.band(this.placed, this.trackCatalog, band, reach);
    return withStanding(modelBand, band, this.railYard.standingFootprints());
  }

  private rampClearance(
    track: TrackDrawing,
    models: ReadonlyArray<PlacedModel>,
    band: readonly [number, number],
  ): TrackClearance {
    const clearance = new TrackClearance();
    const rects = solidRectsIn(models, band, (model) => this.carriedParts(model.placeable));
    for (let r = 0; r < rects.length; r += OBSTACLE_RECT_FLOATS) {
      clearance.addRect(rects[r] ?? 0, rects[r + 1] ?? 0, rects[r + 2] ?? 0, rects[r + 3] ?? 0);
    }
    for (const outline of track.runFrameOutlines()) clearance.add(outline);
    return clearance;
  }
}
