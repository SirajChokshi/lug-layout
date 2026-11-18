import { applyToPoint, compose, IDENTITY, type Affine, type Vec3 } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import {
  LDCAD_META,
  metaValues,
  parseLdraw,
  splitMultiPart,
  subfilePlacement,
  type LdrawFile,
} from "../ldraw/parse.ts";
import { walkPart } from "../ldraw/walk.ts";

const CYLINDER_PRIMITIVE = "4-4cyli.dat";
const SAMPLES_PER_LDU = 16;
const SAME = 1e-9;
const PARALLEL = 1e-6;
const POSE_DECIMALS = 4;
const MAGNET_FINGER = /^SNAP_FGR\b.*\[group=magnet\].*\[pos=(\S+) (\S+) (\S+)\]/u;

type YzPoint = readonly [number, number];

interface Interval {
  readonly from: number;
  readonly to: number;
}

interface Pin {
  readonly radius: number;
  readonly span: Interval;
  readonly axis: YzPoint;
}

interface ProfileRun {
  readonly from: number;
  readonly to: number;
  readonly fits: boolean;
  readonly least: number;
  readonly leastAt: number;
  readonly largest: number;
}

interface PinPose {
  readonly model: string;
  readonly axis: YzPoint;
  readonly alongAxis: number;
  readonly clearance: number;
  readonly fits: boolean;
}

export interface MagnetSeat {
  readonly holder: string;
  readonly casing: string;
  readonly curatedPivot: Vec3;
  readonly pinRadius: number;
  readonly pinSpans: ReadonlyArray<Interval>;
  readonly pivotClearance: number;
  readonly seatCentre: YzPoint;
  readonly alongDepth: ReadonlyArray<ProfileRun>;
  readonly alongHeight: ReadonlyArray<ProfileRun>;
  readonly modelPoses: ReadonlyArray<{
    readonly axis: YzPoint;
    readonly alongAxis: ReadonlyArray<number>;
    readonly clearance: number;
    readonly fits: boolean;
    readonly casings: ReadonlyArray<string>;
  }>;
}

export interface MagnetModel {
  readonly name: string;
  readonly source: string;
}

function column(world: Affine, index: 0 | 1 | 2): Vec3 {
  const [a, b, c, d, e, f, g, h, i] = world;
  const columns: readonly [Vec3, Vec3, Vec3] = [
    [a, d, g],
    [b, e, h],
    [c, f, i],
  ];
  return columns[index];
}

function length([x, y, z]: Vec3): number {
  return Math.hypot(x, y, z);
}

function measurePins(library: LdrawLibrary, casing: string): ReadonlyArray<Pin> {
  const pins: Pin[] = [];
  walkPart(library, `${casing}.dat`, {
    reference: (placed) => {
      if (placed.file !== CYLINDER_PRIMITIVE) return "descend";
      const [height, rise, run] = column(placed.world, 1);
      const radius = length(column(placed.world, 0));
      if (Math.abs(rise) > SAME || Math.abs(run) > SAME) return "skip";
      if (Math.abs(radius - length(column(placed.world, 2))) > SAME) return "skip";
      const [start, y, z] = applyToPoint(placed.world, [0, 0, 0]);
      const end = start + height;
      pins.push({
        radius,
        span: { from: Math.min(start, end), to: Math.max(start, end) },
        axis: [y, z],
      });
      return "skip";
    },
  });
  return pins;
}

function cutAt(
  points: ReadonlyArray<Vec3>,
  bound: number,
  keep: (x: number) => boolean,
): ReadonlyArray<Vec3> {
  const kept: Vec3[] = [];
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    if (keep(point[0])) kept.push(point);
    if (keep(point[0]) !== keep(next[0])) {
      const t = (bound - point[0]) / (next[0] - point[0]);
      kept.push([bound, point[1] + t * (next[1] - point[1]), point[2] + t * (next[2] - point[2])]);
    }
  });
  return kept;
}

