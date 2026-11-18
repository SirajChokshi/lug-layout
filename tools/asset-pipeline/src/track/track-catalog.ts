import {
  decodeZeta16,
  encodeZeta16,
  type PieceKind,
  type PoseStatus,
  type TrackEnd,
  type TrackPathSegment,
  type TrackCatalog,
  type TrackPiece,
  type TrackSystem,
} from "@brr/schema/bundle";
import type * as v from "valibot";
import {
  addExactRational,
  compareExactRational,
  conjugateZeta16,
  exactRationalFromDecimal,
  exactRationalFromFloat64,
  exactRationalToFloat64,
  formatExactDecimal,
  formatExactRational,
  HALF_TURN_16,
  multiplyExactRational,
  normalizeHeading16,
  rotateZeta16,
  subtractExactRational,
  subtractZeta16,
  ZETA16_ORDER,
  ZETA16_ZERO,
  zeta16,
  zeta16Direction,
  zeta16ToStuds,
  type ExactDecimalText,
  type ExactRational,
  type ExactRationalText,
  type Zeta16,
} from "@brr/math";
import { exactPlacements, type ExactPlacement } from "../ldraw/exact-walk.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { metaValues } from "../ldraw/parse.ts";
import {
  flatPolygons,
  railHeadsAtEnd,
  railSection,
  scanEndAt,
  type PlanPoint,
  type ScanEnd,
} from "./rail-heads.ts";
import {
  findTrackEnds,
  LDU_PER_STUD,
  PART_FRAME_HEADING_GRID,
  relativeToEntry,
  type MarkerEnd,
  type TrackEndMarker,
} from "./track-ends.ts";
import { fitRoutePath, type FittedPath, type RoutePose } from "./track-paths.ts";

const STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEPS_PER_TURN = 2 * ZETA16_ORDER;
const HELP_ROTATION_POINT = /rotation point is at (\S+)\/(\S+)\/(\S+)/i;
const SYSTEM_BY_TITLE: ReadonlyArray<readonly [RegExp, TrackSystem]> = [
  [/\b9V\b/u, "lego-9v"],
  [/\b6 Studs Wide\b/u, "lego-plastic"],
];
const ROUTE_HEADING_DIFFERENCES: ReadonlySet<number> = new Set([
  HALF_TURN_16 - 1,
  HALF_TURN_16,
  HALF_TURN_16 + 1,
]);

interface ExactEnd {
  readonly position: Zeta16;
  readonly heading: number;
  readonly status: PoseStatus;
  readonly derivation: string;
  readonly residualLdu: number;
}

export interface ConnectorCheck {
  readonly connector: number;
  readonly marker: string;
  readonly derivation: string;
  readonly markerResidualLdu: number;
  readonly railCentreOffsetLdu: ExactRationalText | null;
  readonly railHalfSpacingLdu: ExactRationalText | null;
}

export interface RouteCheck {
  readonly from: number;
  readonly to: number;
  readonly family: FittedPath["family"];
  readonly railCoverage: FittedPath["railCoverage"];
  readonly rejected: FittedPath["rejected"];
}

export interface PieceChecks {
  readonly id: string;
  readonly railTopY: ExactDecimalText;
  readonly connectors: ReadonlyArray<ConnectorCheck>;
  readonly routes: ReadonlyArray<RouteCheck>;
}

export interface TrackCatalogReport {
  readonly frame: string;
  readonly n: v.InferInput<typeof TrackCatalog>["n"];
  readonly pieces: v.InferInput<typeof TrackCatalog>["pieces"];
  readonly checks: ReadonlyArray<PieceChecks>;
}

const BUNDLE_PART_PREFIX = "ldraw:";

export function bundlePartId(part: string): string {
  return `${BUNDLE_PART_PREFIX}${part}`;
}

export function ldrawPartOf(bundleId: string): string {
  if (!bundleId.startsWith(BUNDLE_PART_PREFIX))
    throw new Error(`${bundleId} is not an LDraw part id`);
  return bundleId.slice(BUNDLE_PART_PREFIX.length);
}

