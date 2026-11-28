import {
  decodeZeta16,
  encodeZeta16,
  type PieceKind,
  type PoseStatus,
  type TrackEnd,
  type TrackPathSegment,
  type ThirdPartySourceId,
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
  IDENTIFICATION_ACCEPTED_DEVIATION_LDU,
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
import { measureCurve, type CurveMeasurement, type MeasuredEnd } from "./measured-curve.ts";
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
  readonly thirdParty: ReadonlyArray<ThirdPartyTrackReport>;
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
  return Math.max(Math.abs(exact.x - end.xStuds), Math.abs(exact.z - end.zStuds)) * LDU_PER_STUD;
}

function normalizeAngle(angle: number): number {
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}

function normalizedTurn(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
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
      derivation: "field test: unique ℤ[ζ₁₆] candidate, residual ≤ 0.0005 LDU per coordinate",
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

export interface MeasuredCurveSource {
  readonly id: ThirdPartySourceId;
  readonly namespace: string;
  readonly vendor: string;
  readonly library: LdrawLibrary;
  readonly parts: ReadonlyArray<string>;
}

export interface MeasuredCurveReport {
  readonly part: string;
  readonly centreLdu: readonly [number, number] | null;
  readonly cleanRings: number;
  readonly centrelineRadiusLdu: number | null;
  readonly radiusStuds: number | null;
  readonly turnDegrees: number | null;
  readonly endFaceOffsetsLdu: readonly [number, number] | null;
  readonly offered: boolean;
  readonly reason: string;
}

export interface ThirdPartyTrackReport {
  readonly source: string;
  readonly curves: ReadonlyArray<MeasuredCurveReport>;
}

const ROTATION_ENTRY_RESIDUAL = IDENTIFICATION_ACCEPTED_DEVIATION_LDU;
const DEGREES_PER_RADIAN = 180 / Math.PI;

function identifiedSteps(turn: number, stepRadians: number): number | null {
  const steps = Math.round(turn / stepRadians);
  const exact = steps * stepRadians;
  return Math.abs(Math.cos(turn) - Math.cos(exact)) <= ROTATION_ENTRY_RESIDUAL &&
    Math.abs(Math.sin(turn) - Math.sin(exact)) <= ROTATION_ENTRY_RESIDUAL &&
    steps !== 0
    ? steps
    : null;
}

function arcExit(radiusStuds: number, turn: number): Zeta16 {
  const quarter = ZETA16_ORDER / 4;
  return scale(
    subtractZeta16(unit(quarter), unit(quarter + turn)),
    BigInt(Math.sign(turn) * radiusStuds),
  );
}

function radialJoint(curve: CurveMeasurement, end: MeasuredEnd, radiusLdu: number): MarkerEnd {
  return {
    marker: "radial joint plane",
    x: curve.centre.x + radiusLdu * Math.cos(end.radialAngle),
    z: curve.centre.z + radiusLdu * Math.sin(end.radialAngle),
    outward: end.outward,
    toleranceLdu: 0,
  };
}

function inEntryFrame(frame: EntryFrame, point: PlanPoint): PlanPoint {
  const dx = point.x - frame.origin.x;
  const dz = point.z - frame.origin.z;
  const cos = Math.cos(-frame.inward);
  const sin = Math.sin(-frame.inward);
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos };
}

function faceCentre(curve: CurveMeasurement, end: MeasuredEnd, radiusLdu: number): PlanPoint {
  const joint = radialJoint(curve, end, radiusLdu);
  const inward = end.outward + Math.PI;
  return {
    x: joint.x + end.faceOffsetLdu * Math.cos(inward),
    z: joint.z + end.faceOffsetLdu * Math.sin(inward),
  };
}

function exactPlanPointOf(point: PlanPoint): {
  readonly x: ExactRational;
  readonly z: ExactRational;
} {
  return { x: exactRationalFromFloat64(point.x), z: exactRationalFromFloat64(point.z) };
}

function measuredReport(
  part: string,
  curve: CurveMeasurement | null,
  radiusStuds: number | null,
  turn: number | null,
  offered: boolean,
  reason: string,
): MeasuredCurveReport {
  return {
    part,
    centreLdu: curve === null ? null : [curve.centre.x, curve.centre.z],
    cleanRings: curve?.rings ?? 0,
    centrelineRadiusLdu: curve?.centrelineRadiusLdu ?? null,
    radiusStuds,
    turnDegrees: turn === null ? null : turn * DEGREES_PER_RADIAN,
    endFaceOffsetsLdu:
      curve === null ? null : [curve.ends[0].faceOffsetLdu, curve.ends[1].faceOffsetLdu],
    offered,
    reason,
  };
}

