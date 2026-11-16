import { applyToPoint, type Vec3 } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { isStudPrimitive, LDCAD_META, metaValues, subfilePlacement } from "../ldraw/parse.ts";
import { dependencyClosure, INHERIT_COLOR, walkPart, type PlacedPolygon } from "../ldraw/walk.ts";
import {
  addZeta16,
  mirrorZeta16,
  rotateZeta16,
  zeta16ToPlane,
  ZETA16_ORDER,
  ZETA16_STEP_RADIANS,
  type Zeta16Coefficients,
} from "../track/cyclotomic.ts";
import {
  findTrackEnds,
  LDU_PER_STUD,
  relativeToEntry,
  type RelativeTrackEnd,
  type TrackEnd,
  type TrackEndMarker,
} from "../track/track-ends.ts";

const LDU_IN_MM = 0.4;
const TRAIN_TRACK_SNAP = /\[group=traintrk\].*\[pos=(\S+) (\S+) (\S+)\]/;
const FLAT_EPSILON = 1e-6;
const HELP_META = "!HELP";
const HELP_ROTATION_POINT = /rotation point is at (\S+)\/(\S+)\/(\S+)/i;

interface Interval {
  readonly from: number;
  readonly to: number;
}

function isFlatHorizontal(polygon: PlacedPolygon): boolean {
  const [first, ...rest] = polygon.vertices;
  return (
    first !== undefined && rest.every((vertex) => Math.abs(vertex[1] - first[1]) < FLAT_EPSILON)
  );
}

function spansX(polygon: PlacedPolygon, x: number): boolean {
  const xs = polygon.vertices.map((vertex) => vertex[0]);
  return Math.min(...xs) <= x && x <= Math.max(...xs);
}