function unit(steps: number): Zeta16 {
  return rotateZeta16(zeta16([1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), steps);
}

function scale(value: Zeta16, factor: bigint): Zeta16 {
  return zeta16(value.map((coefficient) => coefficient * factor));
}

function residualLdu(position: Zeta16, end: TrackEnd): number {
  const exact = zeta16ToStuds(position);
  return Math.hypot(exact.x - end.xStuds, exact.z - end.zStuds) * LDU_PER_STUD;
}

function signedTurn(heading: number): number {
  return heading > HALF_TURN_16 ? heading - ZETA16_ORDER : heading;
}

function helpRotationPoint(library: LdrawLibrary, part: string): PlanPoint | null {
  const file = library.load(`${part}.dat`);
  for (const line of file === undefined ? [] : metaValues(file, "!HELP")) {
    const match = HELP_ROTATION_POINT.exec(line);
    if (match !== null) return { x: Number(match[1]), z: Number(match[3]) };
  }
  return null;
}

function arcFromHelp(
  library: LdrawLibrary,
  part: string,
  ends: ReadonlyArray<MarkerEnd>,
  exit: TrackEnd,
): ExactEnd | null {
  const pivot = helpRotationPoint(library, part);
  const turn = signedTurn(exit.headingSteps);
  if (pivot === null || ends.length !== 2 || Math.abs(turn) !== 1) return null;
  const distances = ends.map((end) => Math.hypot(end.x - pivot.x, end.z - pivot.z));
  const radiusStuds = Math.round((distances[0] ?? 0) / LDU_PER_STUD);
  const fits = distances.every(
    (distance, index) =>
      Math.abs(distance - radiusStuds * LDU_PER_STUD) <= (ends[index]?.toleranceLdu ?? 0),
  );
  if (!fits) return null;
  const quarter = ZETA16_ORDER / 4;
  const chord = subtractZeta16(unit(quarter), unit(quarter + turn));
  const position = scale(chord, BigInt(turn * radiusStuds));
  return {
    position,
    heading: exit.headingSteps,
    status: "unverified",
    derivation: `arc: radius ${radiusStuds} studs from the file's !HELP rotation point (${pivot.x}/${pivot.z}), turn ${turn} step from the end markers; not certified (no unique field candidate within the file's precision)`,
    residualLdu: residualLdu(position, exit),
  };
}

function exactEnd(
  library: LdrawLibrary,
  part: string,
  ends: ReadonlyArray<MarkerEnd>,
  end: TrackEnd,
  index: number,
): ExactEnd {
  if (end.fieldCertified && end.coefficients !== null) {
    const position = decodeZeta16(end.coefficients);
    return {
      position,
      heading: end.headingSteps,
      status: "certified",
      derivation: "field test: unique ℤ[ζ₁₆] candidate, residual ≤ 0.0005 LDU",
      residualLdu: residualLdu(position, end),
    };
  }
  if (index === 0) {
    return {
      position: ZETA16_ZERO,
      heading: end.headingSteps,
      status: "unverified",
      derivation: "reference end",
      residualLdu: 0,
    };
  }
  const derived = arcFromHelp(library, part, ends, end);
  if (derived === null) {
    throw new Error(
      `${part}: track end ${index} (${end.marker}) has no certified or derivable pose`,
    );
  }
  return derived;
}

function headingDifference(a: number, b: number): number {
  return normalizeHeading16(a - b);
}

function orderConnectors(ends: ReadonlyArray<ExactEnd>): ReadonlyArray<number> {
  const [, ...others] = ends.map((_end, index) => index);
  const entry = ends[0];
  if (entry === undefined) return [];
  const opposite = others.filter(
    (index) => headingDifference(ends[index]?.heading ?? 0, entry.heading) === HALF_TURN_16,
  );
  const rest = others.filter((index) => !opposite.includes(index));
  return [0, ...opposite, ...rest];
}

function routesOf(ends: ReadonlyArray<ExactEnd>): ReadonlyArray<readonly [number, number]> {
  const pairs: Array<readonly [number, number]> = [];
  ends.forEach((a, i) => {
    ends.forEach((b, j) => {
      if (j > i && ROUTE_HEADING_DIFFERENCES.has(headingDifference(a.heading, b.heading))) {
        pairs.push([i, j]);
      }
    });
  });
  return pairs;
}

function kindOf(
  part: string,
  ends: ReadonlyArray<ExactEnd>,
  routes: ReadonlyArray<readonly [number, number]>,
): PieceKind {
  const shape = routes.map(([a, b]) => `${a}-${b}`).join(",");
  const exit = ends[1];
  if (ends.length === 2 && shape === "0-1" && exit !== undefined) {
    return exit.heading === 0 ? "straight" : "curve";
  }
  if (ends.length === 3 && shape === "0-1,0-2") return "switch";
  if (ends.length === 4 && shape === "0-1,2-3") return "crossing";
  throw new Error(`${part}: ${ends.length} ends with routes ${shape} match no track piece kind`);
}

function systemOf(part: string, title: string): TrackSystem {
  const match = SYSTEM_BY_TITLE.find(([pattern]) => pattern.test(title));
  if (match === undefined) throw new Error(`${part}: title "${title}" names no known track system`);
  return match[1];
}

interface EntryFrame {
  readonly origin: PlanPoint;
  readonly inward: number;
}

function entryFrame(entry: MarkerEnd): EntryFrame {
  const inward =
    Math.round((entry.outward + Math.PI) / PART_FRAME_HEADING_GRID) * PART_FRAME_HEADING_GRID;
  return { origin: { x: entry.x, z: entry.z }, inward };
}

function toPartFrame(frame: EntryFrame, point: PlanPoint): PlanPoint {
  const cos = Math.cos(frame.inward);
  const sin = Math.sin(frame.inward);
  return {
    x: frame.origin.x + point.x * cos - point.z * sin,
    z: frame.origin.z + point.x * sin + point.z * cos,
  };
}

function poseInEntryFrame(end: ExactEnd): RoutePose {
  const studs = zeta16ToStuds(end.position);
  return {
    x: studs.x * LDU_PER_STUD,
    z: studs.z * LDU_PER_STUD,
    heading: end.heading * STEP_RADIANS,
  };
}

function mirrorSegment(segment: TrackPathSegment): TrackPathSegment {
  return segment.kind === "straight"
    ? segment
    : { ...segment, sweepRadians: -segment.sweepRadians };
}

function halfStepRotation(halfSteps: number): { readonly cos: number; readonly sin: number } {
  const whole = zeta16Direction(Math.floor(halfSteps / 2));
  if (halfSteps % 2 === 0) return { cos: whole.x, sin: whole.z };
  const cosHalf = Math.cos(PART_FRAME_HEADING_GRID);
  const sinHalf = Math.sin(PART_FRAME_HEADING_GRID);
  return {
    cos: whole.x * cosHalf - whole.z * sinHalf,
    sin: whole.z * cosHalf + whole.x * sinHalf,
  };
}

function partFrameInBundle(frame: EntryFrame): v.InferInput<typeof TrackPiece>["partFrame"] {
  const rounded = Math.round(frame.inward / PART_FRAME_HEADING_GRID);
  const halfSteps = ((rounded % HALF_STEPS_PER_TURN) + HALF_STEPS_PER_TURN) % HALF_STEPS_PER_TURN;
  const { cos, sin } = halfStepRotation(HALF_STEPS_PER_TURN - halfSteps);
  const x = -frame.origin.x * cos + frame.origin.z * sin;
  const z = -frame.origin.x * sin - frame.origin.z * cos;
  return { xLdu: x, zLdu: -z, headingHalfSteps: halfSteps };
}

function squaredPlanDistance(placement: ExactPlacement, point: PlanPoint): ExactRational {
  const [x, , z] = placement.origin;
  const dx = subtractExactRational(exactRationalFromDecimal(x), exactRationalFromFloat64(point.x));
  const dz = subtractExactRational(exactRationalFromDecimal(z), exactRationalFromFloat64(point.z));
  return addExactRational(multiplyExactRational(dx, dx), multiplyExactRational(dz, dz));
}

function nearestEndSleeper(
  endSleepers: ReadonlyArray<ExactPlacement>,
  point: PlanPoint,
): ExactPlacement {
  const [first, ...rest] = endSleepers;
  if (first === undefined) throw new Error("a track part has no end sleepers");
  return rest.reduce(
    (nearest, candidate) =>
      compareExactRational(
        squaredPlanDistance(candidate, point),
        squaredPlanDistance(nearest, point),
      ) < 0
        ? candidate
        : nearest,
    first,
  );
}

function endInPart(
  frame: EntryFrame,
  end: ExactEnd,
  endSleepers: ReadonlyArray<ExactPlacement>,
): ScanEnd {
  const pose = poseInEntryFrame(end);
  const origin = toPartFrame(frame, pose);
  const heading = pose.heading + Math.PI + frame.inward;
  return scanEndAt(origin, heading, nearestEndSleeper(endSleepers, origin));
}

function exactRationalText(value: ExactRational | undefined): ExactRationalText | null {
  return value === undefined ? null : formatExactRational(value);
}

export function buildTrackPiece(
  library: LdrawLibrary,
  part: string,
  markers: ReadonlyArray<TrackEndMarker>,
): { readonly piece: v.InferInput<typeof TrackPiece>; readonly checks: PieceChecks } {
  const ends = findTrackEnds(library, part, markers);
  const relative = relativeToEntry(ends);
  const measured = relative.map((end, index) => exactEnd(library, part, ends, end, index));
  const order = orderConnectors(measured);
  const ordered = order.map((index) => {
    const end = measured[index];
    if (end === undefined) throw new Error(`${part}: lost track end ${index}`);
    return end;
  });
  const routes = routesOf(ordered);
  const kind = kindOf(part, ordered, routes);
  const title = library.load(`${part}.dat`)?.header.title ?? "";
  const firstEnd = ends[0];
  if (firstEnd === undefined) throw new Error(`${part}: no track ends`);
  const frame = entryFrame(firstEnd);
  const endSleepers = exactPlacements(library, part, new Set(markers.map((marker) => marker.file)));
  const scanEnds = ordered.map((end) => endInPart(frame, end, endSleepers));
  const [referenceScan] = scanEnds;
  if (referenceScan === undefined) throw new Error(`${part}: no reference end`);
  const heads = railHeadsAtEnd(flatPolygons(library, part), referenceScan);
  if (heads === null) throw new Error(`${part}: no rail pair at the reference end`);
  const sections = scanEnds.map((scan) => railSection(heads, scan));
  const referenceSection = sections[0];
  if (!referenceSection) throw new Error(`${part}: no rail pair at the reference end`);
  const halfSpacing = exactRationalToFloat64(referenceSection.railHalfSpacingLdu);
  const fitted = routes.map(([from, to]) => {
    const start = ordered[from];
    const finish = ordered[to];
    if (start === undefined || finish === undefined) throw new Error(`${part}: bad route`);
    const startPose = poseInEntryFrame(start);
    return {
      from,
      to,
      path: fitRoutePath(
        heads,
        (point) => toPartFrame(frame, point),
        { ...startPose, heading: startPose.heading + Math.PI },
        poseInEntryFrame(finish),
        halfSpacing,
        `${part} route ${from}→${to}`,
      ),
    };
  });
  const status: PoseStatus = ordered.every(
    (end, index) => index === 0 || end.status === "certified",
  )
    ? "certified"
    : "unverified";
  const piece: v.InferInput<typeof TrackPiece> = {
    id: bundlePartId(part),
    part: bundlePartId(part),
    title,
    kind,
    system: systemOf(part, title),
    joinClass: "lego-train",
    status,
    connectors: ordered.map((end, index) => ({
      coefficients: encodeZeta16(conjugateZeta16(end.position)),
      heading: normalizeHeading16(-end.heading),
      status: index === 0 ? status : end.status,
      residualLdu: end.residualLdu,
    })),
    routes: fitted.map(({ from, to, path }) => ({
      from,
      to,
      lengthLdu: path.lengthLdu,
      segments: path.segments.map(mirrorSegment),
    })),
    partFrame: partFrameInBundle(frame),
  };
  const checks: PieceChecks = {
    id: piece.id,
    railTopY: formatExactDecimal(heads.topY),
    connectors: order.map((index, connector) => ({
      connector,
      marker: relative[index]?.marker ?? "",
      derivation: ordered[connector]?.derivation ?? "",
      markerResidualLdu: ordered[connector]?.residualLdu ?? Number.NaN,
      railCentreOffsetLdu: exactRationalText(sections[connector]?.railCentreOffsetLdu),
      railHalfSpacingLdu: exactRationalText(sections[connector]?.railHalfSpacingLdu),
    })),
    routes: fitted.map(({ from, to, path }) => ({
      from,
      to,
      family: path.family,
      railCoverage: path.railCoverage,
      rejected: path.rejected,
    })),
  };
  return { piece, checks };
}

export function buildTrackCatalog(
  library: LdrawLibrary,
  parts: ReadonlyArray<string>,
  markers: ReadonlyArray<TrackEndMarker>,
): TrackCatalogReport {
  const built = parts.map((part) => buildTrackPiece(library, part, markers));
  return {
    frame: "bundle +Y up (z = −z_LDraw); x → Re, z → Im; connector 0 at the origin facing −x",
    n: ZETA16_ORDER,
    pieces: built.map(({ piece }) => piece),
    checks: built.map(({ checks }) => checks),
  };
}