interface MeasuredPiece {
  readonly piece: v.InferInput<typeof TrackPiece> | null;
  readonly checks: PieceChecks | null;
  readonly report: MeasuredCurveReport;
}

function skip(report: MeasuredCurveReport): MeasuredPiece {
  return { piece: null, checks: null, report };
}

export function buildMeasuredCurve(source: MeasuredCurveSource, part: string): MeasuredPiece {
  const curve = measureCurve(source.library, part);
  if (curve === null) {
    return skip(measuredReport(part, null, null, null, false, "no centre of curvature measured"));
  }
  const [low, high] = curve.ends;
  const turn = normalizedTurn(high.radialAngle - low.radialAngle);
  const steps16 = identifiedSteps(turn, STEP_RADIANS);
  const radiusStuds = Math.round(curve.centrelineRadiusLdu / LDU_PER_STUD);
  const radiusResidual = Math.abs(curve.centrelineRadiusLdu - radiusStuds * LDU_PER_STUD);
  if (radiusResidual > IDENTIFICATION_ACCEPTED_DEVIATION_LDU) {
    return skip(
      measuredReport(
        part,
        curve,
        null,
        turn,
        false,
        `its centreline radius ${curve.centrelineRadiusLdu} LDU is no whole number of studs within 0.0005 LDU`,
      ),
    );
  }
  if (steps16 === null) {
    const halfSteps = identifiedSteps(turn, STEP_RADIANS / 2);
    const reason =
      halfSteps === null
        ? `it turns ${(turn * DEGREES_PER_RADIAN).toFixed(4)}°, which is no 22.5° or 11.25° step`
        : `it turns ${halfSteps * 11.25}°, which needs N = 32 (ℤ[ζ₃₂]) track arithmetic`;
    return skip(measuredReport(part, curve, radiusStuds, turn, false, reason));
  }
  const radiusLdu = radiusStuds * LDU_PER_STUD;
  const lowJoint = radialJoint(curve, low, radiusLdu);
  const highJoint = radialJoint(curve, high, radiusLdu);
  const headingFrom = (from: MarkerEnd, to: MarkerEnd): number =>
    Math.round(normalizeAngle(to.outward - entryFrame(from).inward) / STEP_RADIANS) % ZETA16_ORDER;
  const [entry, entryEnd, exitEnd] =
    signedTurn(headingFrom(lowJoint, highJoint)) < 0
      ? [lowJoint, low, high]
      : [highJoint, high, low];
  const frame = entryFrame(entry);
  const exitHeading = headingFrom(entry, entry === lowJoint ? highJoint : lowJoint);
  const exitTurn = signedTurn(exitHeading);
  const exitPosition = arcExit(radiusStuds, exitTurn);
  const derivation = `arc: radius ${radiusStuds} studs (centreline ${curve.centrelineRadiusLdu} LDU, the radius ${curve.mirroredRingPairs} pairs of its ${curve.rings} clean vertex rings mirror about), turn ${exitTurn} step from the end faces' directions; not certified: its end faces lie ${entryEnd.faceOffsetLdu.toFixed(4)} and ${exitEnd.faceOffsetLdu.toFixed(4)} LDU inside the radial joint planes`;
  const measuredEntry = inEntryFrame(frame, faceCentre(curve, entryEnd, radiusLdu));
  const measuredExit = inEntryFrame(frame, faceCentre(curve, exitEnd, radiusLdu));
  const exitStuds = zeta16ToStuds(exitPosition);
  const reference: ExactEnd = {
    position: ZETA16_ZERO,
    heading: HALF_TURN_16,
    status: "unverified",
    derivation: "reference end: the radial joint plane at the identified centreline radius",
    residualLdu: Math.max(Math.abs(measuredEntry.x), Math.abs(measuredEntry.z)),
  };
  const exit: ExactEnd = {
    position: exitPosition,
    heading: exitHeading,
    status: "unverified",
    derivation,
    residualLdu: Math.max(
      Math.abs(exitStuds.x * LDU_PER_STUD - measuredExit.x),
      Math.abs(exitStuds.z * LDU_PER_STUD - measuredExit.z),
    ),
  };
  const ends = [reference, exit] as const;
  const scanAt = (end: ExactEnd, measured: MeasuredEnd): ScanEnd => {
    const pose = poseInEntryFrame(end);
    const across = (radius: number): PlanPoint => ({
      x: curve.centre.x + radius * Math.cos(measured.radialAngle),
      z: curve.centre.z + radius * Math.sin(measured.radialAngle),
    });
    return {
      origin: toPartFrame(frame, pose),
      heading: pose.heading + Math.PI + frame.inward,
      endSleeperExtremes: [
        exactPlanPointOf(across(curve.innermostRingLdu)),
        exactPlanPointOf(across(curve.outermostRingLdu)),
      ],
    };
  };
  const scans = [scanAt(reference, entryEnd), scanAt(exit, exitEnd)] as const;
  const heads = railHeadsAtEnd(flatPolygons(source.library, part), scans[0]);
  if (heads === null) {
    return skip(
      measuredReport(part, curve, radiusStuds, turn, false, "no rail pair at its entry end"),
    );
  }
  const sections = scans.map((scan) => railSection(heads, scan));
  const [entrySection] = sections;
  if (!entrySection) {
    return skip(
      measuredReport(part, curve, radiusStuds, turn, false, "no rail pair across its entry"),
    );
  }
  const startPose = poseInEntryFrame(reference);
  const path = fitRoutePath(
    heads,
    (point) => toPartFrame(frame, point),
    { ...startPose, heading: startPose.heading + Math.PI },
    poseInEntryFrame(exit),
    exactRationalToFloat64(entrySection.railHalfSpacingLdu),
    `${part} route 0→1`,
  );
  const id = `${source.namespace}:${part}`;
  const piece: v.InferInput<typeof TrackPiece> = {
    id,
    part: id,
    title: `${source.vendor} Curve R${radiusStuds}`,
    kind: "curve",
    system: source.id,
    joinClass: "lego-train",
    status: "unverified",
    thirdParty: { source: source.id, vendor: source.vendor },
    connectors: ends.map((end) => ({
      coefficients: encodeZeta16(conjugateZeta16(end.position)),
      heading: normalizeHeading16(-end.heading),
      status: end.status,
      residualLdu: end.residualLdu,
    })),
    routes: [
      { from: 0, to: 1, lengthLdu: path.lengthLdu, segments: path.segments.map(mirrorSegment) },
    ],
    partFrame: partFrameInBundle(frame),
  };
  const checks: PieceChecks = {
    id,
    railTopY: formatExactDecimal(heads.topY),
    connectors: ends.map((end, connector) => ({
      connector,
      marker: "radial joint plane",
      derivation: end.derivation,
      markerResidualLdu: end.residualLdu,
      railCentreOffsetLdu: exactRationalText(sections[connector]?.railCentreOffsetLdu),
      railHalfSpacingLdu: exactRationalText(sections[connector]?.railHalfSpacingLdu),
    })),
    routes: [
      {
        from: 0,
        to: 1,
        family: path.family,
        railCoverage: path.railCoverage,
        rejected: path.rejected,
      },
    ],
  };
  return {
    piece,
    checks,
    report: measuredReport(part, curve, radiusStuds, turn, true, derivation),
  };
}

export function buildTrackCatalog(
  library: LdrawLibrary,
  parts: ReadonlyArray<string>,
  markers: ReadonlyArray<TrackEndMarker>,
  thirdParty: ReadonlyArray<MeasuredCurveSource> = [],
): TrackCatalogReport {
  const built = parts.map((part) => buildTrackPiece(library, part, markers));
  const measured = thirdParty.map((source) => ({
    source: source.id,
    built: source.parts.map((part) => buildMeasuredCurve(source, part)),
  }));
  const offered = measured.flatMap(({ built: pieces }) =>
    pieces.flatMap(({ piece, checks }) => (piece && checks ? [{ piece, checks }] : [])),
  );
  return {
    frame: "bundle +Y up (z = −z_LDraw); x → Re, z → Im; connector 0 at the origin facing −x",
    n: ZETA16_ORDER,
    pieces: [...built, ...offered].map(({ piece }) => piece),
    checks: [...built, ...offered].map(({ checks }) => checks),
    thirdParty: measured.map(({ source, built: pieces }) => ({
      source,
      curves: pieces.map(({ report }) => report),
    })),
  };
}
