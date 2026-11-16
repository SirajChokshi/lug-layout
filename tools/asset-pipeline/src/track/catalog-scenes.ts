import {
  attachPose16,
  composePose16,
  HALF_TURN_16,
  pose16,
  POSE16_IDENTITY,
  posesJoin16,
  ZETA16_ORDER,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { applyToPoint, type Affine } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { INHERIT_COLOR } from "../ldraw/walk.ts";
import { bundlePartId, ldrawPartOf, type CatalogPiece } from "./track-catalog.ts";
import { findTrackEnds, LDU_PER_STUD, type TrackEndMarker } from "./track-ends.ts";

const DECIMALS = 6;
const SCENE_AUTHOR = "Brick Railroad tools/asset-pipeline (cli.ts facts)";
const STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = STEP_RADIANS / 2;

export interface ChainStep {
  readonly part: string;
  readonly via: number;
  readonly onto?: { readonly placement: number; readonly connector: number };
  readonly next?: number;
}

export interface LayoutSpec {
  readonly name: string;
  readonly title: string;
  readonly steps: ReadonlyArray<ChainStep>;
}

interface Placed {
  readonly piece: CatalogPiece;
  readonly pose: Pose16;
}

export interface LayoutCheck {
  readonly name: string;
  readonly status: CatalogPiece["status"];
  readonly unverifiedPieces: ReadonlyArray<string>;
  readonly pieces: number;
  readonly connectors: number;
  readonly exactJoins: number;
  readonly openEnds: number;
  readonly measuredJoinGapsLdu: { readonly max: number; readonly mean: number };
  readonly measuredHeadingErrorDegreesMax: number;
}

export interface CatalogScene {
  readonly ldraw: string;
  readonly check: LayoutCheck;
}

function pieceFor(pieces: ReadonlyArray<CatalogPiece>, part: string): CatalogPiece {
  const piece = pieces.find((candidate) => candidate.part === bundlePartId(part));
  if (piece === undefined)
    throw new Error(`layout uses ${part}, which is not in the track catalog`);
  return piece;
}

function connectorPose(piece: CatalogPiece, index: number): Pose16 {
  const connector = piece.connectors[index];
  if (connector === undefined) throw new Error(`${piece.id} has no connector ${index}`);
  return pose16(connector.coefficients, connector.heading);
}

function worldConnector(placed: Placed, index: number): Pose16 {
  return composePose16(placed.pose, connectorPose(placed.piece, index));
}

function place(pieces: ReadonlyArray<CatalogPiece>, spec: LayoutSpec): ReadonlyArray<Placed> {
  const placed: Placed[] = [];
  let tip: { placement: number; connector: number } | null = null;
  for (const step of spec.steps) {
    const piece = pieceFor(pieces, step.part);
    const target = step.onto ?? tip;
    let pose = POSE16_IDENTITY;
    if (target !== null) {
      const anchor = placed[target.placement];
      if (anchor === undefined) throw new Error(`${spec.name}: no placement ${target.placement}`);
      pose = attachPose16(connectorPose(piece, step.via), worldConnector(anchor, target.connector));
    }
    placed.push({ piece, pose });
    tip = step.next === undefined ? null : { placement: placed.length - 1, connector: step.next };
  }
  return placed;
}

function countJoins(placed: ReadonlyArray<Placed>): { joins: number; open: number; total: number } {
  const ends = placed.flatMap((item) =>
    item.piece.connectors.map((_connector, index) => worldConnector(item, index)),
  );
  const joined = ends.map((end, i) => ends.some((other, j) => i !== j && posesJoin16(end, other)));
  const joins = joined.filter(Boolean).length;
  return { joins: joins / 2, open: ends.length - joins, total: ends.length };
}

function rotationY(angle: number): ReadonlyArray<number> {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos, 0, -sin, 0, 1, 0, sin, 0, cos];
}

