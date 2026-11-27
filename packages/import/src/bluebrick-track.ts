import { connectorPose, type TrackPieceDef } from "@brr/domain";
import {
  HALF_TURN_16,
  QUARTER_TURN_16,
  STUD_LDU,
  ZETA16_ORDER,
  ZETA16_STEP_RADIANS,
  attachPose16,
  normalizeHeading16,
  pose16,
  posesJoin16,
  zeta16,
  zeta16ToStuds,
  type PlaneStuds,
  type Pose16,
} from "@brr/math";
import type {
  BlueBrickBrickRef,
  BlueBrickConnectionRef,
  BlueBrickDecimal,
  BlueBrickMap,
} from "@brr/schema/bluebrick";
import type { BundleManifest } from "@brr/schema/bundle";
import type { BlueBrickIdMapping } from "./bluebrick-mapping.ts";
import { bundlePartId } from "./model-import.ts";

export interface BlueBrickTrackPiece {
  readonly brick: BlueBrickBrickRef;
  readonly catalogIndex: number;
  readonly placement: Pose16;
  readonly shiftStuds: number;
}

export interface BlueBrickTrackComponent {
  readonly pieces: ReadonlyArray<BlueBrickTrackPiece>;
  readonly turnDegrees: number;
  readonly shiftStuds: number;
}

export type BlueBrickTrackIssue =
  | {
      readonly kind: "unpaired" | "ambiguous";
      readonly from: BlueBrickConnectionRef;
      readonly to: BlueBrickConnectionRef;
    }
  | {
      readonly kind: "notClosing";
      readonly from: BlueBrickConnectionRef;
      readonly to: BlueBrickConnectionRef;
      readonly gapStuds: number;
    }
  | {
      readonly kind: "altitude";
      readonly brick: BlueBrickBrickRef;
      readonly altitude: BlueBrickDecimal;
    };

export interface BlueBrickTrack {
  readonly components: ReadonlyArray<BlueBrickTrackComponent>;
  readonly issues: ReadonlyArray<BlueBrickTrackIssue>;
}

interface PieceGeometry {
  readonly catalogIndex: number;
  readonly piece: TrackPieceDef;
  readonly hull: ReadonlyArray<PlaneStuds>;
}

interface TrackBrick extends PieceGeometry {
  readonly brick: BlueBrickBrickRef;
  readonly altitude: BlueBrickDecimal;
  readonly centre: PlaneStuds;
  readonly steps: number;
}

interface Link {
  readonly from: BlueBrickConnectionRef;
  readonly to: BlueBrickConnectionRef;
  readonly a: number;
  readonly b: number;
}

interface Edge {
  readonly end: number;
  readonly other: number;
  readonly otherEnd: number;
  readonly link: number;
}

type Pairing = readonly [number, number] | "unpaired" | "ambiguous";

type BundleTrack = Pick<BundleManifest, "trackCatalog" | "trackShapes">;

const DEGREES_PER_STEP = 360 / ZETA16_ORDER;
const FLAT: BlueBrickDecimal = "0";

function key(first: number, second: number): string {
  return `${first}:${second}`;
}

function precedes(a: BlueBrickConnectionRef, b: BlueBrickConnectionRef): boolean {
  return (a.layer - b.layer || a.brick - b.brick || a.connection - b.connection) < 0;
}

function rotated(point: PlaneStuds, steps: number): PlaneStuds {
  const cos = Math.cos(steps * ZETA16_STEP_RADIANS);
  const sin = Math.sin(steps * ZETA16_STEP_RADIANS);
  return { x: cos * point.x - sin * point.z, z: sin * point.x + cos * point.z };
}

function boxCentre(hull: ReadonlyArray<PlaneStuds>, steps: number): PlaneStuds {
  const turned = hull.map((point) => rotated(point, steps));
  const xs = turned.map((point) => point.x);
  const zs = turned.map((point) => point.z);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
  };
}

function nearestStep(steps: number): number {
  return normalizeHeading16(Math.round(steps));
}

function distanceStuds(a: PlaneStuds, b: PlaneStuds): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function localEnd(piece: TrackPieceDef, end: number): Pose16 {
  const connector = piece.connectors[end];
  if (!connector) throw new RangeError(`${piece.id} has no connector ${end}`);
  return connector;
}

