import type { PlacementRequest } from "@brr/domain";
import { SCENE_BACKEND, type EdgeMarker, type ISceneBackend } from "@brr/render";
import type { BundleColor } from "@brr/schema/bundle";
import { inject, injectable } from "inversify";
import { colorOf, type IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import type { IConnectorTables } from "../connect/connector-tables.ts";
import { CONNECTOR_TABLES, PLACEABLE_CATALOG } from "../tokens.ts";
import type { PlacedModel } from "./placed-chunks.ts";
import {
  ROAD_KIT_PREFIX,
  RoadDrawing,
  type RoadKitView,
  type RoadPreview,
  type RoadStrokeView,
} from "./road-drawing.ts";

export interface RoadStrokeResult {
  readonly result: "laid" | "refused";
  readonly stroke: RoadStrokeView;
}

type RoadNeighbours = readonly [ReadonlyArray<PlacedModel>, ReadonlyArray<PlacedModel>];

export interface RoadEditView {
  readonly roadKits: ReadonlyArray<RoadKitView>;
  readonly roadKit: string | null;
  readonly roadStroke: RoadStrokeView | null;
  readonly lastRoadStroke: RoadStrokeResult | null;
  readonly roadErase: boolean;
}

export interface IRoadEditSession {
  start(colors: ReadonlyArray<BundleColor>): void;
  view(): RoadEditView;

  pick(id: string, preferredRot: number): boolean;
  drop(): void;
  hover(
    hitX: number,
    hitZ: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadEditView | null;
  beginStroke(
    hitX: number,
    hitZ: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): void;
  moveStroke(
    hitX: number,
    hitZ: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadEditView | null;
  extendStroke(hitX: number, hitZ: number): void;
  endStroke(
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): ReadonlyArray<PlacementRequest> | null;
  cancelStroke(): void;
  turn(rot: number, roads: ReadonlyArray<PlacedModel>, others: ReadonlyArray<PlacedModel>): void;
  setErase(
    erase: boolean,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): void;
  replanStroke(neighbours: () => RoadNeighbours): RoadEditView | null;
  setJoinMarkers(joins: ReadonlyArray<EdgeMarker>): void;
}

@injectable()
export class RoadEditSession implements IRoadEditSession {
  private drawing: RoadDrawing | null = null;
  private kits: ReadonlyArray<RoadKitView> = [];
  private kit: string | null = null;
  private stroke: RoadStrokeView | null = null;
  private lastStroke: RoadStrokeResult | null = null;
  private erase = false;
  private joinMarkers: ReadonlyArray<EdgeMarker> = [];
  private previewMarkers: ReadonlyArray<EdgeMarker> = [];

  constructor(
    @inject(SCENE_BACKEND)
    private readonly backend: Pick<ISceneBackend, "setGhost" | "placeGhost" | "setMarkers">,
    @inject(PLACEABLE_CATALOG)
    private readonly catalog: Pick<IPlaceableCatalog, "placeables" | "itemRefId" | "requestMeshes">,
    @inject(CONNECTOR_TABLES) private readonly connectorTables: Pick<IConnectorTables, "load">,
  ) {}

  start(colors: ReadonlyArray<BundleColor>): void {
    const drawing = new RoadDrawing(
      () => this.catalog.placeables(),
      (placeable) =>
        `${colorOf(colors, placeable.worldColor).name.replaceAll("_", " ")} road plates`,
    );
    this.drawing = drawing;
    this.kits = drawing.kitViews();
    this.kit = drawing.activeKit()?.id ?? null;
  }

  view(): RoadEditView {
    return {
      roadKits: this.kits,
      roadKit: this.kit,
      roadStroke: this.stroke,
      lastRoadStroke: this.lastStroke,
      roadErase: this.erase,
    };
  }

  pick(id: string, preferredRot: number): boolean {
    const drawing = this.drawing;
    if (!drawing || !id.startsWith(ROAD_KIT_PREFIX) || !drawing.choose(id)) return false;
    this.requestKitMeshes(id);
    this.loadKitTables(id);
    drawing.preferredRot = preferredRot;
    drawing.erasing = false;
    this.kit = id;
    this.erase = false;
    this.stroke = null;
    this.lastStroke = null;
    return true;
  }

  drop(): void {
    const drawing = this.drawing;
    drawing?.cancel();
    if (drawing) drawing.erasing = false;
    this.clearPreview();
    this.stroke = null;
    this.erase = false;
  }

  hover(
    hitX: number,
    hitZ: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadEditView | null {
    const drawing = this.drawing;
    if (!drawing) return null;
    return this.showPreview(drawing.hover(hitX, hitZ, roads, others));
  }

  beginStroke(
    hitX: number,
    hitZ: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): void {
    const drawing = this.drawing;
    if (drawing) this.showPreview(drawing.begin(hitX, hitZ, roads, others));
  }

  moveStroke(
    hitX: number,
    hitZ: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadEditView | null {
    const drawing = this.drawing;
    if (!drawing) return null;
    return this.showPreview(drawing.move(hitX, hitZ, roads, others));
  }

  extendStroke(hitX: number, hitZ: number): void {
    this.drawing?.extend(hitX, hitZ);
  }

  endStroke(
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): ReadonlyArray<PlacementRequest> | null {
    const drawing = this.drawing;
    if (!drawing) return null;
    const stroke = drawing.end(roads, others);
    this.clearPreview();
    if (!stroke) return null;
    if (stroke.requests.length === 0) {
      this.stroke = stroke.view;
      this.lastStroke =
        stroke.view.issues.length > 0 ? { result: "refused", stroke: stroke.view } : null;
      return stroke.requests;
    }
    this.stroke = null;
    this.lastStroke = { result: "laid", stroke: stroke.view };
    return stroke.requests;
  }

  cancelStroke(): void {
    this.drawing?.cancel();
    this.clearPreview();
  }

  turn(rot: number, roads: ReadonlyArray<PlacedModel>, others: ReadonlyArray<PlacedModel>): void {
    const drawing = this.drawing;
    if (!drawing) return;
    drawing.preferredRot = rot;
    this.showPreview(drawing.rerun(roads, others));
  }

  setErase(
    erase: boolean,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): void {
    const drawing = this.drawing;
    if (!drawing) return;
    drawing.erasing = erase;
    this.erase = erase;
    this.lastStroke = null;
    this.showPreview(drawing.rerun(roads, others));
  }

  replanStroke(neighbours: () => RoadNeighbours): RoadEditView | null {
    const drawing = this.drawing;
    if (!drawing) return null;
    drawing.worldChanged();
    return drawing.isDragging() ? this.showPreview(drawing.rerun(...neighbours())) : null;
  }

  setJoinMarkers(joins: ReadonlyArray<EdgeMarker>): void {
    this.joinMarkers = joins;
    this.sendMarkers();
  }

  private showPreview(preview: RoadPreview | null): RoadEditView | null {
    if (!preview) return null;
    this.backend.setGhost(preview.ghost);
    if (preview.ghost) this.backend.placeGhost(preview.ghost.originX, 0, preview.ghost.originZ, 0);
    this.previewMarkers = preview.markers;
    this.sendMarkers();
    this.stroke = preview.view;
    return this.view();
  }

  private clearPreview(): void {
    this.backend.setGhost(null);
    this.previewMarkers = [];
    this.sendMarkers();
  }

  private sendMarkers(): void {
    this.backend.setMarkers([...this.joinMarkers, ...this.previewMarkers]);
  }

  private loadKitTables(kitId: string): void {
    const kit = this.kits.find((view) => view.id === kitId);
    for (const piece of kit?.pieces ?? []) {
      const refId = this.catalog.itemRefId(piece.item);
      const placeable = refId === null ? null : this.catalog.placeables()[refId];
      if (placeable) this.connectorTables.load(placeable).catch(() => undefined);
    }
  }

  private requestKitMeshes(kitId: string): void {
    const kit = this.kits.find((view) => view.id === kitId);
    for (const piece of kit?.pieces ?? []) {
      const refId = this.catalog.itemRefId(piece.item);
      const placeable = refId === null ? null : this.catalog.placeables()[refId];
      if (placeable) this.catalog.requestMeshes(new Set(placeable.parts.partIndex));
    }
  }
}