export function ldrawPlacement(item: Placed): Affine {
  const origin = zeta16ToStuds(item.pose.position);
  const rotation = item.pose.heading * STEP_RADIANS;
  const { xLdu, zLdu, headingHalfSteps } = item.piece.partFrame;
  const x = origin.x * LDU_PER_STUD + xLdu * Math.cos(rotation) - zLdu * Math.sin(rotation);
  const z = origin.z * LDU_PER_STUD + xLdu * Math.sin(rotation) + zLdu * Math.cos(rotation);
  const [a = 1, b = 0, c = 0, d = 0, e = 1, f = 0, g = 0, h = 0, i = 1] = rotationY(
    -(rotation + headingHalfSteps * HALF_STEP_RADIANS),
  );
  return [a, b, c, d, e, f, g, h, i, x, 0, -z];
}

function roundedAffine(transform: Affine): Affine {
  const [a, b, c, d, e, f, g, h, i, x, y, z] = transform.map((value) =>
    Number(formatNumber(value)),
  );
  return [
    a ?? 1,
    b ?? 0,
    c ?? 0,
    d ?? 0,
    e ?? 1,
    f ?? 0,
    g ?? 0,
    h ?? 0,
    i ?? 1,
    x ?? 0,
    y ?? 0,
    z ?? 0,
  ];
}

function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(DECIMALS));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function toLdraw(spec: LayoutSpec, placements: ReadonlyArray<readonly [string, Affine]>): string {
  return [
    `0 ${spec.title}`,
    `0 Name: ${spec.name}.ldr`,
    `0 Author: ${SCENE_AUTHOR}, placed from the track catalog's exact ℤ[ζ₁₆] connector poses`,
    ...placements.map(([part, [a, b, c, d, e, f, g, h, i, x, y, z]]) =>
      [1, INHERIT_COLOR, x, y, z, a, b, c, d, e, f, g, h, i]
        .map((value) => formatNumber(value))
        .concat(`${part}.dat`)
        .join(" "),
    ),
    "",
  ].join("\n");
}

function measuredGaps(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
  placements: ReadonlyArray<readonly [string, Affine]>,
): { gaps: ReadonlyArray<number>; headingErrors: ReadonlyArray<number> } {
  const ends = placements.flatMap(([part, transform]) =>
    findTrackEnds(library, part, markers).map((end) => {
      const [x, , z] = applyToPoint(transform, [end.x, 0, end.z]);
      const [a, , c, , , , g, , i] = transform;
      const dx = a * Math.cos(end.outward) + c * Math.sin(end.outward);
      const dz = g * Math.cos(end.outward) + i * Math.sin(end.outward);
      return { x, z, outward: Math.atan2(dz, dx) };
    }),
  );
  const gaps: number[] = [];
  const headingErrors: number[] = [];
  ends.forEach((end, index) => {
    const nearest = ends
      .filter((_other, j) => j !== index)
      .toSorted(
        (p, q) => Math.hypot(p.x - end.x, p.z - end.z) - Math.hypot(q.x - end.x, q.z - end.z),
      )[0];
    if (nearest === undefined) return;
    gaps.push(Math.hypot(nearest.x - end.x, nearest.z - end.z));
    const opposed = Math.atan2(
      Math.sin(nearest.outward - end.outward - Math.PI),
      Math.cos(nearest.outward - end.outward - Math.PI),
    );
    headingErrors.push(Math.abs((opposed * 180) / Math.PI));
  });
  return { gaps, headingErrors };
}

