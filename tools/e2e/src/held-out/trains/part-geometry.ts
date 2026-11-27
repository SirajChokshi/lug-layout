import { type Box, type PartReading, type PrimitiveFrame } from "./part-readings.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { Vec3 } from "../assembly.ts";

export type Axis = 0 | 1 | 2;
export type Sign = 1 | -1;

export const AXES: ReadonlyArray<Axis> = [0, 1, 2];
export const VERTICAL: Axis = 1;

export const PRIMITIVE_FAMILIES = {
  round: /^(48\/)?4-4(cyli|cylo|cylc|con\d+|ring\d+|disc)\.dat$/u,
  axleEnd: /^(axleend\d*|axl\dend)\.dat$/u,
  crossHole: /^(?!axleend)(axl\w*hol\w*|axl\w*ho\d+)\.dat$/u,
  roundHole: /^(peghole\d*|connhol\w*|beamhol\w*|npeghol\w*)\.dat$/u,
  notchedHole: /^wpinhol\w*\.dat$/u,
  pinHalf: /^(connect\d*|confric\d*)\.dat$/u,
} as const;

export type PrimitiveFamily = keyof typeof PRIMITIVE_FAMILIES;

export interface AxisLine {
  readonly axis: Axis;
  readonly at: readonly [number, number];
}

export interface Span extends AxisLine {
  readonly from: number;
  readonly to: number;
}

export interface HoleLine extends Span {
  readonly kind: "round" | "cross";
}

export interface RoundFeature extends Span {
  readonly radius: number;
}

export interface PinSpan extends AxisLine {
  readonly centre: number;
  readonly half: number;
  readonly radius: number;
}

export interface Stud {
  readonly origin: Vec3;
  readonly axis: Axis;
  readonly sign: Sign;
}

export interface Block {
  readonly reference: string;
  readonly width: number;
  readonly depth: number;
  readonly heightPlates: number;
  readonly bounds: Box;
  readonly holes: ReadonlyArray<HoleLine>;
  readonly sideStuds: ReadonlyArray<Stud>;
}

export interface RoundProfile {
  readonly radius: number;
  readonly smooth: boolean;
}

const ALIGNED = 1e-6;
const SAME = 1e-3;
const SECTORS = 64;
const SMOOTH_FRACTION = 0.95;
const EDGE_SAMPLE_LDU = 0.5;
const RING_OUTER = /ring(\d+)|con(\d+)/u;
const EDGE_LDU = 0.01;
const CONTACT_CONE = Math.PI / 3;
const CONTACT_CONE_COSINE = Math.cos(CONTACT_CONE);
const OUTBOARD_REACH_LDU = 1000;
const OUTBOARD_TOLERANCE_LDU = 0.5;

