import {
  type AxisLine,
  type Block,
  type HoleLine,
  PRIMITIVE_FAMILIES,
  type PinSpan,
  type Span,
  type Stud,
  VERTICAL,
  across,
  axisOf,
  axleSpan,
  blockOf,
  framesOf,
  holeLines,
  pinSpan,
  roundFeatures,
  roundProfile,
  sameLine,
  studsOf,
} from "./part-geometry.ts";
import { type PartReader, type PartReading, type PrimitiveFrame } from "./part-readings.ts";
import {
  type LibraryPart,
  type PinnedLibrary,
  type SubfileLine,
  subfileLines,
} from "./pinned-library.ts";
import { CONTACT_FRACTION, type RailHeadBands } from "./placement.ts";
import type { Vec3 } from "../assembly.ts";
import type { Bundle } from "../bundle.ts";
import { producedColors } from "../generator.ts";

export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface WheelPart {
  readonly reading: PartReading;
  readonly hole: HoleLine;
  readonly lateral: readonly [number, number];
  readonly radius: number;
}

export interface AxlePart {
  readonly reading: PartReading;
  readonly span: Span;
}

export interface PinPart {
  readonly reading: PartReading;
  readonly span: PinSpan;
}

export interface RollingRun {
  readonly from: number;
  readonly to: number;
  readonly radius: number;
}

export interface RollingAxis extends AxisLine {
  readonly runs: ReadonlyArray<RollingRun>;
}

export interface Constituent {
  readonly reference: string;
  readonly inheritsColour: boolean;
  readonly color: number;
  readonly rotation: Mat3;
  readonly position: Vec3;
}

export interface PivotPin {
  readonly at: readonly [number, number];
  readonly collar: number;
  readonly height: number;
}

export interface RunningGearPart {
  readonly reading: PartReading;
  readonly topStuds: ReadonlyArray<Stud>;
  readonly pivotPin: PivotPin | null;
  readonly axes: ReadonlyArray<RollingAxis>;
  readonly constituents: ReadonlyArray<Constituent> | null;
}

export interface TrainPools {
  readonly plates: ReadonlyArray<Block>;
  readonly spacers: ReadonlyArray<Block>;
  readonly bearings: ReadonlyArray<Block>;
  readonly pivotPlates: ReadonlyArray<Block>;
  readonly axles: ReadonlyArray<AxlePart>;
  readonly pins: ReadonlyArray<PinPart>;
  readonly wheels: ReadonlyArray<WheelPart>;
  readonly running: ReadonlyArray<RunningGearPart>;
  readonly readings: ReadonlyMap<string, PartReading>;
  readonly colors: ReadonlyArray<number>;
}

const RIGID_BEARING_STUDS = 2;
const LIBRARY_PART_PREFIX = /^parts\//u;
const ROUND_OUTLINE_TOLERANCE = 0.02;
const OUTER_PRIMITIVE_FRACTION = 0.9;
const RUN_SLAB_LDU = 1;
const WINDOW_LDU = 12;
const INHERITED_COLOUR = 16;
const FIELDS = /\s+/u;
const REFERENCE_FIELD = 14;
const C = [1, -1, -1] as const;
const DOWN: Vec3 = [0, -1, 0];
const HOLE_PLAY_LDU = 1;

function leafPattern(studNames: ReadonlyArray<string>): RegExp {
  const families = Object.values(PRIMITIVE_FAMILIES).map((pattern) =>
    pattern.source.replace(/^\^/u, "").replace(/\$$/u, ""),
  );
  const studs = studNames.map((name) => name.replaceAll(".", "\\."));
  return new RegExp(`^(${[...families, ...studs].join("|")})$`, "u");
}

function has(closure: ReadonlySet<string>, family: keyof typeof PRIMITIVE_FAMILIES): boolean {
  for (const leaf of closure) if (PRIMITIVE_FAMILIES[family].test(leaf)) return true;
  return false;
}

function hasStud(closure: ReadonlySet<string>, studNames: ReadonlyArray<string>): boolean {
  return studNames.some((name) => closure.has(name));
}