function pieceGeometries({
  trackCatalog,
  trackShapes,
}: BundleTrack): ReadonlyMap<string, PieceGeometry> {
  const hulls = new Map(trackShapes.map((shape) => [shape.piece, shape.hull]));
  const byPart = new Map<string, PieceGeometry>();
  trackCatalog.pieces.forEach((piece, catalogIndex) => {
    if (byPart.has(piece.part)) return;
    const hull = hulls.get(piece.id);
    if (!hull) throw new Error(`the bundle has no track shape for ${piece.id}`);
    const points: PlaneStuds[] = [];
    for (let i = 0; i + 1 < hull.length; i += 2) {
      points.push({
        x: ((hull[i] ?? 0) + piece.partFrame.xLdu) / STUD_LDU,
        z: ((hull[i + 1] ?? 0) + piece.partFrame.zLdu) / STUD_LDU,
      });
    }
    const connectors = piece.connectors.map((connector) => connector.pose);
    byPart.set(piece.part, { catalogIndex, piece: { id: piece.id, connectors }, hull: points });
  });
  return byPart;
}

function trackBricks(
  map: BlueBrickMap,
  mapping: ReadonlyArray<BlueBrickIdMapping>,
  geometries: ReadonlyMap<string, PieceGeometry>,
): ReadonlyArray<TrackBrick> {
  const outcomes = new Map(mapping.map((entry) => [entry.id, entry.outcome]));
  return map.layers.flatMap((layer, layerIndex) =>
    layer.kind !== "brick"
      ? []
      : layer.bricks.flatMap((brick, brickIndex): TrackBrick[] => {
          const outcome = outcomes.get(brick.part);
          const geometry =
            outcome?.kind === "part" ? geometries.get(bundlePartId(outcome.part)) : undefined;
          if (!geometry) return [];
          const { x, y, width, height } = brick.area;
          return [
            {
              ...geometry,
              brick: { layer: layerIndex, brick: brickIndex },
              altitude: brick.altitude,
              centre: { x: Number(x) + Number(width) / 2, z: Number(y) + Number(height) / 2 },
              steps: Number(brick.orientation) / DEGREES_PER_STEP,
            },
          ];
        }),
  );
}

function trackLinks(map: BlueBrickMap, bricks: ReadonlyArray<TrackBrick>): ReadonlyArray<Link> {
  const index = new Map(bricks.map((brick, i) => [key(brick.brick.layer, brick.brick.brick), i]));
  return map.layers.flatMap((layer, layerIndex) =>
    layer.kind !== "brick"
      ? []
      : layer.bricks.flatMap((brick, brickIndex) =>
          brick.connections.flatMap((connection, connectionIndex): Link[] => {
            const to = connection.link;
            const from = { layer: layerIndex, brick: brickIndex, connection: connectionIndex };
            if (to === null || !precedes(from, to)) return [];
            const a = index.get(key(from.layer, from.brick));
            const b = index.get(key(to.layer, to.brick));
            return a === undefined || b === undefined ? [] : [{ from, to, a, b }];
          }),
        ),
  );
}

function drawnEnds(
  brick: TrackBrick,
): ReadonlyArray<{ readonly at: PlaneStuds; readonly steps: number }> {
  const middle = boxCentre(brick.hull, brick.steps);
  return brick.piece.connectors.map((connector) => {
    const at = rotated(zeta16ToStuds(connector.position), brick.steps);
    return {
      at: { x: brick.centre.x - middle.x + at.x, z: brick.centre.z - middle.z + at.z },
      steps: brick.steps + connector.heading,
    };
  });
}

function nearestEnds(a: TrackBrick, b: TrackBrick): Pairing {
  const theirs = drawnEnds(b);
  const [best, next] = drawnEnds(a)
    .flatMap((end, i) =>
      theirs.map((other, j) => ({
        ends: [i, j] as const,
        distance: distanceStuds(end.at, other.at),
        facing: nearestStep(end.steps - other.steps) === HALF_TURN_16,
      })),
    )
    .toSorted((p, q) => p.distance - q.distance);
  if (!best || next?.distance === best.distance) return "ambiguous";
  return best.facing ? best.ends : "unpaired";
}