function mergeIntervals(intervals: ReadonlyArray<Interval>): ReadonlyArray<Interval> {
  const merged: Interval[] = [];
  for (const interval of intervals.toSorted((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last !== undefined && interval.from <= last.to + FLAT_EPSILON) {
      merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, interval.to) };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

function collectPolygons(library: LdrawLibrary, part: string, skipStuds: boolean): PlacedPolygon[] {
  const polygons: PlacedPolygon[] = [];
  walkPart(library, `${part}.dat`, {
    reference: (placed) => (skipStuds && isStudPrimitive(placed.file) ? "skip" : "descend"),
    polygon: (placed) => polygons.push(placed),
  });
  return polygons;
}

function extent(polygons: ReadonlyArray<PlacedPolygon>, axis: 0 | 1 | 2): Interval {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (const vertex of polygon.vertices) {
      from = Math.min(from, vertex[axis]);
      to = Math.max(to, vertex[axis]);
    }
  }
  return { from, to };
}

interface RailMeasurement {
  readonly part: string;
  readonly sectionX: number;
  readonly railTopY: number;
  readonly railHeads: ReadonlyArray<Interval>;
  readonly railCentreSpacingLdu: number | null;
  readonly innerGaugeLdu: number | null;
  readonly innerGaugeMm: number | null;
  readonly railHeadWidthLdu: number | null;
  readonly trackWidthLdu: number;
  readonly railTopAboveUndersideLdu: number;
}

export function measureRails(
  library: LdrawLibrary,
  part: string,
  sectionX: number,
): RailMeasurement {
  const polygons = collectPolygons(library, part, false);
  const railTopY = extent(polygons, 1).from;
  const railHeads = mergeIntervals(
    polygons
      .filter(
        (polygon) =>
          isFlatHorizontal(polygon) &&
          Math.abs((polygon.vertices[0]?.[1] ?? Number.NaN) - railTopY) < FLAT_EPSILON &&
          spansX(polygon, sectionX),
      )
      .map((polygon) => {
        const zs = polygon.vertices.map((vertex) => vertex[2]);
        return { from: Math.min(...zs), to: Math.max(...zs) };
      }),
  );
  const [near, far] = railHeads;
  const pair = railHeads.length === 2 && near !== undefined && far !== undefined;
  const innerGauge = pair ? far.from - near.to : null;
  return {
    part,
    sectionX,
    railTopY,
    railHeads,
    railCentreSpacingLdu: pair ? (far.from + far.to) / 2 - (near.from + near.to) / 2 : null,
    innerGaugeLdu: innerGauge,
    innerGaugeMm: innerGauge === null ? null : innerGauge * LDU_IN_MM,
    railHeadWidthLdu: pair ? near.to - near.from : null,
    trackWidthLdu: extent(polygons, 2).to - extent(polygons, 2).from,
    railTopAboveUndersideLdu: extent(polygons, 1).to - railTopY,
  };
}

export interface BaseplateMeasurement {
  readonly part: string;
  readonly bodyTopY: number;
  readonly bodyBottomY: number;
  readonly thicknessLdu: number;
  readonly studTopY: number;
  readonly xExtent: Interval;
  readonly zExtent: Interval;
  readonly widthLdu: number;
  readonly depthLdu: number;
}

export function measureBaseplate(library: LdrawLibrary, part: string): BaseplateMeasurement {
  const body = collectPolygons(library, part, true);
  const all = collectPolygons(library, part, false);
  const vertical = extent(body, 1);
  return {
    part,
    bodyTopY: vertical.from,
    bodyBottomY: vertical.to,
    thicknessLdu: vertical.to - vertical.from,
    studTopY: extent(all, 1).from,
    xExtent: extent(body, 0),
    zExtent: extent(body, 2),
    widthLdu: extent(body, 0).to - extent(body, 0).from,
    depthLdu: extent(body, 2).to - extent(body, 2).from,
  };
}

interface StudZones {
  readonly part: string;
  readonly studCount: number;
  readonly studY: ReadonlyArray<number>;
  readonly studdedColumns: ReadonlyArray<Interval>;
  readonly map: ReadonlyArray<string>;
}

export function measureStudZones(library: LdrawLibrary, part: string): StudZones {
  const studs: Vec3[] = [];
  walkPart(library, `${part}.dat`, {
    reference: (placed) => {
      if (!isStudPrimitive(placed.file)) return "descend";
      studs.push(applyToPoint(placed.world, [0, 0, 0]));
      return "skip";
    },
  });
  const body = collectPolygons(library, part, true);
  const xExtent = extent(body, 0);
  const zExtent = extent(body, 2);
  const columnCount = Math.round((xExtent.to - xExtent.from) / LDU_PER_STUD);
  const rowCount = Math.round((zExtent.to - zExtent.from) / LDU_PER_STUD);
  const column = (x: number): number => Math.floor((x - xExtent.from) / LDU_PER_STUD);
  const row = (z: number): number => Math.floor((z - zExtent.from) / LDU_PER_STUD);
  const occupied = new Set(studs.map(([x, , z]) => `${column(x)},${row(z)}`));
  const map = Array.from({ length: rowCount }, (_row, rowIndex) =>
    Array.from({ length: columnCount }, (_column, columnIndex) =>
      occupied.has(`${columnIndex},${rowIndex}`) ? "o" : ".",
    ).join(""),
  );
  const studdedColumns = mergeIntervals(
    [...new Set(studs.map(([x]) => column(x)))].map((index) => ({ from: index, to: index + 1 })),
  );
  return {
    part,
    studCount: studs.length,
    studY: [...new Set(studs.map(([, y]) => y))].toSorted((a, b) => a - b),
    studdedColumns,
    map,
  };
}

interface MarkingBand {
  readonly color: number;
  readonly acrossBands: ReadonlyArray<Interval>;
  readonly alongExtent: Interval;
}

export function measureMarkingBands(
  library: LdrawLibrary,
  part: string,
): ReadonlyArray<MarkingBand> {
  const byColor = new Map<number, PlacedPolygon[]>();
  for (const polygon of collectPolygons(library, part, true)) {
    if (polygon.color === INHERIT_COLOR || !isFlatHorizontal(polygon)) continue;
    byColor.set(polygon.color, [...(byColor.get(polygon.color) ?? []), polygon]);
  }
  return [...byColor.entries()]
    .map(([color, polygons]) => ({
      color,
      acrossBands: mergeIntervals(
        polygons.map((polygon) => {
          const xs = polygon.vertices.map((vertex) => vertex[0]);
          return { from: Math.min(...xs), to: Math.max(...xs) };
        }),
      ),
      alongExtent: extent(polygons, 2),
    }))
    .toSorted((p, q) => p.color - q.color);
}

interface ArcFromEnds {
  readonly chordLdu: number;
  readonly turnSteps: number;
  readonly radiusFromChordLdu: number;
  readonly helpRotationPoint: Vec3 | null;
  readonly endDistancesToHelpRotationPointLdu: ReadonlyArray<number> | null;
}

export interface TrackEndReport {
  readonly part: string;
  readonly ends: ReadonlyArray<TrackEnd>;
  readonly relative: ReadonlyArray<RelativeTrackEnd>;
  readonly outwardPointsAwayFromCentre: boolean;
  readonly arc: ArcFromEnds | null;
}

function helpRotationPoint(help: ReadonlyArray<string>): Vec3 | null {
  for (const line of help) {
    const match = HELP_ROTATION_POINT.exec(line);
    if (match !== null) return [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  return null;
}

function arcFromEnds(
  ends: ReadonlyArray<TrackEnd>,
  relative: ReadonlyArray<RelativeTrackEnd>,
  help: ReadonlyArray<string>,
): ArcFromEnds | null {
  const [first, second] = ends;
  const exit = relative[1];
  if (ends.length !== 2 || first === undefined || second === undefined || exit === undefined) {
    return null;
  }
  const turnSteps =
    exit.headingSteps > ZETA16_ORDER / 2 ? exit.headingSteps - ZETA16_ORDER : exit.headingSteps;
  if (turnSteps === 0) return null;
  const chordLdu = Math.hypot(second.x - first.x, second.z - first.z);
  const halfTurn = (Math.abs(turnSteps) * ZETA16_STEP_RADIANS) / 2;
  const pivot = helpRotationPoint(help);
  return {
    chordLdu,
    turnSteps,
    radiusFromChordLdu: chordLdu / (2 * Math.sin(halfTurn)),
    helpRotationPoint: pivot,
    endDistancesToHelpRotationPointLdu:
      pivot === null ? null : ends.map((end) => Math.hypot(end.x - pivot[0], end.z - pivot[2])),
  };
}

export function reportTrackEnds(
  library: LdrawLibrary,
  part: string,
  markers: ReadonlyArray<TrackEndMarker>,
): TrackEndReport {
  const ends = findTrackEnds(library, part, markers);
  const relative = relativeToEntry(ends);
  const polygons = collectPolygons(library, part, true);
  const centreX = (extent(polygons, 0).from + extent(polygons, 0).to) / 2;
  const centreZ = (extent(polygons, 2).from + extent(polygons, 2).to) / 2;
  return {
    part,
    ends,
    relative,
    outwardPointsAwayFromCentre: ends.every(
      (end) =>
        Math.cos(end.outward) * (end.x - centreX) + Math.sin(end.outward) * (end.z - centreZ) > 0,
    ),
    arc: arcFromEnds(ends, relative, helpLines(library, part)),
  };
}

interface LdcadSnapCheck {
  readonly part: string;
  readonly snapPairs: number;
  readonly maxMidpointToNearestEndLdu: number | null;
}

export function crossCheckLdcadTrackSnaps(
  library: LdrawLibrary,
  shadow: LdrawLibrary,
  part: string,
  ends: ReadonlyArray<TrackEnd>,
): LdcadSnapCheck {
  const midpoints: Vec3[] = [];
  walkPart(library, `${part}.dat`, {
    reference: (placed) => {
      const patch = shadow.load(placed.file);
      const positions = (patch === undefined ? [] : metaValues(patch, LDCAD_META))
        .map((line) => TRAIN_TRACK_SNAP.exec(line))
        .filter((match) => match !== null)
        .map((match): Vec3 => [Number(match[1]), Number(match[2]), Number(match[3])])
        .map((local) => applyToPoint(placed.world, local));
      const [first, second] = positions;
      if (positions.length === 2 && first !== undefined && second !== undefined) {
        midpoints.push([
          (first[0] + second[0]) / 2,
          (first[1] + second[1]) / 2,
          (first[2] + second[2]) / 2,
        ]);
      }
      return "descend";
    },
  });
  const distances = midpoints.map(([x, , z]) =>
    Math.min(...ends.map((end) => Math.hypot(end.x - x, end.z - z))),
  );
  return {
    part,
    snapPairs: midpoints.length,
    maxMidpointToNearestEndLdu: distances.length === 0 ? null : Math.max(...distances),
  };
}

interface ComposedPose {
  readonly via: ReadonlyArray<string>;
  readonly headingSteps: number;
  readonly exactCoefficients: Zeta16Coefficients | null;
  readonly exactDerivation: string;
  readonly measuredXStuds: number;
  readonly measuredZStuds: number;
  readonly measuredResidualToExactLdu: number | null;
}

export function composeDivergingWithCurve(
  switchEnd: RelativeTrackEnd,
  curveEnd: RelativeTrackEnd,
  names: ReadonlyArray<string>,
): ComposedPose {
  const turn = switchEnd.headingSteps * ZETA16_STEP_RADIANS;
  const mirrored = switchEnd.headingSteps === curveEnd.headingSteps;
  const sign = mirrored ? -1 : 1;
  const cx = curveEnd.xStuds;
  const cz = curveEnd.zStuds * sign;
  const measuredXStuds = switchEnd.xStuds + cx * Math.cos(turn) - cz * Math.sin(turn);
  const measuredZStuds = switchEnd.zStuds + cx * Math.sin(turn) + cz * Math.cos(turn);
  const headingSteps =
    (((switchEnd.headingSteps + sign * curveEnd.headingSteps) % ZETA16_ORDER) + ZETA16_ORDER) %
    ZETA16_ORDER;
  const [switchName = "", curveName = ""] = names;
  if (switchEnd.coefficients === null || curveEnd.coefficients === null) {
    return {
      via: names,
      headingSteps,
      exactCoefficients: null,
      exactDerivation: "not derived: an input end is not certified",
      measuredXStuds,
      measuredZStuds,
      measuredResidualToExactLdu: null,
    };
  }
  const curve = mirrored ? mirrorZeta16(curveEnd.coefficients) : curveEnd.coefficients;
  const exactCoefficients = addZeta16(
    switchEnd.coefficients,
    rotateZeta16(curve, switchEnd.headingSteps),
  );
  const exact = zeta16ToPlane(exactCoefficients);
  return {
    via: names,
    headingSteps,
    exactCoefficients,
    exactDerivation: `${switchName} diverging + ζ^${switchEnd.headingSteps} · ${mirrored ? "mirror(" : "("}${curveName} exit), both certified`,
    measuredXStuds,
    measuredZStuds,
    measuredResidualToExactLdu:
      Math.hypot(exact.x - measuredXStuds, exact.y - measuredZStuds) * LDU_PER_STUD,
  };
}

interface FlexBend {
  readonly part: string;
  readonly help: ReadonlyArray<string>;
  readonly measuredBendDegrees: number | null;
  readonly lengthLdu: number;
}

function helpLines(library: LdrawLibrary, part: string): ReadonlyArray<string> {
  const file = library.load(`${part}.dat`);
  return file === undefined ? [] : metaValues(file, HELP_META);
}

export function measureFlexBend(library: LdrawLibrary, part: string, movingHalf: string): FlexBend {
  const moving = library
    .load(`${part}.dat`)
    ?.lines.find((line) => line.kind === "subfile" && line.reference === movingHalf);
  const transform = moving?.kind === "subfile" ? subfilePlacement(moving).transform : undefined;
  const polygons = collectPolygons(library, part, true);
  return {
    part,
    help: helpLines(library, part),
    measuredBendDegrees:
      transform === undefined ? null : (Math.atan2(transform[6], transform[0]) * 180) / Math.PI,
    lengthLdu: extent(polygons, 0).to - extent(polygons, 0).from,
  };
}

interface CellGroup {
  readonly columns: number;
  readonly rows: number;
  readonly cells: number;
  readonly openEdges: ReadonlyArray<"minX" | "maxX" | "minZ" | "maxZ">;
}

interface RecessedPlate {
  readonly part: string;
  readonly widthLdu: number;
  readonly depthLdu: number;
  readonly bodyTopY: number;
  readonly bodyBottomY: number;
  readonly thicknessLdu: number;
  readonly studCount: number;
  readonly studBaseBelowTopLdu: ReadonlyArray<number>;
  readonly studGroups: ReadonlyArray<CellGroup>;
  readonly recessFloorBelowTopLdu: number | null;
  readonly recessGroups: ReadonlyArray<CellGroup>;
  readonly studMap: ReadonlyArray<string>;
  readonly dependencyFiles: number;
  readonly clipFiles: ReadonlyArray<string>;
}

const CLIP_TITLE = /\bclip\b/i;

function insidePolygonXZ(polygon: PlacedPolygon, x: number, z: number): boolean {
  let inside = false;
  const { vertices } = polygon;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const a = vertices[i];
    const b = vertices[j];
    if (a === undefined || b === undefined) continue;
    if (a[2] > z !== b[2] > z && x < ((b[0] - a[0]) * (z - a[2])) / (b[2] - a[2]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function cellGroups(
  cells: ReadonlySet<string>,
  columnCount: number,
  rowCount: number,
): CellGroup[] {
  const seen = new Set<string>();
  const groups: CellGroup[] = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    const members: Array<readonly [number, number]> = [];
    const pending = [start];
    seen.add(start);
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      const [column = 0, row = 0] = key.split(",").map(Number);
      members.push([column, row]);
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const next = `${column + dc},${row + dr}`;
        if (cells.has(next) && !seen.has(next)) {
          seen.add(next);
          pending.push(next);
        }
      }
    }
    const columns = members.map(([column]) => column);
    const rows = members.map(([, row]) => row);
    const openEdges: Array<"minX" | "maxX" | "minZ" | "maxZ"> = [];
    if (Math.min(...columns) === 0) openEdges.push("minX");
    if (Math.max(...columns) === columnCount - 1) openEdges.push("maxX");
    if (Math.min(...rows) === 0) openEdges.push("minZ");
    if (Math.max(...rows) === rowCount - 1) openEdges.push("maxZ");
    groups.push({
      columns: Math.max(...columns) - Math.min(...columns) + 1,
      rows: Math.max(...rows) - Math.min(...rows) + 1,
      cells: members.length,
      openEdges,
    });
  }
  return groups.toSorted(
    (p, q) =>
      p.columns - q.columns ||
      p.rows - q.rows ||
      p.openEdges.join().localeCompare(q.openEdges.join()),
  );
}

export function measureRecessedPlate(
  library: LdrawLibrary,
  part: string,
  topStudPrimitives: ReadonlyArray<string>,
): RecessedPlate {
  const body = collectPolygons(library, part, true);
  const xExtent = extent(body, 0);
  const yExtent = extent(body, 1);
  const zExtent = extent(body, 2);
  const studs: Vec3[] = [];
  walkPart(library, `${part}.dat`, {
    reference: (placed) => {
      if (!isStudPrimitive(placed.file)) return "descend";
      if (topStudPrimitives.includes(placed.file))
        studs.push(applyToPoint(placed.world, [0, 0, 0]));
      return "skip";
    },
  });
  const columnCount = Math.round((xExtent.to - xExtent.from) / LDU_PER_STUD);
  const rowCount = Math.round((zExtent.to - zExtent.from) / LDU_PER_STUD);
  const column = (x: number): number => Math.floor((x - xExtent.from) / LDU_PER_STUD);
  const row = (z: number): number => Math.floor((z - zExtent.from) / LDU_PER_STUD);
  const studCells = new Set(studs.map(([x, , z]) => `${column(x)},${row(z)}`));
  const studBaseBelowTopLdu = [...new Set(studs.map(([, y]) => y - yExtent.from))].toSorted(
    (a, b) => a - b,
  );
  const [floorDepth] = studBaseBelowTopLdu;
  const floorY = floorDepth === undefined ? null : yExtent.from + floorDepth;
  const floorFaces =
    floorY === null
      ? []
      : body.filter(
          (polygon) =>
            isFlatHorizontal(polygon) &&
            Math.abs((polygon.vertices[0]?.[1] ?? NaN) - floorY) < FLAT_EPSILON,
        );
  const recessCells = new Set<string>();
  for (let c = 0; c < columnCount; c += 1) {
    for (let r = 0; r < rowCount; r += 1) {
      const x = xExtent.from + (c + 0.5) * LDU_PER_STUD;
      const z = zExtent.from + (r + 0.5) * LDU_PER_STUD;
      if (floorFaces.some((polygon) => insidePolygonXZ(polygon, x, z)))
        recessCells.add(`${c},${r}`);
    }
  }
  const closure = dependencyClosure(library, `${part}.dat`);
  return {
    part,
    widthLdu: xExtent.to - xExtent.from,
    depthLdu: zExtent.to - zExtent.from,
    bodyTopY: yExtent.from,
    bodyBottomY: yExtent.to,
    thicknessLdu: yExtent.to - yExtent.from,
    studCount: studs.length,
    studBaseBelowTopLdu,
    studGroups: cellGroups(studCells, columnCount, rowCount),
    recessFloorBelowTopLdu: floorDepth ?? null,
    recessGroups: cellGroups(recessCells, columnCount, rowCount),
    studMap: Array.from({ length: rowCount }, (_row, r) =>
      Array.from({ length: columnCount }, (_column, c) =>
        studCells.has(`${c},${r}`) ? "o" : recessCells.has(`${c},${r}`) ? "_" : ".",
      ).join(""),
    ),
    dependencyFiles: closure.visitedFiles.size,
    clipFiles: [...closure.visitedFiles]
      .filter((name) => CLIP_TITLE.test(library.load(name)?.header.title ?? ""))
      .toSorted(),
  };
}