function centreOf(reading: PartReading): Vec3 {
  const { min, max } = reading.bounds;
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

function wheelOf(reading: PartReading): WheelPart | null {
  if (reading.studs.length > 0) return null;
  if (reading.frames.some((frame) => /^(axleEnd|pinHalf)$/u.test(familyName(frame.primitive)))) {
    return null;
  }
  const holes = holeLines(reading.frames);
  const [hole] = holes;
  if (!hole || holes.length !== 1) return null;
  const centre = centreOf(reading);
  const [p, q] = across(hole.axis);
  if (Math.abs(hole.at[0] - centre[p]) > 0.01 || Math.abs(hole.at[1] - centre[q]) > 0.01) {
    return null;
  }
  const { min, max } = reading.bounds;
  const radiusP = (max[p] - min[p]) / 2;
  const radiusQ = (max[q] - min[q]) / 2;
  if (Math.abs(radiusP - radiusQ) > ROUND_OUTLINE_TOLERANCE * radiusP) return null;
  const radius = Math.max(radiusP, radiusQ);
  const outer = roundFeatures(reading.frames).some(
    (feature) => sameLine(feature, hole) && feature.radius >= OUTER_PRIMITIVE_FRACTION * radius,
  );
  if (!outer) return null;
  return { reading, hole, lateral: [min[hole.axis], max[hole.axis]], radius };
}

function familyName(primitive: string): string {
  for (const [family, pattern] of Object.entries(PRIMITIVE_FAMILIES)) {
    if (pattern.test(primitive)) return family;
  }
  return "";
}

function rollingRuns(reading: PartReading, line: AxisLine): ReadonlyArray<RollingRun> {
  const { min } = reading.bounds;
  const [p] = across(line.axis);
  const height = line.at[p === VERTICAL ? 0 : 1] - min[VERTICAL];
  const windows = roundFeatures(reading.frames)
    .filter((feature) => sameLine(feature, line) && feature.radius >= CONTACT_FRACTION * height)
    .map(
      (feature) =>
        [Math.floor(feature.from) - WINDOW_LDU, Math.ceil(feature.to) + WINDOW_LDU] as const,
    )
    .toSorted((a, b) => a[0] - b[0]);
  const slabs = new Set<number>();
  for (const [from, to] of windows) for (let at = from; at < to; at += RUN_SLAB_LDU) slabs.add(at);
  const runs: RollingRun[] = [];
  let open: { from: number; to: number; radius: number } | null = null;
  for (const at of [...slabs].toSorted((a, b) => a - b)) {
    const rim = roundProfile(reading.triangles, line, at, at + RUN_SLAB_LDU, DOWN);
    const contact = rim.smooth && rim.radius >= CONTACT_FRACTION * height;
    if (contact && open && open.to === at)
      open = { from: open.from, to: at + RUN_SLAB_LDU, radius: Math.max(open.radius, rim.radius) };
    else {
      if (open) runs.push(open);
      open = contact ? { from: at, to: at + RUN_SLAB_LDU, radius: rim.radius } : null;
    }
  }
  if (open) runs.push(open);
  return runs;
}

function minimumWheelSpread(rails: ReadonlyArray<RailHeadBands>): number {
  const inner = Math.min(...rails.map((rail) => rail.inner));
  const width = Math.max(...rails.map((rail) => rail.outer - rail.inner));
  return 2 * (inner - width);
}

function wheelPairLines(
  frames: ReadonlyArray<PrimitiveFrame>,
  spread: number,
): ReadonlyArray<AxisLine> {
  const features = roundFeatures(frames).filter((feature) => feature.axis !== VERTICAL);
  const lines: AxisLine[] = [];
  for (const feature of features) {
    if (lines.some((line) => sameLine(line, feature))) continue;
    const lateral = features
      .filter((other) => sameLine(other, feature))
      .map((other) => (other.from + other.to) / 2);
    if (Math.max(...lateral) - Math.min(...lateral) >= spread) lines.push(feature);
  }
  return lines;
}

function pivotPinOf(reading: PartReading, clearance: number): PivotPin | null {
  const pins = framesOf(reading.frames, "pinHalf");
  const [pin] = pins;
  if (!pin || pins.length !== 1) return null;
  const oriented = axisOf(pin.columns[1]);
  if (!oriented || oriented.axis !== VERTICAL || oriented.sign < 0) return null;
  const at = [pin.origin[0], pin.origin[2]] as const;
  let collar = -Infinity;
  const { triangles } = reading;
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const x = triangles[i] ?? 0;
    const y = triangles[i + 1] ?? 0;
    const z = triangles[i + 2] ?? 0;
    if (Math.hypot(x - at[0], z - at[1]) > clearance) collar = Math.max(collar, y);
  }
  const height = reading.bounds.max[VERTICAL] - collar;
  return Number.isFinite(collar) && height > 0 ? { at, collar, height } : null;
}