function clipToSpan(polygon: ReadonlyArray<Vec3>, span: Interval): ReadonlyArray<Vec3> {
  return cutAt(
    cutAt(polygon, span.from, (x) => x >= span.from),
    span.to,
    (x) => x <= span.to,
  );
}

function holderPolygons(library: LdrawLibrary, holder: string): ReadonlyArray<ReadonlyArray<Vec3>> {
  const polygons: Array<ReadonlyArray<Vec3>> = [];
  walkPart(library, `${holder}.dat`, { polygon: (placed) => polygons.push(placed.vertices) });
  return polygons;
}

function slab(
  polygons: ReadonlyArray<ReadonlyArray<Vec3>>,
  spans: ReadonlyArray<Interval>,
): ReadonlyArray<ReadonlyArray<YzPoint>> {
  return spans.flatMap((span) =>
    polygons
      .map((polygon) => clipToSpan(polygon, span).map(([, y, z]): YzPoint => [y, z]))
      .filter((projected) => projected.length > 0),
  );
}

function segmentDistance(point: YzPoint, start: YzPoint, end: YzPoint): number {
  const dy = end[0] - start[0];
  const dz = end[1] - start[1];
  const squared = dy * dy + dz * dz;
  const t =
    squared === 0
      ? 0
      : Math.min(
          1,
          Math.max(0, ((point[0] - start[0]) * dy + (point[1] - start[1]) * dz) / squared),
        );
  return Math.hypot(point[0] - (start[0] + t * dy), point[1] - (start[1] + t * dz));
}

function strictlyInside(point: YzPoint, polygon: ReadonlyArray<YzPoint>): boolean {
  let sign = 0;
  for (const [index, start] of polygon.entries()) {
    const end = polygon[(index + 1) % polygon.length] ?? start;
    const cross =
      (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0]);
    if (Math.abs(cross) <= SAME) return false;
    if (sign !== 0 && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return polygon.length >= 3;
}

function clearance(material: ReadonlyArray<ReadonlyArray<YzPoint>>, point: YzPoint): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const polygon of material) {
    if (strictlyInside(point, polygon)) return 0;
    for (const [index, start] of polygon.entries()) {
      const end = polygon[(index + 1) % polygon.length] ?? start;
      nearest = Math.min(nearest, segmentDistance(point, start, end));
    }
  }
  return nearest;
}

function extent(material: ReadonlyArray<ReadonlyArray<YzPoint>>, axis: 0 | 1): Interval {
  const values = material.flat().map((point) => point[axis]);
  return { from: Math.min(...values), to: Math.max(...values) };
}

function profile(
  material: ReadonlyArray<ReadonlyArray<YzPoint>>,
  through: YzPoint,
  axis: 0 | 1,
  radius: number,
): ReadonlyArray<ProfileRun> {
  const { from, to } = extent(material, axis);
  const first = Math.ceil((from - through[axis]) * SAMPLES_PER_LDU);
  const last = Math.floor((to - through[axis]) * SAMPLES_PER_LDU);
  const runs: ProfileRun[] = [];
  for (let step = first; step <= last; step += 1) {
    const at = through[axis] + step / SAMPLES_PER_LDU;
    const point: YzPoint = axis === 0 ? [at, through[1]] : [through[0], at];
    const value = clearance(material, point);
    const fits = value >= radius - SAME;
    const current = runs.at(-1);
    if (current?.fits === fits) {
      runs[runs.length - 1] = {
        ...current,
        to: at,
        least: Math.min(current.least, value),
        leastAt: value < current.least ? at : current.leastAt,
        largest: Math.max(current.largest, value),
      };
    } else runs.push({ from: at, to: at, fits, least: value, leastAt: at, largest: value });
  }
  return runs;
}