function familyOf(primitive: string): PrimitiveFamily | null {
  for (const [family, pattern] of Object.entries(PRIMITIVE_FAMILIES)) {
    if (pattern.test(primitive)) return family as PrimitiveFamily;
  }
  return null;
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function distance(a: Vec3, b: Vec3): number {
  return norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
}

export function axisOf(v: Vec3): { readonly axis: Axis; readonly sign: Sign } | null {
  const length = norm(v);
  if (length === 0) return null;
  const aligned = AXES.filter((axis) => Math.abs(v[axis]) / length > 1 - ALIGNED);
  const axis = aligned[0];
  if (axis === undefined || aligned.length !== 1) return null;
  return { axis, sign: v[axis] > 0 ? 1 : -1 };
}

export function across(axis: Axis): readonly [Axis, Axis] {
  const [first = 0, second = 2] = AXES.filter((other) => other !== axis);
  return [first, second];
}

function lineAt(axis: Axis, point: Vec3): readonly [number, number] {
  const [first, second] = across(axis);
  return [point[first], point[second]];
}

export function sameLine(a: AxisLine, b: AxisLine): boolean {
  return (
    a.axis === b.axis && Math.abs(a.at[0] - b.at[0]) < SAME && Math.abs(a.at[1] - b.at[1]) < SAME
  );
}

function primitiveSpan(frame: PrimitiveFrame, axis: Axis): readonly [number, number] {
  const start = frame.origin[axis];
  const end = start - frame.columns[1][axis];
  return [Math.min(start, end), Math.max(start, end)];
}

export function framesOf(
  frames: ReadonlyArray<PrimitiveFrame>,
  family: PrimitiveFamily,
): ReadonlyArray<PrimitiveFrame> {
  return frames.filter((frame) => familyOf(frame.primitive) === family);
}

export function roundFeatures(frames: ReadonlyArray<PrimitiveFrame>): ReadonlyArray<RoundFeature> {
  const out: RoundFeature[] = [];
  for (const frame of framesOf(frames, "round")) {
    const oriented = axisOf(frame.columns[1]);
    const radius = norm(frame.columns[0]);
    if (!oriented || Math.abs(radius - norm(frame.columns[2])) > SAME) continue;
    const match = RING_OUTER.exec(frame.primitive);
    const steps = match ? Number(match[1] ?? match[2]) + 1 : 1;
    const [from, to] = primitiveSpan(frame, oriented.axis);
    out.push({
      axis: oriented.axis,
      at: lineAt(oriented.axis, frame.origin),
      from,
      to,
      radius: radius * steps,
    });
  }
  return out;
}

export function holeLines(frames: ReadonlyArray<PrimitiveFrame>): ReadonlyArray<HoleLine> {
  const lines: HoleLine[] = [];
  for (const frame of frames) {
    const family = familyOf(frame.primitive);
    if (family !== "crossHole" && family !== "roundHole") continue;
    const oriented = axisOf(frame.columns[1]);
    if (!oriented) continue;
    const at = lineAt(oriented.axis, frame.origin);
    const [from, to] = primitiveSpan(frame, oriented.axis);
    const kind = family === "crossHole" ? "cross" : "round";
    const index = lines.findIndex((line) => sameLine(line, { axis: oriented.axis, at }));
    const known = lines[index];
    if (known) {
      lines[index] = {
        ...known,
        from: Math.min(known.from, from),
        to: Math.max(known.to, to),
        kind: known.kind === "cross" || kind === "cross" ? "cross" : "round",
      };
    } else {
      lines.push({ axis: oriented.axis, at, from, to, kind });
    }
  }
  return lines;
}

function connectionFrames(frames: ReadonlyArray<PrimitiveFrame>): ReadonlyArray<PrimitiveFrame> {
  return frames.filter((frame) => {
    const family = familyOf(frame.primitive);
    return family !== null && family !== "round";
  });
}

export function studsOf(reading: PartReading): ReadonlyArray<Stud> {
  const out: Stud[] = [];
  for (const frame of reading.studs) {
    const oriented = axisOf(frame.columns[1]);
    if (oriented) out.push({ origin: frame.origin, ...oriented });
  }
  return out;
}

export function axleStops(
  reading: PartReading,
  line: AxisLine,
): ReadonlyArray<readonly [number, number]> {
  return roundFeatures(reading.frames)
    .filter((feature) => sameLine(feature, line))
    .map((feature) => [feature.from, feature.to] as const);
}

export function axleSpan(reading: PartReading): Span | null {
  if (reading.studs.length > 0) return null;
  const ends = framesOf(reading.frames, "axleEnd");
  const [first, second] = ends;
  if (!first || !second || ends.length !== 2) return null;
  const a = axisOf(first.columns[1]);
  const b = axisOf(second.columns[1]);
  if (!a || !b || a.axis !== b.axis || a.sign === b.sign) return null;
  const line = { axis: a.axis, at: lineAt(a.axis, first.origin) };
  if (!sameLine(line, { axis: b.axis, at: lineAt(b.axis, second.origin) })) return null;
  const others = connectionFrames(reading.frames).filter((frame) => {
    const family = familyOf(frame.primitive);
    if (family === "axleEnd") return false;
    if (family !== "crossHole") return true;
    const oriented = axisOf(frame.columns[1]);
    return (
      !oriented || !sameLine(line, { axis: oriented.axis, at: lineAt(oriented.axis, frame.origin) })
    );
  });
  if (others.length > 0) return null;
  const [low, high] = a.sign > 0 ? [second, first] : [first, second];
  if (low.origin[a.axis] >= high.origin[a.axis]) return null;
  return { ...line, from: low.origin[a.axis], to: high.origin[a.axis] };
}

export function pinSpan(reading: PartReading): PinSpan | null {
  if (reading.studs.length > 0) return null;
  const halves = framesOf(reading.frames, "pinHalf");
  const [first, second] = halves;
  if (!first || !second || halves.length !== 2) return null;
  if (connectionFrames(reading.frames).length !== halves.length) return null;
  const a = axisOf(first.columns[1]);
  const b = axisOf(second.columns[1]);
  if (!a || !b || a.axis !== b.axis || a.sign === b.sign) return null;
  if (distance(first.origin, second.origin) > SAME) return null;
  const centre = first.origin[a.axis];
  const { min, max } = reading.bounds;
  const half = max[a.axis] - centre;
  if (half <= 0 || Math.abs(centre - min[a.axis] - half) > SAME) return null;
  const at = lineAt(a.axis, first.origin);
  const [p, q] = across(a.axis);
  const radius = Math.max(max[p] - at[0], at[0] - min[p], max[q] - at[1], at[1] - min[q]);
  return { axis: a.axis, at, centre, half, radius };
}

function wholeMultiple(value: number, unit: number): number | null {
  const count = value / unit;
  return Math.abs(count - Math.round(count)) < SAME && Math.round(count) > 0
    ? Math.round(count)
    : null;
}

function verticalThroughHoles(reading: PartReading, fit: readonly [number, number]): HoleLine[] {
  const { min, max } = reading.bounds;
  const vertical = roundFeatures(reading.frames).filter(
    (feature) => feature.axis === VERTICAL && feature.radius >= fit[0],
  );
  const holes: HoleLine[] = [];
  for (const feature of vertical) {
    if (holes.some((hole) => sameLine(hole, feature))) continue;
    const onLine = vertical
      .filter((other) => sameLine(other, feature))
      .toSorted((a, b) => a.from - b.from);
    if (Math.min(...onLine.map((other) => other.radius)) > fit[1]) continue;
    let reached = min[VERTICAL];
    for (const segment of onLine)
      if (segment.from <= reached + SAME) reached = Math.max(reached, segment.to);
    if (reached >= max[VERTICAL] - SAME) {
      holes.push({
        axis: VERTICAL,
        at: feature.at,
        from: min[VERTICAL],
        to: max[VERTICAL],
        kind: "round",
      });
    }
  }
  return holes;
}

export function receivesStudsBelow(block: Block, reading: PartReading): boolean {
  const { min } = block.bounds;
  const t = reading.triangles;
  const flat: Array<readonly [number, number]> = [];
  for (let k = 0; k + 8 < t.length; k += 9) {
    const ys = [t[k + 1] ?? 0, t[k + 4] ?? 0, t[k + 7] ?? 0];
    if (ys.every((y) => Math.abs(y - min[1]) < SAME)) {
      for (const v of [0, 3, 6]) flat.push([t[k + v] ?? 0, t[k + v + 2] ?? 0]);
    }
  }
  for (let i = 0; i < block.width; i++) {
    for (let j = 0; j < block.depth; j++) {
      const x0 = min[0] + i * STUD_LDU;
      const z0 = min[2] + j * STUD_LDU;
      const inCell = flat.some(
        ([x, z]) =>
          x >= x0 - SAME &&
          x <= x0 + STUD_LDU + SAME &&
          z >= z0 - SAME &&
          z <= z0 + STUD_LDU + SAME,
      );
      if (!inCell) return false;
    }
  }
  return true;
}

export function blockOf(reading: PartReading, holeFit: readonly [number, number]): Block | null {
  const { min, max } = reading.bounds;
  const width = wholeMultiple(max[0] - min[0], STUD_LDU);
  const depth = wholeMultiple(max[2] - min[2], STUD_LDU);
  const heightPlates = wholeMultiple(max[1] - min[1], PLATE_LDU);
  if (width === null || depth === null || heightPlates === null) return null;
  const connections = connectionFrames(reading.frames);
  if (connections.some((frame) => familyOf(frame.primitive) !== "roundHole")) return null;
  const studs = studsOf(reading);
  const top = studs.filter(
    (stud) => stud.axis === VERTICAL && stud.sign > 0 && Math.abs(stud.origin[1] - max[1]) < SAME,
  );
  const sideStuds = studs.filter((stud) => stud.axis !== VERTICAL);
  if (top.length + sideStuds.length !== studs.length || top.length !== width * depth) return null;
  const onCells = top.every((stud) => {
    const i = (stud.origin[0] - min[0] - STUD_LDU / 2) / STUD_LDU;
    const j = (stud.origin[2] - min[2] - STUD_LDU / 2) / STUD_LDU;
    return Math.abs(i - Math.round(i)) < SAME && Math.abs(j - Math.round(j)) < SAME;
  });
  if (!onCells) return null;
  const primitiveHoles = holeLines(reading.frames).map((line) => ({
    ...line,
    from: min[line.axis],
    to: max[line.axis],
  }));
  const uncapped = (hole: HoleLine): boolean =>
    !top.some(
      (stud) =>
        Math.abs(stud.origin[0] - hole.at[0]) < SAME &&
        Math.abs(stud.origin[2] - hole.at[1]) < SAME,
    );
  const holes = [
    ...primitiveHoles,
    ...verticalThroughHoles(reading, holeFit).filter(
      (hole) => uncapped(hole) && !primitiveHoles.some((known) => sameLine(known, hole)),
    ),
  ];
  return {
    reference: reading.reference,
    width,
    depth,
    heightPlates,
    bounds: reading.bounds,
    holes,
    sideStuds,
  };
}

function clip(polygon: ReadonlyArray<Vec3>, axis: Axis, bound: number, keepAbove: boolean): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    if (!current || !next) continue;
    const a = keepAbove ? current[axis] - bound : bound - current[axis];
    const b = keepAbove ? next[axis] - bound : bound - next[axis];
    if (a >= 0) out.push(current);
    if (a >= 0 !== b >= 0) {
      const t = a / (a - b);
      out.push([
        current[0] + (next[0] - current[0]) * t,
        current[1] + (next[1] - current[1]) * t,
        current[2] + (next[2] - current[2]) * t,
      ]);
    }
  }
  return out;
}

