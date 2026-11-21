import type { PartAsset, PartShapeAsset } from "@brr/catalog";
import type { TrackChange } from "@brr/domain";
import { QUARTER_TURN_16, STUD_LDU, ZETA16_ORDER, pose16, zeta16, type Pose16 } from "@brr/math";
import { SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import type { CatalogItemView, IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import { PLACEABLE_CATALOG, RAIL_YARD, TRACK_WORLD, WORLD_SESSION } from "../tokens.ts";
import type { IRailYard } from "../trains/rail-yard.ts";
import { trackBlockText } from "./track-drag.ts";
import {
  TRACK_SYSTEM,
  type JoinWithheld,
  type PieceSnap,
  type SwitchLeverView,
  type TrackBlockView,
  type TrackDragView,
  type TrackDrawing,
  type TrackGapView,
} from "./track-drawing.ts";
import type { ExtensionRun, ExtensionTurn, TrackExtendView } from "./track-extension.ts";
import type { Lever } from "./track-pieces.ts";
import type { ITrackWorld, TrackUnsupportedView } from "./track-world.ts";
import type { TurnDirection } from "./turn.ts";
import type { SuggestedCrossing } from "./crossing-ramps.ts";
import type { IWorldSession } from "./world-session.ts";

export interface CatalogPartView {
  readonly id: string;
  readonly title: string;
}

export interface TrackBomLine {
  readonly piece: string;
  readonly title: string;
  readonly count: number;
}

export interface TrackSolveStats {
  readonly samples: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export type TrackCommitResult =
  | "laid"
  | "joined"
  | "refused-impossible"
  | "refused-blocked"
  | "refused-limit"
  | "switch-straight"
  | "switch-branching";

export interface TrackPieceView {
  readonly item: string;
  readonly label: string;
  readonly snapped: boolean;
  readonly joins: number;
  readonly misses: number;
  readonly connector: number;
  readonly connectors: number;
  readonly mirror: string | null;
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

export interface TrackView {
  readonly pieces: number;
  readonly modelPieces: number;
  readonly runFramePieces: number;
  readonly offField: number;
  readonly unanchored: number;
  readonly bom: ReadonlyArray<TrackBomLine>;
  readonly openEnds: number;
  readonly joins: number;
  readonly coincidentEndIssues: number;
  readonly gaps: ReadonlyArray<TrackGapView>;
  readonly switches: ReadonlyArray<SwitchLeverView>;
  readonly held: TrackPieceView | null;
  readonly drag: TrackDragView | null;
  readonly extend: TrackExtendView | null;
  readonly lastCommit: TrackCommitResult | null;
  readonly lastBlock: TrackBlockView | null;
  readonly lastWithheld: JoinWithheld | null;
  readonly lastUnsupported: TrackUnsupportedView | null;
  readonly unsupported: number | null;
  readonly crossings: ReadonlyArray<CrossingView>;
  readonly solve: TrackSolveStats | null;
}

export interface TrackEditView {
  readonly track: TrackView | null;
  readonly trackNotDrawable: ReadonlyArray<CatalogPartView>;
}

export interface TrackEditSample {
  readonly item: string;
  readonly rot: number;
  readonly x: number;
  readonly z: number;
}

export interface TrackClickRefusal {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly reason: string;
}

export type LayOrigin =
  | {
      readonly kind: "drag";
      readonly goal: Pose16 | null;
      readonly end: Pose16 | null;
      readonly firstLaid: number;
      readonly blocked: TrackBlockView | null;
      readonly withheld: JoinWithheld | null;
    }
  | {
      readonly kind: "extension";
      readonly goal: Pose16 | null;
      readonly run: ExtensionRun;
      readonly end: Pose16;
      readonly firstLaid: number;
    }
  | { readonly kind: "held"; readonly joinsBefore: number; readonly firstLaid: number };

export interface TrackLayRequest {
  readonly change: TrackChange;
  readonly sample: TrackEditSample | null;
  readonly origin: LayOrigin;
}

export interface SwitchThrowRequest {
  readonly change: TrackChange;
  readonly sample: TrackEditSample;
  readonly lever: Lever;
}

export type TrackDragEnd =
  | { readonly kind: "idle" }
  | { readonly kind: "click" }
  | { readonly kind: "settled" }
  | { readonly kind: "lay"; readonly lay: TrackLayRequest };

export type HeldPlacement =
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly refusal: TrackClickRefusal }
  | { readonly kind: "lay"; readonly lay: TrackLayRequest };

export type ExtensionAttempt =
  | { readonly kind: "none" }
  | { readonly kind: "blocked" }
  | { readonly kind: "lay"; readonly lay: TrackLayRequest };

export type SwitchAttempt =
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly refusal: TrackClickRefusal }
  | { readonly kind: "throw"; readonly thrown: SwitchThrowRequest };

export interface ITrackEditSession {
  start(): ReadonlyArray<CatalogItemView>;
  view(): TrackEditView;
  pick(id: string): boolean;
  drop(): void;
  holding(): boolean;
  dragging(): boolean;
  showHeld(
    hovering: boolean,
    hitX: number,
    hitZ: number,
    latticeX: number,
    latticeZ: number,
  ): TrackEditView | null;
  refreshPreview(
    trackMode: boolean,
    hovering: boolean,
    hitX: number,
    hitZ: number,
  ): TrackEditView | null;
  repaint(trackMode: boolean, hovering: boolean, hitX: number, hitZ: number): TrackEditView | null;
  beginDrag(hitX: number, hitZ: number, latticeX: number, latticeZ: number): void;
  moveDrag(hitX: number, hitZ: number): TrackEditView;
  endDrag(
    hit: boolean,
    hitX: number,
    hitZ: number,
    latticeX: number,
    latticeZ: number,
  ): TrackDragEnd;
  onExtension(hitX: number, hitZ: number): boolean;
  extend(turn: ExtensionTurn | null): ExtensionAttempt;
  cycleChoice(step: 1 | -1): TrackEditView | null;
  selectChoice(index: number): TrackEditView | null;
  dropExtension(): boolean;
  placeHeld(latticeX: number, latticeZ: number): HeldPlacement;
  throwSwitchAt(hitX: number, hitZ: number): SwitchAttempt;
  throwSwitch(piece: number, hitX: number, hitZ: number): SwitchAttempt;
  switchRefusal(piece: number, x: number, z: number): TrackClickRefusal | null;
  finishLay(lay: TrackLayRequest): void;
  finishThrow(thrown: SwitchThrowRequest): void;
  interruptDrag(): void;
  clearEnds(): void;
  turnHeld(direction: TurnDirection): void;
  nextConnector(): void;
  mirror(): string | null;
}

export const TRACK_ITEM_ID = `track:${TRACK_SYSTEM}`;
export const TRACK_PIECE_PREFIX = "track-piece:";
const TRACK_PIECE_GROUP = "track-pieces";
const TRACK_PIECE_GROUP_LABEL = "Track pieces";
const TRACK_ITEM_LABEL = "Track: 9V straights and R40 curves";
const TRACK_SHORT_LABEL = "Track";
const TRACK_HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const P95 = 0.95;
const NOTHING: { readonly kind: "none" } = { kind: "none" };

interface HeldPiece {
  readonly catalogIndex: number;
  readonly connector: number;
  readonly heading: number;
  readonly snap: PieceSnap | null;
}

function undrawableTrack(
  track: TrackDrawing,
  parts: ReadonlyArray<PartAsset>,
): ReadonlyArray<CatalogPartView> {
  const drawable = new Set(track.pieceParts().map((kit) => parts[kit.partIndex]?.id));
  return parts
    .filter((part) => part.role === "track" && !drawable.has(part.id))
    .map((part) => ({ id: part.id.replace("ldraw:", ""), title: part.title }));
}

@injectable()
export class TrackEditSession implements ITrackEditSession {
  private notDrawable: ReadonlyArray<CatalogPartView> = [];
  private held: HeldPiece | null = null;
  private trackPress: { readonly x: number; readonly z: number } | null = null;
  private previewVersion: number | null = null;
  private endTarget = "";
  private lastCommit: TrackCommitResult | null = null;
  private lastBlock: TrackBlockView | null = null;
  private lastWithheld: JoinWithheld | null = null;
  private lastUnsupported: TrackUnsupportedView | null = null;

  constructor(
    @inject(TRACK_WORLD) private readonly trackWorld: ITrackWorld,
    @inject(SCENE_BACKEND)
    private readonly backend: Pick<ISceneBackend, "setGhost" | "placeGhost" | "setTrackEnds">,
    @inject(PLACEABLE_CATALOG)
    private readonly catalog: Pick<IPlaceableCatalog, "parts" | "placeables">,
    @inject(WORLD_SESSION) private readonly worldSession: Pick<IWorldSession, "view">,
    @inject(RAIL_YARD) private readonly railYard: Pick<IRailYard, "standingOn">,
  ) {}

  start(): ReadonlyArray<CatalogItemView> {
    const track = this.trackWorld.drawing();
    if (!track) return [];
    const parts = this.catalog.parts();
    this.notDrawable = undrawableTrack(track, parts);
    return [this.trackItem(track, parts), ...this.trackPieceItems(track, parts)];
  }

  view(): TrackEditView {
    return { track: this.trackView(), trackNotDrawable: this.notDrawable };
  }

  pick(id: string): boolean {
    const track = this.trackWorld.drawing();
    if (!track) return false;
    const pieceIndex = this.trackPieceIndex(track, id);
    if (id !== TRACK_ITEM_ID && pieceIndex === null) return false;
    track.cancelDrag();
    track.extension.drop();
    this.held =
      pieceIndex === null
        ? null
        : { catalogIndex: pieceIndex, connector: 0, heading: 0, snap: null };
    this.backend.setGhost(null);
    this.trackWorld.requestPieceMeshes();
    this.lastCommit = null;
    this.lastBlock = null;
    return true;
  }

  drop(): void {
    const track = this.trackWorld.drawing();
    this.held = null;
    track?.cancelDrag();
    track?.extension.drop();
    this.backend.setGhost(null);
    this.targetTrackEnds([]);
  }

  holding(): boolean {
    return this.held !== null;
  }

  dragging(): boolean {
    return (this.trackWorld.drawing()?.dragView() ?? null) !== null;
  }

  showHeld(
    hovering: boolean,
    hitX: number,
    hitZ: number,
    latticeX: number,
    latticeZ: number,
  ): TrackEditView | null {
    const track = this.trackWorld.drawing();
    const held = this.held;
    if (!track || !held) return null;
    if (!hovering) {
      this.backend.setGhost(null);
      return null;
    }
    const free = pose16(
      zeta16([BigInt(latticeX / STUD_LDU), 0n, 0n, 0n, BigInt(latticeZ / STUD_LDU), 0n, 0n, 0n]),
      held.heading,
    );
    const snap = track.snapPiece(held.catalogIndex, held.connector, hitX, hitZ, free);
    this.held = { ...held, snap };
    const ghost = track.pieceGhost(held.catalogIndex, snap.placement);
    this.backend.setGhost(ghost.instances);
    this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
    this.targetTrackEnds(snap.end === null ? [] : [snap.end], snap.misses);
    return this.view();
  }

  refreshPreview(
    trackMode: boolean,
    hovering: boolean,
    hitX: number,
    hitZ: number,
  ): TrackEditView | null {
    const track = this.trackWorld.drawing();
    if (!track || !trackMode || this.held || track.dragView()) return null;
    const { extension } = track;
    const readOnly = this.worldSession.view().readOnly;
    if (readOnly) extension.drop();
    const hovered = hovering ? track.endNear(hitX, hitZ, null) : null;
    extension.focusOn(readOnly ? null : hovered);
    return this.paint(track);
  }

  repaint(trackMode: boolean, hovering: boolean, hitX: number, hitZ: number): TrackEditView | null {
    this.previewVersion = null;
    return this.refreshPreview(trackMode, hovering, hitX, hitZ);
  }

  beginDrag(hitX: number, hitZ: number, latticeX: number, latticeZ: number): void {
    const track = this.trackWorld.drawing();
    if (!track) return;
    this.trackWorld.setObstacles();
    track.beginDrag(hitX, hitZ, latticeX, latticeZ);
    this.trackPress = { x: latticeX, z: latticeZ };
    this.lastCommit = null;
    this.lastBlock = null;
    this.lastWithheld = null;
    this.lastUnsupported = null;
    this.backend.setGhost(null);
    this.showTrackEnds([]);
  }

  moveDrag(hitX: number, hitZ: number): TrackEditView {
    const track = this.trackWorld.drawing();
    if (!track) return this.view();
    track.moveDrag(hitX, hitZ);
    this.showTrackGhost(track);
    const target = track.dragTarget();
    this.targetTrackEnds(
      target?.joins ? [target.end] : [],
      target && !target.joins ? [target.end] : [],
    );
    return this.view();
  }

  endDrag(
    hit: boolean,
    hitX: number,
    hitZ: number,
    latticeX: number,
    latticeZ: number,
  ): TrackDragEnd {
    const track = this.trackWorld.drawing();
    const press = this.trackPress;
    this.trackPress = null;
    if (!track?.dragView()) return { kind: "idle" };
    if (hit) track.moveDrag(hitX, hitZ);
    const stayed = (track.dragView()?.pieces ?? 0) === 0;
    const unmoved = press !== null && press.x === latticeX && press.z === latticeZ;
    const outcome = track.endDrag();
    this.backend.setGhost(null);
    this.showTrackEnds([]);
    const clicked = unmoved || (outcome.refusal === null && outcome.withheld === null);
    if (hit && stayed && clicked) return { kind: "click" };
    const firstLaid = track.pieceCount;
    if (outcome.refusal) {
      this.lastCommit = `refused-${outcome.refusal}`;
    } else if (outcome.change.lay.length > 0) {
      return {
        kind: "lay",
        lay: {
          change: outcome.change,
          sample: { item: TRACK_ITEM_ID, rot: 0, x: latticeX, z: latticeZ },
          origin: {
            kind: "drag",
            goal: outcome.goal,
            end: outcome.end,
            firstLaid,
            blocked: outcome.blocked,
            withheld: outcome.withheld,
          },
        },
      };
    }
    this.lastBlock = outcome.blocked;
    this.lastWithheld = outcome.withheld;
    return { kind: "settled" };
  }

  onExtension(hitX: number, hitZ: number): boolean {
    return this.trackWorld.drawing()?.onExtension(hitX, hitZ) ?? false;
  }

  extend(turn: ExtensionTurn | null): ExtensionAttempt {
    const track = this.trackWorld.drawing();
    if (!track) return NOTHING;
    if (turn !== null && !track.extension.choose(turn)) return NOTHING;
    const plan = track.extensionPlan();
    if (!plan) return NOTHING;
    this.lastWithheld = null;
    this.lastUnsupported = null;
    if (plan.run.choice.blocked !== null) {
      this.lastCommit = null;
      this.lastBlock = plan.run.choice.blocked;
      return { kind: "blocked" };
    }
    this.lastBlock = null;
    return {
      kind: "lay",
      lay: {
        change: plan.change,
        sample: null,
        origin: {
          kind: "extension",
          goal: plan.goal,
          run: plan.run,
          end: plan.end,
          firstLaid: track.pieceCount,
        },
      },
    };
  }

  cycleChoice(step: 1 | -1): TrackEditView | null {
    const track = this.trackWorld.drawing();
    if (!track || this.held || track.dragView()) return null;
    return track.extension.cycle(step) ? this.paint(track) : null;
  }

  selectChoice(index: number): TrackEditView | null {
    const track = this.trackWorld.drawing();
    if (!track || this.held || track.dragView()) return null;
    return track.extension.select(index) ? this.paint(track) : null;
  }

  dropExtension(): boolean {
    return this.trackWorld.drawing()?.extension.drop() ?? false;
  }

  placeHeld(latticeX: number, latticeZ: number): HeldPlacement {
    const track = this.trackWorld.drawing();
    const held = this.held;
    const snap = held?.snap;
    if (!track || !held || !snap) return NOTHING;
    this.trackWorld.setObstacles();
    const block = track.pieceBlock(held.catalogIndex, snap.placement);
    this.lastWithheld = null;
    this.lastUnsupported = null;
    if (block) {
      const label = track.pieceByIndex(held.catalogIndex).piece.title;
      this.lastCommit = null;
      this.lastBlock = block;
      const reason = `${label} would ${trackBlockText(block)}.`;
      return {
        kind: "refused",
        refusal: { item: TRACK_ITEM_ID, x: latticeX, z: latticeZ, reason },
      };
    }
    const joinsBefore = track.joinedPairs();
    const firstLaid = track.pieceCount;
    const change = track.pieceChange(held.catalogIndex, snap.placement);
    return {
      kind: "lay",
      lay: { change, sample: null, origin: { kind: "held", joinsBefore, firstLaid } },
    };
  }

  throwSwitchAt(hitX: number, hitZ: number): SwitchAttempt {
    const placement = this.trackWorld.drawing()?.switchAt(hitX, hitZ) ?? null;
    return placement === null ? NOTHING : this.throwSwitch(placement, hitX, hitZ);
  }

  throwSwitch(piece: number, hitX: number, hitZ: number): SwitchAttempt {
    const track = this.trackWorld.drawing();
    if (!track || this.worldSession.view().readOnly) return NOTHING;
    const refusal = this.switchRefusal(piece, hitX, hitZ);
    if (refusal) return { kind: "refused", refusal };
    const thrown = track.switchThrow(piece);
    if (!thrown) return NOTHING;
    return {
      kind: "throw",
      thrown: {
        change: thrown.change,
        sample: { item: `switch #${piece + 1}`, rot: 0, x: Math.round(hitX), z: Math.round(hitZ) },
        lever: thrown.lever,
      },
    };
  }

  switchRefusal(piece: number, x: number, z: number): TrackClickRefusal | null {
    const standing = this.railYard.standingOn(piece);
    if (!standing) return null;
    const refId = standing.pose.refId;
    const holder = this.catalog.placeables()[refId];
    if (!holder) throw new Error(`no catalog item has ref id ${refId}`);
    return {
      item: TRACK_ITEM_ID,
      x: Math.round(x),
      z: Math.round(z),
      reason: `${holder.label} stands on this switch, so it can't be thrown under it.`,
    };
  }

  finishLay(lay: TrackLayRequest): void {
    const track = this.trackWorld.drawing();
    if (!track) return;
    const { origin } = lay;
    switch (origin.kind) {
      case "drag":
        this.lastCommit = origin.goal !== null && track.joinsAt(origin.goal) ? "joined" : "laid";
        track.extension.continueFrom(origin.end);
        this.lastUnsupported = this.trackWorld.unsupportedSince(origin.firstLaid);
        this.lastBlock = origin.blocked;
        this.lastWithheld = origin.withheld;
        return;
      case "extension":
        this.lastCommit = origin.goal !== null && track.joinsAt(origin.goal) ? "joined" : "laid";
        this.lastUnsupported = this.trackWorld.unsupportedSince(origin.firstLaid);
        track.extension.laid(origin.run, origin.end);
        return;
      case "held": {
        this.lastCommit = track.joinedPairs() > origin.joinsBefore ? "joined" : "laid";
        this.lastBlock = null;
        this.lastUnsupported = this.trackWorld.unsupportedSince(origin.firstLaid);
        const held = this.held;
        if (held) this.held = { ...held, snap: null };
        return;
      }
      default: {
        const unhandled: never = origin;
        throw new Error(`unhandled lay origin ${String(unhandled)}`);
      }
    }
  }

  finishThrow(thrown: SwitchThrowRequest): void {
    this.lastCommit = thrown.lever === "straight" ? "switch-straight" : "switch-branching";
  }

  interruptDrag(): void {
    const track = this.trackWorld.drawing();
    if (!track?.dragView()) return;
    track.cancelDrag();
    this.backend.setGhost(null);
  }

  clearEnds(): void {
    this.showTrackEnds([]);
  }

  turnHeld(direction: TurnDirection): void {
    const held = this.held;
    if (!held) return;
    this.held =
      held.snap?.end === null || !held.snap
        ? {
            ...held,
            heading: (held.heading + direction * QUARTER_TURN_16 + ZETA16_ORDER) % ZETA16_ORDER,
          }
        : { ...held, connector: held.connector + direction };
  }

  nextConnector(): void {
    const held = this.held;
    if (!held) return;
    this.held = { ...held, connector: held.connector + 1 };
  }

  mirror(): string | null {
    const track = this.trackWorld.drawing();
    const held = this.held;
    if (!track || !held) return null;
    const mirror = track.pieceSet.mirrored(held.catalogIndex);
    if (mirror === null) return null;
    this.held = { ...held, catalogIndex: mirror };
    return `${TRACK_PIECE_PREFIX}${track.pieceByIndex(mirror).piece.id}`;
  }

  private paint(track: TrackDrawing): TrackEditView | null {
    const { extension } = track;
    if (extension.version === this.previewVersion) return null;
    this.previewVersion = extension.version;
    this.showTrackGhost(track);
    this.targetTrackEnds(extension.highlighted());
    return this.view();
  }

  private showTrackGhost(track: TrackDrawing): void {
    const ghost = track.ghost();
    this.backend.setGhost(ghost ? ghost.instances : null);
    if (ghost) this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
  }

  private showTrackEnds(targets: ReadonlyArray<number>, misses: ReadonlyArray<number> = []): void {
    const track = this.trackWorld.drawing();
    if (!track) return;
    this.endTarget = `${targets.join(",")}|${misses.join(",")}`;
    const gapped = track.gappedEnds();
    this.backend.setTrackEnds(
      track.openEnds().map((end, index) => ({
        xLdu: end.xLdu,
        yLdu: 0,
        zLdu: end.zLdu,
        headingRadians: end.heading * TRACK_HEADING_RADIANS,
        kind: targets.includes(index)
          ? "target"
          : gapped.has(index) || misses.includes(index)
            ? "gap"
            : "open",
      })),
    );
  }

  private targetTrackEnds(
    targets: ReadonlyArray<number>,
    misses: ReadonlyArray<number> = [],
  ): void {
    if (`${targets.join(",")}|${misses.join(",")}` !== this.endTarget) {
      this.showTrackEnds(targets, misses);
    }
  }

  private trackPieceIndex(track: TrackDrawing, id: string): number | null {
    if (!id.startsWith(TRACK_PIECE_PREFIX)) return null;
    const pieceId = id.slice(TRACK_PIECE_PREFIX.length);
    const kit = track.pieceParts().find((part) => part.piece.id === pieceId);
    return kit ? kit.catalogIndex : null;
  }

  private trackItem(track: TrackDrawing, parts: ReadonlyArray<PartShapeAsset>): CatalogItemView {
    const straight = track.kitParts().find((k) => k.piece.kind === "straight");
    const part = straight ? parts[straight.partIndex] : undefined;
    return {
      id: TRACK_ITEM_ID,
      label: TRACK_ITEM_LABEL,
      shortLabel: TRACK_SHORT_LABEL,
      group: TRACK_ITEM_ID,
      groupLabel: TRACK_ITEM_LABEL,
      color: null,
      kind: "track",
      parts: track.kitParts().length,
      studsWide: part ? Math.round((part.boundsMax[0] - part.boundsMin[0]) / STUD_LDU) : 0,
      studsDeep: part ? Math.round((part.boundsMax[2] - part.boundsMin[2]) / STUD_LDU) : 0,
      thumbnail: null,
      aliases: [],
      elements: [],
      displayColor: false,
      draggable: false,
      toggleable: true,
      listedUnder: null,
      customParts: 0,
    };
  }

  private trackPieceItems(
    track: TrackDrawing,
    parts: ReadonlyArray<PartShapeAsset>,
  ): ReadonlyArray<CatalogItemView> {
    return track.pieceSet.palette().map((catalogIndex) => {
      const kit = track.pieceByIndex(catalogIndex);
      const part = parts[kit.partIndex];
      const { element, title } = track.pieceSet.element(catalogIndex);
      return {
        id: `${TRACK_PIECE_PREFIX}${kit.piece.id}`,
        label: `${element.replace(/^[a-z]+:/u, "")} ${title}`,
        shortLabel: title,
        group: TRACK_PIECE_GROUP,
        groupLabel: TRACK_PIECE_GROUP_LABEL,
        color: null,
        kind: "track",
        parts: 1,
        studsWide: part ? Math.round((part.boundsMax[0] - part.boundsMin[0]) / STUD_LDU) : 0,
        studsDeep: part ? Math.round((part.boundsMax[2] - part.boundsMin[2]) / STUD_LDU) : 0,
        thumbnail: null,
        aliases: [],
        elements: [],
        displayColor: false,
        draggable: false,
        toggleable: true,
        listedUnder: TRACK_ITEM_ID,
        customParts: 0,
      };
    });
  }

  private bomLines(track: TrackDrawing): ReadonlyArray<TrackBomLine> {
    const lines = new Map<string, TrackBomLine>();
    for (const kit of track.pieceParts()) {
      const { element, title } = track.pieceSet.element(kit.catalogIndex);
      const count = track.countOf(kit.catalogIndex);
      const line = lines.get(element);
      lines.set(element, { piece: element, title, count: (line?.count ?? 0) + count });
    }
    return [...lines.values()].filter(
      (line) => line.count > 0 || track.kitParts().some((k) => k.piece.part === line.piece),
    );
  }

  private heldView(track: TrackDrawing): TrackPieceView | null {
    const held = this.held;
    if (!held) return null;
    const kit = track.pieceByIndex(held.catalogIndex);
    const { element, title } = track.pieceSet.element(held.catalogIndex);
    const mirror = track.pieceSet.mirrored(held.catalogIndex);
    const count = kit.def.connectors.length;
    return {
      item: kit.piece.id,
      label: `${element.replace(/^[a-z]+:/u, "")} ${title}`,
      snapped: held.snap?.end !== null && held.snap !== null,
      joins: held.snap?.joins ?? 0,
      misses: held.snap?.misses.length ?? 0,
      connector: ((held.connector % count) + count) % count,
      connectors: count,
      mirror: mirror === null ? null : track.pieceSet.element(mirror).title,
    };
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

  private trackView(): TrackView | null {
    const track = this.trackWorld.drawing();
    if (!track) return null;
    const samples = track.solveSamplesMs.toSorted((a, b) => a - b);
    const at = (q: number): number =>
      samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
    const inModels = this.trackWorld.modelCounts();
    return {
      pieces: track.pieceCount,
      modelPieces: inModels.pieces,
      runFramePieces: inModels.runFrame,
      offField: inModels.offField,
      unanchored: inModels.unanchored,
      bom: this.bomLines(track),
      openEnds: track.openEnds().length,
      joins: track.joinedPairs(),
      coincidentEndIssues: track.coincidentEndIssues(),
      gaps: track.gaps(),
      switches: track.switchLevers(),
      held: this.heldView(track),
      drag: track.dragView(),
      extend: this.held ? null : track.extension.view(),
      lastCommit: this.lastCommit,
      lastBlock: this.lastBlock,
      lastWithheld: this.lastWithheld,
      lastUnsupported: this.lastUnsupported,
      unsupported: this.trackWorld.unsupportedCount(),
      crossings: this.trackWorld.crossings().map((crossing) => this.crossingView(crossing)),
      solve:
        samples.length === 0
          ? null
          : {
              samples: samples.length,
              medianMs: at(0.5),
              p95Ms: at(P95),
              maxMs: samples.at(-1) ?? 0,
            },
    };
  }
}
