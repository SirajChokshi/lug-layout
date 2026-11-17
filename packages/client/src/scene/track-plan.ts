import type { TrackCatalog, TrackPiece } from "@brr/schema/bundle";
import { TrackLayout, type TrackEndRef, type TrackPieceSpec } from "@brr/domain";
import { HALF_TURN_16, pose16, POSE16_IDENTITY, type Pose16 } from "@brr/math";

const PIECE_TOKEN = /^(?<part>[0-9a-z:-]+)(?:\.(?<connector>\d+))?(?:\*(?<count>\d+))?$/u;
const BRANCH_TOKEN = "/";
const GROUND_PLATES = 0;

export interface TrackPlanLayout {
  readonly layout: TrackLayout;
  readonly catalogPieces: ReadonlyArray<TrackPiece>;
}

function pieceSpec(piece: TrackPiece): TrackPieceSpec {
  return {
    connectors: piece.connectors.map((connector) => connector.pose),
    routes: piece.routes,
  };
}

function endKey(pose: Pose16, yPlates: number): string {
  return `${yPlates}:${pose.position.join(",")}`;
}

class PlanCursor {
  private cursor: TrackEndRef | undefined;
  private readonly setAside: TrackEndRef[] = [];
  private readonly endsAt = new Map<string, number>();

  constructor(private readonly layout: TrackLayout) {}

  continueFrom(): TrackEndRef | undefined {
    return this.cursor;
  }

  isOpen(end: TrackEndRef): boolean {
    return this.endsAt.get(this.key(end)) === 1;
  }

  entered(placement: number, connector: number, entryIsOpen: boolean): void {
    const spec = this.layout.pieces[this.layout.piece(placement)];
    if (!spec) throw new Error(`placement ${placement} has no piece`);
    const route = spec.routes.find(({ from, to }) => from === connector || to === connector);
    const onward =
      route === undefined ? undefined : route.from === connector ? route.to : route.from;
    for (let c = 0; c < spec.connectors.length; c++) {
      const key = this.key({ placement, connector: c });
      this.endsAt.set(key, (this.endsAt.get(key) ?? 0) + 1);
      if ((c !== connector || entryIsOpen) && c !== onward) {
        this.setAside.push({ placement, connector: c });
      }
    }
    this.cursor = onward === undefined ? undefined : { placement, connector: onward };
  }

  branch(): void {
    let next = this.setAside.pop();
    while (next !== undefined && !this.isOpen(next)) next = this.setAside.pop();
    if (next === undefined)
      throw new Error("track plan: '/' has no open end left to continue from");
    this.cursor = next;
  }

  private key(end: TrackEndRef): string {
    return endKey(
      this.layout.connectorPose(end.placement, end.connector),
      this.layout.yPlates(end.placement),
    );
  }
}

export function buildTrackPlan(plan: string, catalog: TrackCatalog): TrackPlanLayout {
  const catalogPieces = catalog.pieces;
  const pieceIndex = new Map(catalogPieces.map((piece, index) => [piece.part, index]));
  const layout = new TrackLayout(catalogPieces.map(pieceSpec));
  const cursor = new PlanCursor(layout);
  const tokens = plan
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) throw new Error("track plan is empty");
  for (const token of tokens) {
    if (token === BRANCH_TOKEN) {
      cursor.branch();
      continue;
    }
    const groups = PIECE_TOKEN.exec(token)?.groups;
    const part = groups?.["part"];
    const piece = part === undefined ? undefined : pieceIndex.get(part);
    if (groups === undefined || part === undefined || piece === undefined) {
      throw new Error(
        `track plan: "${token}" is not a catalog track part (${[...pieceIndex.keys()].join(", ")})`,
      );
    }
    const connector = Number(groups["connector"] ?? 0);
    const count = Number(groups["count"] ?? 1);
    if ((catalogPieces[piece]?.connectors.length ?? 0) <= connector) {
      throw new Error(`track plan: ${part} has no connector ${connector}`);
    }
    for (let repeat = 0; repeat < count; repeat++) {
      const target = cursor.continueFrom();
      let placement: number;
      const first = layout.count === 0;
      if (first) {
        const entry = layout.pieces[piece]?.connectors[connector] ?? POSE16_IDENTITY;
        placement = layout.place(
          piece,
          pose16(POSE16_IDENTITY.position, HALF_TURN_16 - entry.heading),
          GROUND_PLATES,
        );
      } else {
        if (target === undefined)
          throw new Error(`track plan: "${token}" has no open end to attach to`);
        if (!cursor.isOpen(target)) {
          throw new Error(`track plan: "${token}" would attach to an end that is already joined`);
        }
        placement = layout.attach(piece, connector, target);
      }
      cursor.entered(placement, connector, first);
    }
  }
  return { layout, catalogPieces };
}