export function roundProfile(
  triangles: Float32Array,
  line: AxisLine,
  from: number,
  to: number,
  down: Vec3 | null = null,
): RoundProfile {
  const [p, q] = across(line.axis);
  const best = new Float64Array(SECTORS);
  const sample = (point: Vec3): void => {
    const u = point[p] - line.at[0];
    const v = point[q] - line.at[1];
    const radius = Math.hypot(u, v);
    if (down && u * down[p] + v * down[q] < CONTACT_CONE_COSINE * radius) return;
    const sector = Math.min(
      SECTORS - 1,
      Math.floor(((Math.atan2(v, u) + Math.PI) / (2 * Math.PI)) * SECTORS),
    );
    if (radius > (best[sector] ?? 0)) best[sector] = radius;
  };
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const l0 = triangles[t + line.axis] ?? 0;
    const l1 = triangles[t + 3 + line.axis] ?? 0;
    const l2 = triangles[t + 6 + line.axis] ?? 0;
    if (Math.max(l0, l1, l2) < from || Math.min(l0, l1, l2) > to) continue;
    const triangle: Vec3[] = [0, 3, 6].map(
      (k) => [triangles[t + k] ?? 0, triangles[t + k + 1] ?? 0, triangles[t + k + 2] ?? 0] as const,
    );
    const polygon = clip(clip(triangle, line.axis, from, true), line.axis, to, false);
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      if (!a || !b) continue;
      const steps = Math.max(
        1,
        Math.ceil(norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) / EDGE_SAMPLE_LDU),
      );
      for (let s = 0; s < steps; s++) {
        const k = s / steps;
        sample([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
      }
    }
  }
  const width = (2 * Math.PI) / SECTORS;
  const downAngle = down ? Math.atan2(down[q], down[p]) : 0;
  let radius = 0;
  let lowest = Infinity;
  for (let sector = 0; sector < SECTORS; sector++) {
    const value = best[sector] ?? 0;
    radius = Math.max(radius, value);
    const centre = -Math.PI + (sector + 0.5) * width;
    const away = Math.abs(Math.atan2(Math.sin(centre - downAngle), Math.cos(centre - downAngle)));
    if (down && away > CONTACT_CONE - width) continue;
    lowest = Math.min(lowest, value);
  }
  return { radius, smooth: radius > 0 && lowest >= SMOOTH_FRACTION * radius };
}

export function rollingContact(
  triangles: Float32Array,
  line: AxisLine,
  from: number,
  to: number,
  outward: Sign,
  down: Vec3 | null,
  minimum: number,
): RoundProfile | null {
  const band = roundProfile(triangles, line, from, to, down);
  if (!band.smooth || band.radius < minimum) return null;
  const outboard =
    outward > 0
      ? roundProfile(triangles, line, to + EDGE_LDU, to + OUTBOARD_REACH_LDU, down)
      : roundProfile(triangles, line, from - OUTBOARD_REACH_LDU, from - EDGE_LDU, down);
  return outboard.radius <= band.radius + OUTBOARD_TOLERANCE_LDU ? band : null;
}
