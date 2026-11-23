import {
  RoadNetwork,
  extendRoadPath,
  planRoadErase,
  planRoadTiles,
  roadKits,
  roadShape,
  rotateArms,
  type ExistingRoadTile,
  type PlacementPose,
  type PlacementRef,
  type PlacementRequest,
  type PlannedRoadTile,
  type RoadKit,
  type RoadShape,
  type RoadTile,
} from "@brr/domain";
import { CHUNK_STUDS, PLATE_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import {
  INSTANCE_MATRIX_FLOATS,
  type ChunkInstances,
  type EdgeMarker,
  type MarkerKind,
  type WorldBox,
} from "@brr/render";
import type { Placeable } from "./placeable.ts";
import type { PlacedModel } from "./placed-chunks.ts";

const NEIGHBOUR_TILES = 1;

export interface RoadNeighbourhood {
  near(area: WorldBox, roadModels: PlacedModel[], otherModels: PlacedModel[]): void;
}

export type RoadTileProblem = "no-piece" | "other-family" | "mismatch" | "overlap";

export interface RoadKitView {
  readonly id: string;
  readonly label: string;
  readonly edge: string;
  readonly tileStuds: number;
  readonly shapes: ReadonlyArray<RoadShape>;
  readonly pieces: ReadonlyArray<{ readonly item: string; readonly shape: RoadShape }>;
}

export interface RoadTileIssue {
  readonly x: number;
  readonly z: number;
  readonly problem: RoadTileProblem;
  readonly shape: RoadShape | null;
  readonly blocker: string | null;
}

export interface RoadStrokeView {
  readonly kit: string;
  readonly erasing: boolean;
  readonly tiles: number;
  readonly laid: number;
  readonly replaced: number;
  readonly overGround: number;
  readonly removed: number;
  readonly refilled: number;
  readonly kept: number;
  readonly stranded: ReadonlyArray<RoadStrandedTile>;
  readonly issues: ReadonlyArray<RoadTileIssue>;
}

export interface RoadStrandedTile {
  readonly x: number;
  readonly z: number;
  readonly junction: RoadShape;
  readonly remaining: RoadShape | null;
}

export interface RoadPreview {
  readonly ghost: ChunkInstances | null;
  readonly markers: ReadonlyArray<EdgeMarker>;
  readonly view: RoadStrokeView;
}

interface TilePlacement {
  readonly tile: PlannedRoadTile;
  readonly choice: number;
  readonly pose: PlacementPose;
  readonly replaces: PlacedModel | null;
}

interface Evaluated {
  readonly placements: ReadonlyArray<TilePlacement>;
  readonly removals: ReadonlyArray<PlacedModel>;
  readonly issues: ReadonlyArray<RoadTileIssue>;
  readonly view: RoadStrokeView;
}

interface KitEntry {
  readonly kit: RoadKit;
  readonly view: RoadKitView;
}

interface ExistingTileAt {
  readonly model: PlacedModel;
  readonly tile: ExistingRoadTile;
}

export const ROAD_KIT_PREFIX = "road-kit:";
const MAX_CHOICE_ROUNDS = 4;
const OUTLINE_LDU = 6;
const OUTLINE_LIFT_LDU = 2;

function edgeText(kit: RoadKit): string {
  return kit.edgeRuns.map((run) => (run.road ? `${run.cells} road` : `${run.cells}`)).join(" + ");
}

function sidewalks(kit: RoadKit): string {
  const first = kit.edgeRuns[0];
  const last = kit.edgeRuns.at(-1);
  if (kit.edgeRuns.filter((run) => run.road).length > 1) return "dual carriageway";
  const outer = first && !first.road ? first.cells : 0;
  const inner = last && !last.road ? last.cells : 0;
  return outer === inner ? `${outer}-stud sidewalks` : `${outer}- and ${inner}-stud sidewalks`;
}

function kitTraits(kit: RoadKit): string {
  const studs = kit.tileLdu / STUD_LDU;
  return studs === CHUNK_STUDS ? sidewalks(kit) : `${studs}×${studs} tiles, ${sidewalks(kit)}`;
}

function shapeOf(arms: number): RoadShape | null {
  return arms === 0 ? null : roadShape(arms);
}

function touches(a: WorldBox, b: WorldBox): boolean {
  const alongZ = a.minZ < b.maxZ && a.maxZ > b.minZ;
  const alongX = a.minX < b.maxX && a.maxX > b.minX;
  return (
    (alongZ && (a.maxX === b.minX || a.minX === b.maxX)) ||
    (alongX && (a.maxZ === b.minZ || a.minZ === b.maxZ))
  );
}

function replacedBy(
  model: PlacedModel,
  removals: ReadonlyArray<PlacedModel>,
  placements: ReadonlyArray<TilePlacement>,
): boolean {
  for (let r = 0; r < removals.length; r++) if (removals[r] === model) return true;
  for (let p = 0; p < placements.length; p++) if (placements[p]?.replaces === model) return true;
  return false;
}

function nearArea(box: WorldBox, area: ReadonlyArray<WorldBox>, reach: number): boolean {
  for (let i = 0; i < area.length; i++) {
    const a = area[i];
    if (
      a &&
      box.minX < a.maxX + reach &&
      box.maxX > a.minX - reach &&
      box.minZ < a.maxZ + reach &&
      box.maxZ > a.minZ - reach
    ) {
      return true;
    }
  }
  return false;
}

function meetingModel(
  kept: ReadonlyArray<PlacedModel>,
  keptCount: number,
  others: ReadonlyArray<PlacedModel>,
  box: WorldBox,
  removals: ReadonlyArray<PlacedModel>,
  placements: ReadonlyArray<TilePlacement>,
): PlacedModel | undefined {
  for (let k = 0; k < keptCount; k++) {
    const model = kept[k];
    if (model?.meetsInPlan(box)) return model;
  }
  for (let o = 0; o < others.length; o++) {
    const other = others[o];
    if (other && !replacedBy(other, removals, placements) && other.meetsInPlan(box)) return other;
  }
  return undefined;
}

function sameModels(a: ReadonlyArray<PlacedModel>, b: ReadonlyArray<PlacedModel>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function copyModels(from: ReadonlyArray<PlacedModel>, into: PlacedModel[]): void {
  into.length = 0;
  for (let i = 0; i < from.length; i++) {
    const model = from[i];
    if (model) into.push(model);
  }
}

function touchingModel(
  kept: ReadonlyArray<PlacedModel>,
  count: number,
  box: WorldBox,
): PlacedModel | undefined {
  for (let k = 0; k < count; k++) {
    const other = kept[k];
    if (other && touches(other.box, box)) return other;
  }
  return undefined;
}

function outline(box: WorldBox, kind: MarkerKind): ReadonlyArray<EdgeMarker> {
  const minY = box.maxY + OUTLINE_LIFT_LDU;
  const maxY = minY + OUTLINE_LIFT_LDU;
  const { minX, maxX, minZ, maxZ } = box;
  return [
    { kind, box: { minX, maxX, minY, maxY, minZ, maxZ: minZ + OUTLINE_LDU } },
    { kind, box: { minX, maxX, minY, maxY, minZ: maxZ - OUTLINE_LDU, maxZ } },
    { kind, box: { minX, maxX: minX + OUTLINE_LDU, minY, maxY, minZ, maxZ } },
    { kind, box: { minX: maxX - OUTLINE_LDU, maxX, minY, maxY, minZ, maxZ } },
  ];
}

export class RoadDrawing {
  private readonly kits: ReadonlyArray<KitEntry>;
  private readonly kitOfRef = new Map<number, KitEntry>();
  private active = 0;
  private phaseX = 0;
  private phaseZ = 0;
  private path: ReadonlyArray<RoadTile> = [];
  private dragging = false;
  private evaluated: Evaluated | null = null;
  private readonly groundUnder = new Map<PlacementRef, PlacementPose>();
  private atIx = 0;
  private atIz = 0;
  private existing: Map<string, ExistingTileAt> | null = null;
  private readonly existingFrom: PlacedModel[] = [];
  private ground: Map<string, PlacedModel> | null = null;
  private readonly groundRoads: PlacedModel[] = [];
  private readonly groundOthers: PlacedModel[] = [];
  private readonly network = new RoadNetwork([]);
  private readonly kept: PlacedModel[] = [];
  private readonly nearRoads: PlacedModel[] = [];
  private readonly nearOthers: PlacedModel[] = [];
  private readonly cursorPoint = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  preferredRot = 0;
  erasing = false;

  constructor(
    private readonly placeablesByRef: () => ReadonlyArray<Placeable | null>,
    familyLabel: (placeable: Placeable) => string,
  ) {
    const kits = roadKits(
      placeablesByRef().flatMap((placeable, ref) =>
        placeable?.road && placeable.parts.count === 1
          ? [{ ref, family: String(placeable.worldColor), surface: placeable.road }]
          : [],
      ),
    );
    this.kits = kits
      .filter((kit) => kit.shapes.includes("straight"))
      .toSorted((a, b) => b.shapes.length - a.shapes.length)
      .map((kit, index) => {
        const first = this.placeable(kit.pieces[0]?.ref ?? -1);
        return {
          kit,
          view: {
            id: `${ROAD_KIT_PREFIX}${index}`,
            label: `${familyLabel(first)}, ${kitTraits(kit)}`,
            edge: edgeText(kit),
            tileStuds: kit.tileLdu / STUD_LDU,
            shapes: kit.shapes,
            pieces: kit.pieces.map((piece) => ({
              item: this.placeable(piece.ref).id,
              shape: piece.shape,
            })),
          },
        };
      });
    for (const entry of this.kits) {
      for (const piece of entry.kit.pieces) this.kitOfRef.set(piece.ref, entry);
    }
  }

  kitViews(): ReadonlyArray<RoadKitView> {
    return this.kits.map((entry) => entry.view);
  }

  activeKit(): RoadKitView | null {
    return this.kits[this.active]?.view ?? null;
  }

  choose(id: string): boolean {
    const index = this.kits.findIndex((entry) => entry.view.id === id);
    if (index < 0) return false;
    this.active = index;
    this.tilesChanged();
    this.cancel();
    return true;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  cancel(): void {
    this.dragging = false;
    this.path = [];
    this.evaluated = null;
  }

  hover(x: number, z: number, neighbours: RoadNeighbourhood): RoadPreview | null {
    if (this.dragging) return null;
    const { phaseX, phaseZ } = this;
    const previous = this.path[0];
    this.choosePhase(x, z, neighbours);
    this.locate(x, z);
    const unchanged =
      this.evaluated !== null &&
      this.path.length === 1 &&
      previous?.ix === this.atIx &&
      previous.iz === this.atIz &&
      phaseX === this.phaseX &&
      phaseZ === this.phaseZ;
    if (unchanged) return null;
    this.path = [{ ix: this.atIx, iz: this.atIz }];
    return this.evaluate(neighbours);
  }

  worldChanged(): void {
    this.evaluated = null;
    this.tilesChanged();
  }

  private tilesChanged(): void {
    this.existing = null;
    this.ground = null;
  }

  begin(x: number, z: number, neighbours: RoadNeighbourhood): RoadPreview | null {
    this.choosePhase(x, z, neighbours);
    this.dragging = true;
    this.path = [this.tileAt(x, z)];
    return this.evaluate(neighbours);
  }

  move(x: number, z: number, neighbours: RoadNeighbourhood): RoadPreview | null {
    if (!this.dragging) return null;
    const before = this.path;
    this.extend(x, z);
    if (this.path === before && this.evaluated) return null;
    return this.evaluate(neighbours);
  }

  extend(x: number, z: number): void {
    if (!this.dragging) return;
    const tile = this.inLane(this.tileAt(x, z), x, z);
    this.path = extendRoadPath(this.path, tile.ix, tile.iz);
  }

  private inLane(tile: RoadTile, x: number, z: number): RoadTile {
    const last = this.path.at(-1);
    const previous = this.path.at(-2);
    if (!last || !previous) return tile;
    const tileLdu = this.entry().kit.tileLdu;
    const [centreX, centreZ] = this.centre(last);
    if (last.iz === previous.iz && tile.iz !== last.iz && Math.abs(z - centreZ) < tileLdu) {
      return { ix: tile.ix, iz: last.iz };
    }
    if (last.ix === previous.ix && tile.ix !== last.ix && Math.abs(x - centreX) < tileLdu) {
      return { ix: last.ix, iz: tile.iz };
    }
    return tile;
  }

  rerun(neighbours: RoadNeighbourhood): RoadPreview | null {
    if (this.path.length === 0) return null;
    return this.evaluate(neighbours);
  }

  end(neighbours: RoadNeighbourhood): {
    readonly requests: ReadonlyArray<PlacementRequest>;
    readonly view: RoadStrokeView;
  } | null {
    if (!this.dragging || this.path.length === 0) {
      this.cancel();
      return null;
    }
    this.evaluate(neighbours);
    const evaluated = this.evaluated;
    this.cancel();
    if (!evaluated) return null;
    if (evaluated.issues.length > 0) return { requests: [], view: evaluated.view };
    for (const { tile, replaces } of evaluated.placements) {
      if (!replaces || tile.kind !== "lay" || tile.replaces) continue;
      const { refId, colorId, x, z, yPlates, rot } = replaces.handle;
      this.groundUnder.set(replaces.placement, { refId, colorId, x, z, yPlates, rot });
    }
    const requests: PlacementRequest[] = [
      ...evaluated.removals.map((model) => ({ placement: model.placement, to: null })),
      ...evaluated.placements.map(({ pose, replaces }) => ({
        placement: replaces?.placement ?? null,
        to: pose,
      })),
    ];
    return { requests, view: evaluated.view };
  }

  private placeable(ref: number): Placeable {
    const placeable = this.placeablesByRef()[ref];
    if (!placeable) throw new Error(`no catalog item has ref id ${ref}`);
    return placeable;
  }

  private entry(): KitEntry {
    const entry = this.kits[this.active];
    if (!entry) throw new Error("no road kit is available");
    return entry;
  }

  private compatible(model: PlacedModel): KitEntry | null {
    const entry = this.kitOfRef.get(model.handle.refId);
    if (!entry || model.handle.yPlates !== 0) return null;
    const kit = this.entry().kit;
    return entry.kit.tileLdu === kit.tileLdu && entry.kit.profile === kit.profile ? entry : null;
  }

  private isGround(model: PlacedModel): boolean {
    const { kit } = this.entry();
    const { box, placeable, handle } = model;
    const fitsTile = box.maxX - box.minX === kit.tileLdu && box.maxZ - box.minZ === kit.tileLdu;
    const centredOnLattice =
      ((box.minX + box.maxX) / 2) % STUD_LDU === 0 && ((box.minZ + box.maxZ) / 2) % STUD_LDU === 0;
    if (!fitsTile || !centredOnLattice || handle.yPlates !== 0) return false;
    return placeable.road === null && placeable.flatTopSixteenths === kit.edgeTopSixteenths;
  }

  private choosePhase(x: number, z: number, neighbours: RoadNeighbourhood): void {
    const tileLdu = this.entry().kit.tileLdu;
    const point = this.cursorPoint;
    point.minX = x;
    point.maxX = x;
    point.minZ = z;
    point.maxZ = z;
    const roads = this.nearRoads;
    const others = this.nearOthers;
    neighbours.near(point, roads, others);
    const under = this.tileUnder(x, z, roads) ?? this.tileUnder(x, z, others);
    const latticeCentre = Math.round(tileLdu / 2 / STUD_LDU) * STUD_LDU;
    const phaseX = under ? (under.box.minX + under.box.maxX) / 2 : latticeCentre;
    const phaseZ = under ? (under.box.minZ + under.box.maxZ) / 2 : latticeCentre;
    if (phaseX !== this.phaseX || phaseZ !== this.phaseZ) this.tilesChanged();
    this.phaseX = phaseX;
    this.phaseZ = phaseZ;
  }

  private tileUnder(
    x: number,
    z: number,
    models: ReadonlyArray<PlacedModel>,
  ): PlacedModel | undefined {
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      if (!model || !(this.compatible(model) || this.isGround(model))) continue;
      const { box } = model;
      if (x >= box.minX && x < box.maxX && z >= box.minZ && z < box.maxZ) return model;
    }
    return undefined;
  }

  private groundTiles(
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): Map<string, PlacedModel> {
    const cached = this.ground;
    if (cached && sameModels(roads, this.groundRoads) && sameModels(others, this.groundOthers)) {
      return cached;
    }
    const tiles = new Map<string, PlacedModel>();
    this.addGroundTiles(roads, tiles);
    this.addGroundTiles(others, tiles);
    this.ground = tiles;
    copyModels(roads, this.groundRoads);
    copyModels(others, this.groundOthers);
    return tiles;
  }

  private addGroundTiles(
    models: ReadonlyArray<PlacedModel>,
    tiles: Map<string, PlacedModel>,
  ): void {
    const tileLdu = this.entry().kit.tileLdu;
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      if (!model || !this.isGround(model)) continue;
      const dx = (model.box.minX + model.box.maxX) / 2 - this.phaseX;
      const dz = (model.box.minZ + model.box.maxZ) / 2 - this.phaseZ;
      if (dx % tileLdu !== 0 || dz % tileLdu !== 0) continue;
      tiles.set(`${dx / tileLdu},${dz / tileLdu}`, model);
    }
  }

  private locate(x: number, z: number): void {
    const tileLdu = this.entry().kit.tileLdu;
    this.atIx = Math.round((x - this.phaseX) / tileLdu);
    this.atIz = Math.round((z - this.phaseZ) / tileLdu);
  }

  private tileAt(x: number, z: number): RoadTile {
    this.locate(x, z);
    return { ix: this.atIx, iz: this.atIz };
  }

  private centre(tile: { readonly ix: number; readonly iz: number }): readonly [number, number] {
    const tileLdu = this.entry().kit.tileLdu;
    return [this.phaseX + tile.ix * tileLdu, this.phaseZ + tile.iz * tileLdu];
  }

  private tileBox(tile: { readonly ix: number; readonly iz: number }, top: number): WorldBox {
    const half = this.entry().kit.tileLdu / 2;
    const [x, z] = this.centre(tile);
    return { minX: x - half, maxX: x + half, minY: 0, maxY: top, minZ: z - half, maxZ: z + half };
  }

  private existingTiles(roads: ReadonlyArray<PlacedModel>): Map<string, ExistingTileAt> {
    const cached = this.existing;
    if (cached && sameModels(roads, this.existingFrom)) return cached;
    const tiles = this.findExistingTiles(roads);
    this.existing = tiles;
    copyModels(roads, this.existingFrom);
    return tiles;
  }

  private findExistingTiles(roads: ReadonlyArray<PlacedModel>): Map<string, ExistingTileAt> {
    const tileLdu = this.entry().kit.tileLdu;
    const family = this.entry().kit.family;
    const tiles = new Map<string, ExistingTileAt>();
    for (const model of roads) {
      const entry = this.compatible(model);
      if (!entry) continue;
      const dx = model.handle.x - this.phaseX;
      const dz = model.handle.z - this.phaseZ;
      if (dx % tileLdu !== 0 || dz % tileLdu !== 0) continue;
      const piece = entry.kit.pieces.find((p) => p.ref === model.handle.refId);
      if (!piece || !isRot90(model.handle.rot)) continue;
      tiles.set(`${dx / tileLdu},${dz / tileLdu}`, {
        model,
        tile: {
          arms: rotateArms(piece.arms, model.handle.rot),
          sameKit: entry.kit.family === family,
        },
      });
    }
    return tiles;
  }

  private strokeReach(): WorldBox {
    const tileLdu = this.entry().kit.tileLdu;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const tile of this.path) {
      const [x, z] = this.centre(tile);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const reach = (NEIGHBOUR_TILES + 1 / 2) * tileLdu;
    return {
      minX: minX - reach,
      maxX: maxX + reach,
      minY: 0,
      maxY: 0,
      minZ: minZ - reach,
      maxZ: maxZ + reach,
    };
  }

  private evaluate(neighbours: RoadNeighbourhood): RoadPreview {
    const roads = this.nearRoads;
    const others = this.nearOthers;
    neighbours.near(this.strokeReach(), roads, others);
    const { kit, view } = this.entry();
    const existing = this.existingTiles(roads);
    const ground = this.groundTiles(roads, others);
    const existingAt = (ix: number, iz: number) => existing.get(`${ix},${iz}`)?.tile ?? null;
    const planned = this.erasing
      ? planRoadErase(kit, this.path, existingAt)
      : planRoadTiles(kit, this.path, existingAt, this.preferredRot);
    const lifted = planned.flatMap((tile) => {
      const model = tile.kind === "remove" ? existing.get(`${tile.ix},${tile.iz}`)?.model : null;
      return model ? [{ tile, model }] : [];
    });
    const refills = lifted.flatMap(({ tile, model }) => {
      const refill = this.refill(tile, model);
      return refill ? [refill] : [];
    });
    const refilled = new Set(refills.map((refill) => refill.replaces));
    const removals = lifted.flatMap(({ model }) => (refilled.has(model) ? [] : [model]));
    const choiceOf = new Map<PlannedRoadTile, number>();
    for (const tile of planned) if (tile.kind === "lay") choiceOf.set(tile, 0);
    let issues: RoadTileIssue[] = [];
    let placements: TilePlacement[] = [];
    for (let round = 0; round < MAX_CHOICE_ROUNDS; round++) {
      placements = [...this.placementsFor(planned, choiceOf, existing, ground), ...refills];
      issues = this.check(planned, placements, removals, roads, others);
      const retry = placements.filter(
        (p) =>
          issues.some((issue) => this.sameTile(issue, p.tile) && issue.problem === "mismatch") &&
          p.tile.kind === "lay" &&
          p.choice + 1 < p.tile.choices.length,
      );
      if (retry.length === 0) break;
      for (const p of retry) choiceOf.set(p.tile, p.choice + 1);
    }
    const laying = placements.filter((p) => p.tile.kind === "lay");
    const replaced = laying.filter((p) => p.tile.kind === "lay" && p.tile.replaces).length;
    const overGround = laying.filter((p) => p.replaces !== null).length - replaced;
    const stroke: RoadStrokeView = {
      kit: view.id,
      erasing: this.erasing,
      tiles: planned.length,
      laid: laying.length - replaced - overGround,
      replaced,
      overGround,
      removed: lifted.length,
      refilled: refills.length,
      kept: planned.filter((tile) => tile.kind === "keep").length,
      stranded: planned.flatMap((tile) => {
        if (tile.kind !== "stranded") return [];
        const [x, z] = this.centre(tile);
        return [{ x, z, junction: roadShape(tile.junction), remaining: shapeOf(tile.arms) }];
      }),
      issues,
    };
    this.evaluated = { placements, removals, issues, view: stroke };
    return {
      ghost: this.ghost(placements),
      markers: this.markers(planned, placements, removals, issues),
      view: stroke,
    };
  }

  private refill(tile: PlannedRoadTile, lifted: PlacedModel): TilePlacement | null {
    const pose = this.groundUnder.get(lifted.placement);
    return pose ? { tile, choice: 0, pose, replaces: lifted } : null;
  }

  private sameTile(issue: RoadTileIssue, tile: PlannedRoadTile): boolean {
    const [x, z] = this.centre(tile);
    return issue.x === x && issue.z === z;
  }

  private placementsFor(
    planned: ReadonlyArray<PlannedRoadTile>,
    choiceOf: ReadonlyMap<PlannedRoadTile, number>,
    existing: ReadonlyMap<string, { readonly model: PlacedModel }>,
    ground: ReadonlyMap<string, PlacedModel>,
  ): TilePlacement[] {
    const placements: TilePlacement[] = [];
    for (const tile of planned) {
      if (tile.kind !== "lay") continue;
      const choice = choiceOf.get(tile) ?? 0;
      const picked = tile.choices[choice];
      if (!picked) continue;
      const [x, z] = this.centre(tile);
      placements.push({
        tile,
        choice,
        pose: {
          refId: picked.ref,
          colorId: this.placeable(picked.ref).worldColor,
          x,
          z,
          yPlates: 0,
          rot: picked.rot,
        },
        replaces: tile.replaces
          ? (existing.get(`${tile.ix},${tile.iz}`)?.model ?? null)
          : (ground.get(`${tile.ix},${tile.iz}`) ?? null),
      });
    }
    return placements;
  }

  private check(
    planned: ReadonlyArray<PlannedRoadTile>,
    placements: ReadonlyArray<TilePlacement>,
    removals: ReadonlyArray<PlacedModel>,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadTileIssue[] {
    const issues: RoadTileIssue[] = [];
    for (const tile of planned) {
      if (tile.kind !== "refuse") continue;
      const [x, z] = this.centre(tile);
      issues.push({ x, z, problem: tile.reason, shape: shapeOf(tile.arms), blocker: null });
    }
    if (placements.length === 0) return issues;
    let top = Number.NEGATIVE_INFINITY;
    for (let p = 0; p < placements.length; p++) {
      const placement = placements[p];
      if (placement) top = Math.max(top, this.placeable(placement.pose.refId).box.max[1]);
    }
    const area = placements.map((p) => this.tileBox(p.tile, top));
    const reach = this.entry().kit.tileLdu;
    const network = this.network;
    const kept = this.kept;
    network.clear();
    let keptCount = 0;
    for (let r = 0; r < roads.length; r++) {
      const model = roads[r];
      if (!model || replacedBy(model, removals, placements) || !nearArea(model.box, area, reach)) {
        continue;
      }
      const id = keptCount++;
      kept[id] = model;
      const surface = model.placeable.road;
      if (!surface) continue;
      network.add({
        id,
        x: model.handle.x,
        z: model.handle.z,
        yLdu: model.handle.yPlates * PLATE_LDU,
        rot: model.handle.rot,
        surface,
      });
    }
    const firstNew = keptCount;
    for (let index = 0; index < placements.length; index++) {
      const p = placements[index];
      const surface = p ? this.placeable(p.pose.refId).road : null;
      if (!p || !surface) continue;
      network.add({
        id: firstNew + index,
        x: p.pose.x,
        z: p.pose.z,
        yLdu: 0,
        rot: p.pose.rot,
        surface,
      });
    }
    for (let index = 0; index < placements.length; index++) {
      const p = placements[index];
      if (!p) continue;
      const id = firstNew + index;
      const [x, z] = this.centre(p.tile);
      const join = network.placementJoin(id);
      if (join.overlapPartner !== null) {
        const other = join.overlapPartner;
        issues.push({
          x,
          z,
          problem: "overlap",
          shape: shapeOf(p.tile.arms),
          blocker: other >= firstNew ? null : (kept[other]?.placeable.label ?? null),
        });
        continue;
      }
      const box = this.tileBox(p.tile, top);
      const model = meetingModel(kept, keptCount, others, box, removals, placements);
      if (model) {
        issues.push({
          x,
          z,
          problem: "overlap",
          shape: shapeOf(p.tile.arms),
          blocker: model.placeable.label,
        });
        continue;
      }
      if (join.mismatched) {
        issues.push({
          x,
          z,
          problem: "mismatch",
          shape: shapeOf(p.tile.arms),
          blocker: touchingModel(kept, keptCount, box)?.placeable.label ?? null,
        });
      }
    }
    return issues;
  }

  private ghost(placements: ReadonlyArray<TilePlacement>): ChunkInstances | null {
    const first = placements[0];
    if (!first) return null;
    const originX = first.pose.x;
    const originZ = first.pose.z;
    let parts = 0;
    let studs = 0;
    for (const p of placements) {
      const placeable = this.placeable(p.pose.refId);
      parts += placeable.parts.count;
      studs += placeable.studs.count;
    }
    const ghost: ChunkInstances = {
      originX,
      originZ,
      count: parts,
      partIndex: new Uint16Array(parts),
      colorIndex: new Uint16Array(parts),
      matrices: new Float32Array(parts * INSTANCE_MATRIX_FLOATS),
      studs: {
        count: studs,
        primitiveIndex: new Uint8Array(studs),
        colorIndex: new Uint16Array(studs),
        matrices: new Float32Array(studs * INSTANCE_MATRIX_FLOATS),
      },
    };
    let part = 0;
    let stud = 0;
    for (const p of placements) {
      const placeable = this.placeable(p.pose.refId);
      const dx = p.pose.x - originX;
      const dz = p.pose.z - originZ;
      transformInto(
        placeable.parts.matrices,
        placeable.parts.count,
        p.pose.rot,
        dx,
        dz,
        ghost.matrices,
        part,
      );
      ghost.partIndex.set(placeable.parts.partIndex.subarray(0, placeable.parts.count), part);
      ghost.colorIndex.set(placeable.parts.colorIndex.subarray(0, placeable.parts.count), part);
      part += placeable.parts.count;
      transformInto(
        placeable.studs.matrices,
        placeable.studs.count,
        p.pose.rot,
        dx,
        dz,
        ghost.studs.matrices,
        stud,
      );
      ghost.studs.primitiveIndex.set(
        placeable.studs.primitiveIndex.subarray(0, placeable.studs.count),
        stud,
      );
      ghost.studs.colorIndex.set(
        placeable.studs.colorIndex.subarray(0, placeable.studs.count),
        stud,
      );
      stud += placeable.studs.count;
    }
    return ghost;
  }

  private markers(
    planned: ReadonlyArray<PlannedRoadTile>,
    placements: ReadonlyArray<TilePlacement>,
    removals: ReadonlyArray<PlacedModel>,
    issues: ReadonlyArray<RoadTileIssue>,
  ): ReadonlyArray<EdgeMarker> {
    const top = Math.max(
      0,
      ...placements.map((p) => this.placeable(p.pose.refId).box.max[1]),
      ...removals.map((model) => model.box.maxY),
    );
    const markers: EdgeMarker[] = [];
    for (const tile of planned) {
      const box = this.tileBox(tile, top);
      if (tile.kind === "remove" || issues.some((issue) => this.sameTile(issue, tile))) {
        markers.push(...outline(box, "mismatch"));
      } else if (
        tile.kind === "stranded" ||
        placements.some((p) => p.tile === tile && p.replaces !== null)
      ) {
        markers.push(...outline(box, "open"));
      }
    }
    return markers;
  }
}

function transformInto(
  source: Float32Array,
  count: number,
  rot: number,
  dx: number,
  dz: number,
  target: Float32Array,
  firstSlot: number,
): void {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  for (let i = 0; i < count; i++) {
    const s = i * INSTANCE_MATRIX_FLOATS;
    const t = (firstSlot + i) * INSTANCE_MATRIX_FLOATS;
    for (let col = 0; col < 4; col++) {
      const row0 = source[s + col] ?? 0;
      const row2 = source[s + 8 + col] ?? 0;
      target[t + col] = cos * row0 + sin * row2;
      target[t + 4 + col] = source[s + 4 + col] ?? 0;
      target[t + 8 + col] = -sin * row0 + cos * row2;
    }
    target[t + 3] = (target[t + 3] ?? 0) + dx;
    target[t + 11] = (target[t + 11] ?? 0) + dz;
  }
}