function widestCentre(
  material: ReadonlyArray<ReadonlyArray<YzPoint>>,
  through: YzPoint,
  axis: 0 | 1,
  run: ProfileRun,
): number {
  const widest: number[] = [];
  for (let at = run.from; at <= run.to + SAME; at += 1 / SAMPLES_PER_LDU) {
    const point: YzPoint = axis === 0 ? [at, through[1]] : [through[0], at];
    if (Math.abs(clearance(material, point) - run.largest) <= SAME) widest.push(at);
  }
  return ((widest[0] ?? Number.NaN) + (widest.at(-1) ?? Number.NaN)) / 2;
}

function curatedPivot(shadow: LdrawLibrary, holder: string): Vec3 {
  const file = shadow.load(`${holder}.dat`);
  const match = (file === undefined ? [] : metaValues(file, LDCAD_META))
    .map((line) => MAGNET_FINGER.exec(line))
    .find((found) => found !== null);
  if (match === undefined || match === null) throw new Error(`${holder} has no magnet finger snap`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function containing(runs: ReadonlyArray<ProfileRun>, at: number): ProfileRun {
  const run = runs.find((candidate) => candidate.from - SAME <= at && at <= candidate.to + SAME);
  if (run === undefined) throw new Error(`no profile run contains ${String(at)}`);
  return run;
}

function invert(world: Affine): Affine {
  const [a, b, c, d, e, f, g, h, i, x, y, z] = world;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const inverse = [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ] as const;
  const [p, q, r, s, t, u, v, w, k] = inverse;
  return [
    p,
    q,
    r,
    s,
    t,
    u,
    v,
    w,
    k,
    -(p * x + q * y + r * z),
    -(s * x + t * y + u * z),
    -(v * x + w * y + k * z),
  ];
}

function placementsOf(library: LdrawLibrary, part: string, wanted: string): ReadonlyArray<Affine> {
  if (part === wanted) return [IDENTITY];
  const found: Affine[] = [];
  walkPart(library, part, {
    reference: (placed) => {
      if (placed.file !== wanted) return "descend";
      found.push(placed.world);
      return "skip";
    },
  });
  return found;
}

type PartPlacements = Map<string, ReadonlyMap<string, ReadonlyArray<Affine>>>;

function flattenModel(
  model: MagnetModel,
  library: LdrawLibrary,
  wanted: ReadonlyArray<string>,
  memo: PartPlacements,
): ReadonlyMap<string, ReadonlyArray<Affine>> {
  const sections = new Map<string, LdrawFile>(
    splitMultiPart(model.source).map((section) => [section.name, parseLdraw(section.source)]),
  );
  const [root] = sections.keys();
  const placed = new Map<string, Affine[]>(wanted.map((name) => [name, []]));
  const local = (part: string) => {
    const cached = memo.get(part);
    if (cached !== undefined) return cached;
    const result = new Map(wanted.map((name) => [name, placementsOf(library, part, name)]));
    memo.set(part, result);
    return result;
  };
  const visit = (name: string, world: Affine): void => {
    for (const line of sections.get(name)?.lines ?? []) {
      if (line.kind !== "subfile") continue;
      const child = compose(world, subfilePlacement(line).transform);
      if (sections.has(line.reference) && !line.reference.endsWith(".dat")) {
        visit(line.reference, child);
        continue;
      }
      for (const [target, placements] of local(line.reference)) {
        for (const placement of placements) placed.get(target)?.push(compose(child, placement));
      }
    }
  };
  if (root !== undefined) visit(root, IDENTITY);
  return placed;
}

function rounded(value: number): number {
  return Number(value.toFixed(POSE_DECIMALS)) + 0;
}

function roundedRun(run: ProfileRun): ProfileRun {
  return { ...run, least: rounded(run.least), largest: rounded(run.largest) };
}

function modelPinPoses(
  library: LdrawLibrary,
  holder: string,
  casing: string,
  pins: ReadonlyArray<Pin>,
  polygons: ReadonlyArray<ReadonlyArray<Vec3>>,
  models: ReadonlyArray<MagnetModel>,
): ReadonlyArray<PinPose> {
  const holderFile = `${holder}.dat`;
  const casingFile = `${casing}.dat`;
  const [pin] = pins;
  if (pin === undefined) throw new Error(`${casing} has no pins`);
  const memo: PartPlacements = new Map();
  return models.flatMap((model) => {
    const placed = flattenModel(model, library, [holderFile, casingFile], memo);
    const holders = placed.get(holderFile) ?? [];
    const casings = placed.get(casingFile) ?? [];
    return holders.flatMap((holderWorld) => {
      const toHolder = invert(holderWorld);
      return casings.flatMap((casingWorld): PinPose[] => {
        const relative = compose(toHolder, casingWorld);
        const direction = column(relative, 0);
        if (Math.abs(Math.abs(direction[0]) - 1) > PARALLEL) return [];
        const offset = applyToPoint(relative, [0, pin.axis[0], pin.axis[1]]);
        const spans = pins.map(({ span }) => {
          const ends = [offset[0] + direction[0] * span.from, offset[0] + direction[0] * span.to];
          return { from: Math.min(...ends), to: Math.max(...ends) };
        });
        const material = slab(polygons, spans);
        if (material.length === 0) return [];
        const height = extent(material, 0);
        const depth = extent(material, 1);
        const axis: YzPoint = [offset[1], offset[2]];
        if (
          axis[0] < height.from ||
          axis[0] > height.to ||
          axis[1] < depth.from ||
          axis[1] > depth.to
        )
          return [];
        const value = clearance(material, axis);
        return [
          {
            model: model.name,
            axis: [rounded(offset[1]), rounded(offset[2])],
            alongAxis: rounded(offset[0]),
            clearance: rounded(value),
            fits: value >= pin.radius - SAME,
          },
        ];
      });
    });
  });
}

function groupPoses(poses: ReadonlyArray<PinPose>): MagnetSeat["modelPoses"] {
  const groups = new Map<string, PinPose[]>();
  for (const pose of poses) {
    const key = `${String(pose.axis[0])} ${String(pose.axis[1])}`;
    groups.set(key, [...(groups.get(key) ?? []), pose]);
  }
  return [...groups.values()]
    .map((members) => {
      const least = Math.min(...members.map((member) => member.clearance));
      return {
        axis: members[0]?.axis ?? [Number.NaN, Number.NaN],
        alongAxis: [...new Set(members.map((member) => member.alongAxis))].toSorted(
          (left, right) => left - right,
        ),
        clearance: least,
        fits: members.every((member) => member.fits),
        casings: members.map((member) => member.model).toSorted(),
      };
    })
    .toSorted((left, right) => right.clearance - left.clearance);
}

export function measureMagnetSeat(
  library: LdrawLibrary,
  shadow: LdrawLibrary,
  holder: string,
  casing: string,
  models: ReadonlyArray<MagnetModel>,
): MagnetSeat {
  const pins = measurePins(library, casing);
  const [pin] = pins;
  if (pin === undefined || pins.some((other) => Math.abs(other.radius - pin.radius) > SAME))
    throw new Error(`${casing} needs pins of one radius`);
  const pivot = curatedPivot(shadow, holder);
  const through: YzPoint = [pivot[1], pivot[2]];
  const polygons = holderPolygons(library, holder);
  const material = slab(
    polygons,
    pins.map(({ span }) => span),
  );
  const alongDepth = profile(material, through, 1, pin.radius);
  const alongHeight = profile(material, through, 0, pin.radius);
  return {
    holder,
    casing,
    curatedPivot: pivot,
    pinRadius: pin.radius,
    pinSpans: pins.map(({ span }) => span),
    pivotClearance: clearance(material, through),
    seatCentre: [
      widestCentre(material, through, 0, containing(alongHeight, through[0])),
      widestCentre(material, through, 1, containing(alongDepth, through[1])),
    ],
    alongDepth: alongDepth.map(roundedRun),
    alongHeight: alongHeight.map(roundedRun),
    modelPoses: groupPoses(modelPinPoses(library, holder, casing, pins, polygons, models)),
  };
}