export function catalogScene(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
  pieces: ReadonlyArray<CatalogPiece>,
  spec: LayoutSpec,
): CatalogScene {
  const placed = place(pieces, spec);
  const { joins, open, total } = countJoins(placed);
  if (open !== 0)
    throw new Error(`${spec.name}: ${open} connectors are open; the layout does not close exactly`);
  const placements = placed.map(
    (item) => [ldrawPartOf(item.piece.part), roundedAffine(ldrawPlacement(item))] as const,
  );
  const { gaps, headingErrors } = measuredGaps(library, markers, placements);
  const unverifiedPieces = [
    ...new Set(
      placed.filter((item) => item.piece.status !== "certified").map((item) => item.piece.id),
    ),
  ];
  return {
    ldraw: toLdraw(spec, placements),
    check: {
      name: spec.name,
      status: unverifiedPieces.length === 0 ? "certified" : "unverified",
      unverifiedPieces,
      pieces: placed.length,
      connectors: total,
      exactJoins: joins,
      openEnds: open,
      measuredJoinGapsLdu: {
        max: Math.max(...gaps),
        mean: gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length,
      },
      measuredHeadingErrorDegreesMax: Math.max(...headingErrors),
    },
  };
}

function repeat(count: number, step: ChainStep): ReadonlyArray<ChainStep> {
  return Array.from({ length: count }, () => step);
}

const STRAIGHT_9V = "74746";
const CURVE_9V = "74747";
const RIGHT_SWITCH = "75541-f2";
const LEFT_SWITCH = "75542-f2";
const CROSSING = "32087";
const STRAIGHT_PLASTIC = "53401";
const CURVE_PLASTIC = "53400";
const HALF_CIRCLE_CURVES = HALF_TURN_16;
const THREE_QUARTER_CIRCLE_CURVES = (3 * ZETA16_ORDER) / 4;

export const CATALOG_LAYOUTS: ReadonlyArray<LayoutSpec> = [
  {
    name: "passing-loop",
    title: "Passing Loop",
    steps: [
      { part: RIGHT_SWITCH, via: 0, next: 1 },
      ...repeat(4, { part: STRAIGHT_9V, via: 0, next: 1 }),
      { part: LEFT_SWITCH, via: 1, next: 0 },
      ...repeat(HALF_CIRCLE_CURVES, { part: CURVE_9V, via: 0, next: 1 }),
      ...repeat(8, { part: STRAIGHT_9V, via: 0, next: 1 }),
      ...repeat(HALF_CIRCLE_CURVES, { part: CURVE_9V, via: 0, next: 1 }),
      { part: CURVE_9V, via: 1, onto: { placement: 0, connector: 2 }, next: 0 },
      ...repeat(2, { part: STRAIGHT_9V, via: 0, next: 1 }),
      { part: CURVE_9V, via: 1 },
    ],
  },
  {
    name: "figure-eight",
    title: "Figure Eight",
    steps: [
      { part: CROSSING, via: 0, next: 1 },
      ...repeat(2, { part: STRAIGHT_9V, via: 0, next: 1 }),
      ...repeat(THREE_QUARTER_CIRCLE_CURVES, { part: CURVE_9V, via: 0, next: 1 }),
      ...repeat(2, { part: STRAIGHT_9V, via: 0, next: 1 }),
      { part: STRAIGHT_9V, via: 0, onto: { placement: 0, connector: 0 }, next: 1 },
      { part: STRAIGHT_9V, via: 0, next: 1 },
      ...repeat(THREE_QUARTER_CIRCLE_CURVES, { part: CURVE_9V, via: 0, next: 1 }),
      ...repeat(2, { part: STRAIGHT_9V, via: 0, next: 1 }),
    ],
  },
  {
    name: "plastic-oval",
    title: "Plastic Oval",
    steps: [
      ...repeat(4, { part: STRAIGHT_PLASTIC, via: 0, next: 1 }),
      ...repeat(HALF_CIRCLE_CURVES, { part: CURVE_PLASTIC, via: 0, next: 1 }),
      ...repeat(4, { part: STRAIGHT_PLASTIC, via: 0, next: 1 }),
      ...repeat(HALF_CIRCLE_CURVES, { part: CURVE_PLASTIC, via: 0, next: 1 }),
    ],
  },
];