function conjugated(m: ReadonlyArray<number>): Mat3 {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      out.push((C[row] ?? 1) * (m[row * 3 + column] ?? 0) * (C[column] ?? 1) + 0);
    }
  }
  return out as unknown as Mat3;
}

async function constituentsOf(
  library: PinnedLibrary,
  part: LibraryPart,
): Promise<ReadonlyArray<Constituent> | null> {
  if (part.partReferences.length < 2) return null;
  const text = (await library.text(`parts/${part.reference}`)) ?? "";
  const out: Constituent[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(FIELDS);
    if (fields[0] === "0" || fields[0] === "" || fields[0] === undefined) continue;
    if (fields[0] !== "1" || fields.length <= REFERENCE_FIELD) return null;
    const reference = fields.slice(REFERENCE_FIELD).join(" ").replaceAll("\\", "/").toLowerCase();
    if (!part.partReferences.includes(reference)) return null;
    const numbers = fields.slice(1, REFERENCE_FIELD).map(Number);
    const [color = INHERITED_COLOUR, x = 0, y = 0, z = 0, ...rotation] = numbers;
    out.push({
      reference,
      inheritsColour: color === INHERITED_COLOUR,
      color,
      rotation: conjugated(rotation),
      position: [x * C[0], y * C[1], z * C[2]],
    });
  }
  return out.length >= 2 ? out : null;
}

function bundleReferences(bundle: Bundle): ReadonlyArray<string> {
  return [...bundle.parts.values()].map((part) =>
    part.path.replace(LIBRARY_PART_PREFIX, "").toLowerCase(),
  );
}