function pairedEdges(
  bricks: ReadonlyArray<TrackBrick>,
  links: ReadonlyArray<Link>,
  issues: BlueBrickTrackIssue[],
): ReadonlyArray<ReadonlyArray<Edge>> {
  const pairings = links.map(({ a, b }): Pairing => {
    const first = bricks[a];
    const second = bricks[b];
    return first && second ? nearestEnds(first, second) : "unpaired";
  });
  const claims = new Map<string, number>();
  const claim = (brick: number, end: number): void => {
    claims.set(key(brick, end), (claims.get(key(brick, end)) ?? 0) + 1);
  };
  pairings.forEach((ends, l) => {
    const link = links[l];
    if (typeof ends === "string" || !link) return;
    claim(link.a, ends[0]);
    claim(link.b, ends[1]);
  });
  const claimedOnce = (brick: number, end: number): boolean => claims.get(key(brick, end)) === 1;
  const edges: Edge[][] = bricks.map(() => []);
  pairings.forEach((ends, l) => {
    const link = links[l];
    if (!link) return;
    if (
      typeof ends === "string" ||
      !claimedOnce(link.a, ends[0]) ||
      !claimedOnce(link.b, ends[1])
    ) {
      issues.push({
        kind: typeof ends === "string" ? ends : "ambiguous",
        from: link.from,
        to: link.to,
      });
      return;
    }
    edges[link.a]?.push({ end: ends[0], other: link.b, otherEnd: ends[1], link: l });
    edges[link.b]?.push({ end: ends[1], other: link.a, otherEnd: ends[0], link: l });
  });
  return edges;
}

function anchorPose(brick: TrackBrick): Pose16 {
  const heading = nearestStep(brick.steps);
  const middle = boxCentre(brick.hull, heading);
  const x = BigInt(Math.round(brick.centre.x - middle.x));
  const z = BigInt(Math.round(brick.centre.z - middle.z));
  return pose16(zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]), heading);
}

function laidPiece(brick: TrackBrick, placement: Pose16): BlueBrickTrackPiece {
  const origin = zeta16ToStuds(placement.position);
  const middle = boxCentre(brick.hull, placement.heading);
  return {
    brick: brick.brick,
    catalogIndex: brick.catalogIndex,
    placement,
    shiftStuds: distanceStuds({ x: origin.x + middle.x, z: origin.z + middle.z }, brick.centre),
  };
}

function turnDegrees(brick: TrackBrick, placement: Pose16): number {
  const steps = (placement.heading - brick.steps + HALF_TURN_16) % ZETA16_ORDER;
  return (((steps + ZETA16_ORDER) % ZETA16_ORDER) - HALF_TURN_16) * DEGREES_PER_STEP;
}

export function relayBlueBrickTrack(
  map: BlueBrickMap,
  mapping: ReadonlyArray<BlueBrickIdMapping>,
  bundle: BundleTrack,
): BlueBrickTrack {
  const bricks = trackBricks(map, mapping, pieceGeometries(bundle));
  const issues: BlueBrickTrackIssue[] = bricks
    .filter((brick) => brick.altitude !== FLAT)
    .map(({ brick, altitude }) => ({ kind: "altitude", brick, altitude }));
  const links = trackLinks(map, bricks);
  const edges = pairedEdges(bricks, links, issues);
  const placements: Array<Pose16 | null> = bricks.map(() => null);
  const crossed = new Uint8Array(links.length);

  const lay = (anchor: TrackBrick, at: number): BlueBrickTrackComponent => {
    const anchored = anchorPose(anchor);
    placements[at] = anchored;
    const pieces: BlueBrickTrackPiece[] = [];
    const order = [at];
    for (let q = 0; q < order.length; q++) {
      const i = order[q] ?? at;
      const brick = bricks[i];
      const placement = placements[i];
      if (!brick || !placement) continue;
      pieces.push(laidPiece(brick, placement));
      for (const edge of edges[i] ?? []) {
        const other = bricks[edge.other];
        const link = links[edge.link];
        if (crossed[edge.link] || !other || !link) continue;
        crossed[edge.link] = 1;
        const end = connectorPose({ piece: brick.piece, placement }, edge.end);
        const known = placements[edge.other];
        if (!known) {
          placements[edge.other] = attachPose16(localEnd(other.piece, edge.otherEnd), end);
          order.push(edge.other);
          continue;
        }
        const theirs = connectorPose({ piece: other.piece, placement: known }, edge.otherEnd);
        if (posesJoin16(end, theirs)) continue;
        const gapStuds = distanceStuds(zeta16ToStuds(end.position), zeta16ToStuds(theirs.position));
        issues.push({ kind: "notClosing", from: link.from, to: link.to, gapStuds });
      }
    }
    return {
      pieces,
      turnDegrees: turnDegrees(anchor, anchored),
      shiftStuds: Math.max(...pieces.map((piece) => piece.shiftStuds)),
    };
  };

  const components: BlueBrickTrackComponent[] = [];
  for (const quarterTurnsOnly of [true, false]) {
    bricks.forEach((brick, i) => {
      const quarterTurned = nearestStep(brick.steps) % QUARTER_TURN_16 === 0;
      if (!placements[i] && (quarterTurned || !quarterTurnsOnly)) components.push(lay(brick, i));
    });
  }
  return { components, issues };
}
