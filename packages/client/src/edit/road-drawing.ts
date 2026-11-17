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
  type RoadPlacement,
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

export type RoadTileProblem =
  | "no-piece"
  | "other-family"
  | "mismatch"
  | "overlap"
  | "crosses-track";

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

function familyOf(placeable: Placeable): string {
  return placeable.kind === "mils-module" ? "mils" : String(placeable.worldColor);
}

function boxesMeet(a: WorldBox, b: WorldBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function touches(a: WorldBox, b: WorldBox): boolean {
  const alongZ = a.minZ < b.maxZ && a.maxZ > b.minZ;
  const alongX = a.minX < b.maxX && a.maxX > b.minX;
  return (
    (alongZ && (a.maxX === b.minX || a.minX === b.maxX)) ||
    (alongX && (a.maxZ === b.minZ || a.minZ === b.maxZ))
  );
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
  preferredRot = 0;
  erasing = false;

  constructor(
    private readonly placeables: ReadonlyArray<Placeable>,
    familyLabel: (family: string, placeable: Placeable) => string,
  ) {
    const kits = roadKits(
      placeables.flatMap((placeable, ref) =>
        placeable.road ? [{ ref, family: familyOf(placeable), surface: placeable.road }] : [],
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
            label: `${familyLabel(kit.family, first)}, ${kitTraits(kit)}`,
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

  hover(
    x: number,
    z: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadPreview | null {
    if (this.dragging) return null;
    const { phaseX, phaseZ } = this;
    const previous = this.path[0];
    this.choosePhase(x, z, [...roads, ...others]);
    const tile = this.tileAt(x, z);
    const unchanged =
      this.evaluated !== null &&
      this.path.length === 1 &&
      previous?.ix === tile.ix &&
      previous.iz === tile.iz &&
      phaseX === this.phaseX &&
      phaseZ === this.phaseZ;
    if (unchanged) return null;
    this.path = [tile];
    return this.evaluate(roads, others);
  }

  worldChanged(): void {
    this.evaluated = null;
  }

  begin(
    x: number,
    z: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadPreview | null {
    this.choosePhase(x, z, [...roads, ...others]);
    this.dragging = true;
    this.path = [this.tileAt(x, z)];
    return this.evaluate(roads, others);
  }

  move(
    x: number,
    z: number,
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadPreview | null {
    if (!this.dragging) return null;
    const before = this.path;
    this.extend(x, z);
    if (this.path === before && this.evaluated) return null;
    return this.evaluate(roads, others);
  }

  extend(x: number, z: number): void {
    if (!this.dragging) return;
    const tile = this.tileAt(x, z);
    this.path = extendRoadPath(this.path, tile.ix, tile.iz);
  }

  rerun(roads: ReadonlyArray<PlacedModel>, others: ReadonlyArray<PlacedModel>): RoadPreview | null {
    if (this.path.length === 0) return null;
    return this.evaluate(roads, others);
  }

  end(
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): {
    readonly requests: ReadonlyArray<PlacementRequest>;
    readonly view: RoadStrokeView;
  } | null {
    if (!this.dragging || this.path.length === 0) {
      this.cancel();
      return null;
    }
    this.evaluate(roads, others);
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
    const placeable = this.placeables[ref];
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
    return placeable.kind === "baseplate";
  }

  private choosePhase(x: number, z: number, models: ReadonlyArray<PlacedModel>): void {
    const tileLdu = this.entry().kit.tileLdu;
    const under = models.find(
      (model) =>
        (this.compatible(model) || this.isGround(model)) &&
        x >= model.box.minX &&
        x < model.box.maxX &&
        z >= model.box.minZ &&
        z < model.box.maxZ,
    );
    const latticeCentre = Math.round(tileLdu / 2 / STUD_LDU) * STUD_LDU;
    this.phaseX = under ? (under.box.minX + under.box.maxX) / 2 : latticeCentre;
    this.phaseZ = under ? (under.box.minZ + under.box.maxZ) / 2 : latticeCentre;
  }

  private groundTiles(models: ReadonlyArray<PlacedModel>): Map<string, PlacedModel> {
    const tileLdu = this.entry().kit.tileLdu;
    const tiles = new Map<string, PlacedModel>();
    for (const model of models) {
      if (!this.isGround(model)) continue;
      const dx = (model.box.minX + model.box.maxX) / 2 - this.phaseX;
      const dz = (model.box.minZ + model.box.maxZ) / 2 - this.phaseZ;
      if (dx % tileLdu !== 0 || dz % tileLdu !== 0) continue;
      tiles.set(`${dx / tileLdu},${dz / tileLdu}`, model);
    }
    return tiles;
  }

  private tileAt(x: number, z: number): RoadTile {
    const tileLdu = this.entry().kit.tileLdu;
    return {
      ix: Math.round((x - this.phaseX) / tileLdu),
      iz: Math.round((z - this.phaseZ) / tileLdu),
    };
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

  private existingTiles(
    roads: ReadonlyArray<PlacedModel>,
  ): Map<string, { readonly model: PlacedModel; readonly tile: ExistingRoadTile }> {
    const tileLdu = this.entry().kit.tileLdu;
    const family = this.entry().kit.family;
    const tiles = new Map<
      string,
      { readonly model: PlacedModel; readonly tile: ExistingRoadTile }
    >();
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

  private evaluate(
    roads: ReadonlyArray<PlacedModel>,
    others: ReadonlyArray<PlacedModel>,
  ): RoadPreview {
    const { kit, view } = this.entry();
    const existing = this.existingTiles(roads);
    const ground = this.groundTiles([...roads, ...others]);
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
    const top = Math.max(...placements.map((p) => this.placeable(p.pose.refId).box.max[1]));
    const area = placements.map((p) => this.tileBox(p.tile, top));
    const near = (box: WorldBox): boolean => {
      const reach = this.entry().kit.tileLdu;
      return area.some(
        (a) =>
          box.minX < a.maxX + reach &&
          box.maxX > a.minX - reach &&
          box.minZ < a.maxZ + reach &&
          box.maxZ > a.minZ - reach,
      );
    };
    const replaced = new Set([
      ...removals,
      ...placements.flatMap((p) => (p.replaces ? [p.replaces] : [])),
    ]);
    const kept = roads.filter((model) => !replaced.has(model) && near(model.box));
    const network: RoadPlacement[] = kept.flatMap((model, id) =>
      model.placeable.road
        ? [
            {
              id,
              x: model.handle.x,
              z: model.handle.z,
              yLdu: model.handle.yPlates * PLATE_LDU,
              rot: model.handle.rot,
              surface: model.placeable.road,
            },
          ]
        : [],
    );
    const firstNew = kept.length;
    placements.forEach((p, index) => {
      const surface = this.placeable(p.pose.refId).road;
      if (!surface) return;
      network.push({
        id: firstNew + index,
        x: p.pose.x,
        z: p.pose.z,
        yLdu: 0,
        rot: p.pose.rot,
        surface,
      });
    });
    const report = new RoadNetwork(network).report();
    placements.forEach((p, index) => {
      const id = firstNew + index;
      const [x, z] = this.centre(p.tile);
      const overlap = report.overlaps.find(([a, b]) => a === id || b === id);
      const blockerOf = (other: number): string | null =>
        other >= firstNew ? null : (kept[other]?.placeable.label ?? null);
      if (overlap) {
        const other = overlap[0] === id ? overlap[1] : overlap[0];
        issues.push({
          x,
          z,
          problem: "overlap",
          shape: shapeOf(p.tile.arms),
          blocker: blockerOf(other),
        });
        return;
      }
      const box = this.tileBox(p.tile, top);
      const model = others.find((other) => !replaced.has(other) && boxesMeet(other.box, box));
      if (model) {
        issues.push({
          x,
          z,
          problem: "overlap",
          shape: shapeOf(p.tile.arms),
          blocker: model.placeable.label,
        });
        return;
      }
      if (report.segments.some((s) => s.placement === id && s.status === "mismatch")) {
        const beside = kept.find((other) => touches(other.box, box));
        issues.push({
          x,
          z,
          problem: "mismatch",
          shape: shapeOf(p.tile.arms),
          blocker: beside?.placeable.label ?? null,
        });
      }
    });
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