export async function trainPools(
  bundle: Bundle,
  library: PinnedLibrary,
  reader: PartReader,
  rails: ReadonlyArray<RailHeadBands>,
): Promise<TrainPools> {
  const studNames = bundle.job.studPrimitives;
  const spread = minimumWheelSpread(rails);
  const leaves = leafPattern(studNames);
  const parts = await library.officialParts();
  const closures = new Map<string, ReadonlySet<string>>();
  for (const part of parts) {
    closures.set(part.reference, await library.closure(`parts/${part.reference}`, leaves));
  }
  const where = (test: (closure: ReadonlySet<string>, part: LibraryPart) => boolean): string[] =>
    parts.flatMap((part) => {
      const closure = closures.get(part.reference);
      return closure && test(closure, part) ? [part.reference] : [];
    });
  const inBundle = new Set(bundleReferences(bundle));
  const topLevel = new Map<string, ReadonlyArray<SubfileLine>>();
  for (const part of parts) {
    topLevel.set(
      part.reference,
      subfileLines((await library.text(`parts/${part.reference}`)) ?? ""),
    );
  }
  const studLines = (reference: string): ReadonlyArray<SubfileLine> =>
    (topLevel.get(reference) ?? []).filter((line) => studNames.includes(line.reference));
  const verticalRound = (reference: string): boolean =>
    (topLevel.get(reference) ?? []).some(
      (line) =>
        PRIMITIVE_FAMILIES.round.test(line.reference) &&
        line.localY[0] === 0 &&
        line.localY[2] === 0,
    );
  const blockCandidates = where(
    (closure, part) =>
      (inBundle.has(part.reference) ||
        (studLines(part.reference).length > 0 && verticalRound(part.reference))) &&
      hasStud(closure, studNames) &&
      !has(closure, "pinHalf") &&
      !has(closure, "axleEnd") &&
      !has(closure, "crossHole"),
  );
  const axleCandidates = where(
    (closure) =>
      has(closure, "axleEnd") &&
      !hasStud(closure, studNames) &&
      !has(closure, "roundHole") &&
      !has(closure, "pinHalf"),
  );
  const pinCandidates = where(
    (closure) =>
      has(closure, "pinHalf") &&
      !hasStud(closure, studNames) &&
      !has(closure, "roundHole") &&
      !has(closure, "crossHole") &&
      !has(closure, "axleEnd"),
  );
  const wheelCandidates = where(
    (closure) =>
      (has(closure, "crossHole") || has(closure, "roundHole")) &&
      has(closure, "round") &&
      !hasStud(closure, studNames),
  );
  const runningCandidates = where(
    (closure) => hasStud(closure, studNames) && has(closure, "round"),
  );

  const axles = [...(await reader.read(axleCandidates)).values()].flatMap((reading) => {
    const span = axleSpan(reading);
    return span ? [{ reading, span }] : [];
  });
  const axleRadii = axles
    .map(({ reading, span }) => {
      const [p, q] = across(span.axis);
      const { min, max } = reading.bounds;
      return Math.max(
        max[p] - span.at[0],
        span.at[0] - min[p],
        max[q] - span.at[1],
        span.at[1] - min[q],
      );
    })
    .toSorted((a, b) => a - b);
  const axleRadius = axleRadii[Math.floor(axleRadii.length / 2)] ?? 0;
  const holeFit = [axleRadius, axleRadius + HOLE_PLAY_LDU] as const;
  const blocks = await reader.read(blockCandidates);
  const plates: Block[] = [];
  const spacers: Block[] = [];
  const bearings: Block[] = [];
  const pivotPlates: Block[] = [];
  for (const reading of blocks.values()) {
    const block = blockOf(reading, holeFit);
    if (!block) continue;
    const plain = block.holes.length === 0 && block.sideStuds.length === 0;
    if (plain) spacers.push(block);
    if (plain && block.heightPlates === 1) plates.push(block);
    if (block.sideStuds.length > 0) continue;
    const roundHoles = block.holes.filter((hole) => hole.kind === "round");
    if (roundHoles.length !== block.holes.length || roundHoles.length === 0) continue;
    const rigid = block.width * block.depth >= RIGID_BEARING_STUDS;
    if (rigid && roundHoles.every((hole) => hole.axis !== VERTICAL)) bearings.push(block);
    if (block.heightPlates === 1 && roundHoles.every((hole) => hole.axis === VERTICAL)) {
      pivotPlates.push(block);
    }
  }

  const pins = [...(await reader.read(pinCandidates)).values()].flatMap((reading) => {
    const span = pinSpan(reading);
    return span && span.axis !== VERTICAL ? [{ reading, span }] : [];
  });

  const wheelFrames = await reader.frames(wheelCandidates);
  const roundWheelLike = [...wheelFrames].flatMap(([reference, frames]) => {
    const holes = holeLines(frames);
    const [hole] = holes;
    if (!hole || holes.length !== 1) return [];
    const outer = Math.max(
      0,
      ...roundFeatures(frames)
        .filter((feature) => sameLine(feature, hole))
        .map((feature) => feature.radius),
    );
    return outer > 0 ? [reference] : [];
  });
  const wheels = [...(await reader.read(roundWheelLike)).values()].flatMap((reading) => {
    const wheel = wheelOf(reading);
    return wheel ? [wheel] : [];
  });

  const runningFrames = await reader.frames(runningCandidates);
  const pairLike = [...runningFrames].flatMap(([reference, frames]) =>
    wheelPairLines(frames, spread).length > 0 ? [reference] : [],
  );
  const byReference = new Map(parts.map((part) => [part.reference, part]));
  const running: RunningGearPart[] = [];
  for (const reading of (await reader.read(pairLike)).values()) {
    const { max } = reading.bounds;
    const topStuds = studsOf(reading).filter(
      (stud) =>
        stud.axis === VERTICAL &&
        stud.sign > 0 &&
        Math.abs(stud.origin[VERTICAL] - max[VERTICAL]) < 0.01,
    );
    const pivotPin = pivotPinOf(reading, holeFit[1]);
    if (topStuds.length === 0 && !pivotPin) continue;
    const axes = wheelPairLines(reading.frames, spread)
      .map((line) => ({ ...line, runs: rollingRuns(reading, line) }))
      .filter((line) => line.runs.length >= 2);
    if (axes.length === 0) continue;
    const part = byReference.get(reading.reference);
    running.push({
      reading,
      topStuds,
      pivotPin,
      axes,
      constituents: part ? await constituentsOf(library, part) : null,
    });
  }

  const constituentReferences = running.flatMap((part) =>
    (part.constituents ?? []).map((constituent) => constituent.reference),
  );
  const extra = await reader.read(constituentReferences);
  const readings = new Map<string, PartReading>(extra);
  for (const pool of [plates, spacers, bearings, pivotPlates]) {
    for (const block of pool) {
      const reading = blocks.get(block.reference);
      if (reading) readings.set(block.reference, reading);
    }
  }
  for (const item of [...axles, ...pins, ...wheels, ...running]) {
    readings.set(item.reading.reference, item.reading);
  }
  return {
    plates,
    spacers,
    bearings,
    pivotPlates,
    axles,
    pins,
    wheels,
    running,
    readings,
    colors: producedColors(bundle.parts.values(), bundle.colors),
  };
}
