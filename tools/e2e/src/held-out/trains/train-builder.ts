import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { Vec3 } from "../assembly.ts";
import type { SeededRandom } from "../generator.ts";
import {
  across,
  contactAt,
  rimOver,
  VERTICAL,
  type Axis,
  type AxisLine,
  type Block,
  type HoleLine,
  type Sign,
} from "./part-geometry.ts";
import type { Box, PartReading } from "./part-readings.ts";
import {
  add,
  apply,
  multiply,
  rotationsTaking,
  subtract,
  transformedBox,
  yaw,
  type TrainModel,
} from "./train-model.ts";
import type { AxlePart, Mat3, PinPart, RunningPart, TrainPools, WheelPart } from "./train-pools.ts";

export interface RailBands {
  readonly part: string;
  readonly inner: number;
  readonly outer: number;
}

export interface Carrier {
  readonly index: number;
  readonly unit: string;
  readonly bottom: number;
  readonly top: number;
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

export interface Surface {
  readonly instance: number;
  readonly from: number;
  readonly to: number;
}

export interface WheelLine {
  readonly x: number;
  readonly y: number;
  readonly unit: string;
  readonly instances: ReadonlyArray<number>;
  readonly rail: string | null;
  readonly surfaces: ReadonlyArray<Surface>;
  readonly negative: "gauge miss" | "one head band" | "split across pivot" | null;
}

export interface EndFeature {
  readonly candidates: ReadonlyArray<{ readonly instance: number; readonly tip: Vec3 }>;
  readonly notCandidates: ReadonlyArray<{
    readonly instance: number;
    readonly at: Vec3;
    readonly reason: "inward" | "off-axis" | "buffer";
  }>;
}

const MARGIN_LDU = 1;
const CONTACT_FRACTION = 0.5;
const LATERAL_SEARCH_LDU = 90;
const SEAT_TRIES = 6;
const MAX_PIVOT_PLATES = 9;
const END_TRIES = 8;
const PLAIN_AXLE_LDU = 0.5;
const BODY_SLACK_STUDS = 6;
const BODY_TRIES = 40;
const BEARING_CLEARANCE_LDU = 1;
const UP: { readonly axis: Axis; readonly sign: Sign } = { axis: VERTICAL, sign: 1 };
const LATERAL: Axis = 2;
const TRAVEL: Axis = 0;

export function pick<T>(random: SeededRandom, items: ReadonlyArray<T>): T | null {
  return items.length === 0 ? null : (items[random.int(items.length)] ?? null);
}

export function shuffled<T>(random: SeededRandom, items: ReadonlyArray<T>): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function rotatedBounds(box: Box, rotation: Mat3): Box {
  return transformedBox(box, rotation, [0, 0, 0]);
}

function reading(pools: TrainPools, reference: string): PartReading {
  const found = pools.readings.get(reference);
  if (!found) throw new Error(`no reading for ${reference}`);
  return found;
}

function onLattice(value: number, origin: number): boolean {
  const steps = (value - origin) / STUD_LDU;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

export function placeBlock(
  model: TrainModel,
  pools: TrainPools,
  block: Block,
  turns: number,
  corner: readonly [number, number],
  topY: number,
  color: number,
  unit: string,
): number {
  const rotation = yaw(turns);
  const box = rotatedBounds(block.bounds, rotation);
  return model.place(
    reading(pools, block.reference),
    rotation,
    [corner[0] - box.min[0], topY - box.max[1], corner[1] - box.min[2]],
    color,
    unit,
  );
}

export function placeBlockOn(
  model: TrainModel,
  pools: TrainPools,
  block: Block,
  turns: number,
  corner: readonly [number, number],
  bottomY: number,
  color: number,
  unit: string,
): number {
  const box = rotatedBounds(block.bounds, yaw(turns));
  return placeBlock(
    model,
    pools,
    block,
    turns,
    corner,
    bottomY + box.max[1] - box.min[1],
    color,
    unit,
  );
}

export function footprint(block: Block, turns: number): readonly [number, number] {
  return turns % 2 === 0 ? [block.width, block.depth] : [block.depth, block.width];
}

export function carBody(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  xCentre: number,
  minLength: number,
  unit: string,
  startX: number | null = null,
): Carrier | null {
  const strips = new Map<number, Array<{ plate: Block; turns: number; length: number }>>();
  for (const plate of pools.plates) {
    for (const turns of [0, 1]) {
      const [length, width] = footprint(plate, turns);
      if (width < 4 || width > 8 || width % 2 !== 0) continue;
      strips.set(width, [...(strips.get(width) ?? []), { plate, turns, length }]);
    }
  }
  const width = pick(random, [...strips.keys()]);
  const options = width === null ? [] : (strips.get(width) ?? []);
  if (width === null || options.length === 0) return null;
  const single = options.filter(
    (option) => option.length >= minLength && option.length <= minLength + BODY_SLACK_STUDS,
  );
  const chosen = pick(random, single);
  if (chosen) {
    const x0 = startX ?? xCentre - (chosen.length * STUD_LDU) / 2;
    const z0 = -(width * STUD_LDU) / 2;
    const index = placeBlockOn(
      model,
      pools,
      chosen.plate,
      chosen.turns,
      [x0, z0],
      0,
      pickColor(random, pools),
      unit,
    );
    return {
      index,
      unit,
      bottom: 0,
      top: PLATE_LDU,
      x0,
      z0,
      x1: x0 + chosen.length * STUD_LDU,
      z1: -z0,
    };
  }
  for (let attempt = 0; attempt < BODY_TRIES; attempt++) {
    const lower = composition(random, options, minLength);
    if (!lower) continue;
    const total = lower.reduce((sum, option) => sum + option.length, 0);
    const upper = composition(random, options, total, total);
    if (!upper) continue;
    const lowerSeams = seams(lower);
    if ([...seams(upper)].some((seam) => lowerSeams.has(seam))) continue;
    const x0 = startX ?? xCentre - (total * STUD_LDU) / 2;
    const z0 = -(width * STUD_LDU) / 2;
    const color = pickColor(random, pools);
    let index = -1;
    for (const [row, bottom] of [
      [lower, 0],
      [upper, PLATE_LDU],
    ] as const) {
      let at = x0;
      for (const option of row) {
        const placed = placeBlockOn(
          model,
          pools,
          option.plate,
          option.turns,
          [at, z0],
          bottom,
          color,
          unit,
        );
        if (index < 0) index = placed;
        at += option.length * STUD_LDU;
      }
    }
    return {
      index,
      unit,
      bottom: 0,
      top: 2 * PLATE_LDU,
      x0,
      z0,
      x1: x0 + total * STUD_LDU,
      z1: -z0,
    };
  }
  return null;
}

function seams(row: ReadonlyArray<{ readonly length: number }>): Set<number> {
  const out = new Set<number>();
  let at = 0;
  for (const option of row.slice(0, -1)) out.add((at += option.length));
  return out;
}

function composition<T extends { readonly length: number }>(
  random: SeededRandom,
  options: ReadonlyArray<T>,
  minimum: number,
  exact: number | null = null,
): ReadonlyArray<T> | null {
  const row: T[] = [];
  let total = 0;
  while (exact === null ? total < minimum : total < exact) {
    const fitting = options.filter((option) => exact === null || total + option.length <= exact);
    const next = pick(random, fitting);
    if (!next) return null;
    row.push(next);
    total += next.length;
  }
  return row.length >= 2 && (exact === null || total === exact) ? row : null;
}

export function pickColor(random: SeededRandom, pools: TrainPools): number {
  return pick(random, pools.colors) ?? 0;
}

interface WheelSeat {
  readonly sign: Sign;
  readonly centre: number;
}

function lateralExtent(wheel: WheelPart, seat: WheelSeat): readonly [number, number] {
  const a = seat.centre + seat.sign * wheel.lateral[0];
  const b = seat.centre + seat.sign * wheel.lateral[1];
  return [Math.min(a, b), Math.max(a, b)];
}

interface RimProfile {
  readonly from: number;
  readonly radius: Float64Array;
  readonly smooth: Uint8Array;
}

const profiles = new WeakMap<WheelPart, RimProfile>();

function profileOf(wheel: WheelPart): RimProfile {
  const known = profiles.get(wheel);
  if (known) return known;
  const from = Math.floor(wheel.lateral[0]);
  const slabs = Math.max(0, Math.ceil(wheel.lateral[1]) - from);
  const radius = new Float64Array(slabs);
  const smooth = new Uint8Array(slabs);
  for (let i = 0; i < slabs; i++) {
    const rim = rimOver(wheel.reading.triangles, wheel.hole, from + i, from + i + 1);
    radius[i] = rim.radius;
    smooth[i] = rim.smooth ? 1 : 0;
  }
  const profile = { from, radius, smooth };
  profiles.set(wheel, profile);
  return profile;
}

function seatCandidate(wheel: WheelPart, seat: WheelSeat, rail: RailBands): boolean {
  const profile = profileOf(wheel);
  const a = seat.sign * (rail.inner - seat.centre);
  const b = seat.sign * (rail.outer - seat.centre);
  const low = Math.floor(Math.min(a, b)) - profile.from;
  const high = Math.ceil(Math.max(a, b)) - profile.from;
  if (low < 0 || high > profile.radius.length) return false;
  let band = 0;
  for (let i = low; i < high; i++) {
    if (!profile.smooth[i]) return false;
    band = Math.max(band, profile.radius[i] ?? 0);
  }
  if (band < CONTACT_FRACTION * wheel.radius) return false;
  const outboard = seat.sign > 0 ? [high, profile.radius.length] : [0, low];
  for (let i = outboard[0] ?? 0; i < (outboard[1] ?? 0); i++) {
    if ((profile.radius[i] ?? 0) > band) return false;
  }
  return true;
}

function seatContacts(wheel: WheelPart, seat: WheelSeat, rail: RailBands): boolean {
  const a = seat.sign * (rail.inner - seat.centre);
  const b = seat.sign * (rail.outer - seat.centre);
  const contact = contactAt(
    wheel.reading.triangles,
    wheel.hole,
    Math.min(a, b),
    Math.max(a, b),
    seat.sign,
    null,
    CONTACT_FRACTION * wheel.radius,
  );
  return contact !== null;
}

export function positiveSeats(wheel: WheelPart, rail: RailBands): ReadonlyArray<WheelSeat> {
  const seats: WheelSeat[] = [];
  for (const sign of [1, -1] as const) {
    for (let centre = 0; centre <= LATERAL_SEARCH_LDU; centre++) {
      const seat = { sign, centre };
      if (seatCandidate(wheel, seat, rail) && seatContacts(wheel, seat, rail)) seats.push(seat);
    }
  }
  return seats;
}

function inboardSeats(wheel: WheelPart, rails: ReadonlyArray<RailBands>): ReadonlyArray<WheelSeat> {
  const inner = Math.min(...rails.map((rail) => rail.inner));
  const seats: WheelSeat[] = [];
  for (const sign of [1, -1] as const) {
    for (let centre = 0; centre <= LATERAL_SEARCH_LDU; centre++) {
      const [low, high] = lateralExtent(wheel, { sign, centre });
      if (high < inner - MARGIN_LDU && low > 0) seats.push({ sign, centre });
    }
  }
  return seats;
}

interface BearingOption {
  readonly block: Block;
  readonly turns: number;
  readonly hole: HoleLine;
  readonly holeX: number;
  readonly holeDepth: number;
  readonly box: Box;
}

function bearingOptions(
  pools: TrainPools,
  axis: Axis,
  singleHole: boolean,
): ReadonlyArray<BearingOption> {
  return pools.bearings.flatMap((block) =>
    [0, 1, 2, 3].flatMap((turns) => {
      const rotation = yaw(turns);
      const box = rotatedBounds(block.bounds, rotation);
      const lines = block.holes.flatMap((hole) => {
        const direction: [number, number, number] = [0, 0, 0];
        direction[hole.axis] = 1;
        const rotated = apply(rotation, direction);
        if (Math.abs(rotated[axis]) !== 1) return [];
        const point: [number, number, number] = [0, 0, 0];
        const [p, q] = across(hole.axis);
        point[p] = hole.at[0];
        point[q] = hole.at[1];
        const world = apply(rotation, point);
        return [{ hole, world }];
      });
      if (lines.length === 0 || (singleHole && block.holes.length !== 1)) return [];
      return lines.map(({ hole, world }) => ({
        block,
        turns,
        hole,
        holeX: world[TRAVEL] - box.min[TRAVEL],
        holeDepth: box.max[VERTICAL] - world[VERTICAL],
        box,
      }));
    }),
  );
}

export function spacerStack(
  pools: TrainPools,
  width: number,
  depth: number,
  plates: number,
): ReadonlyArray<{ block: Block; turns: number }> | null {
  const fitting = pools.spacers.flatMap((block) =>
    [0, 1].flatMap((turns) => {
      const [w, d] = footprint(block, turns);
      return w === width && d === depth ? [{ block, turns }] : [];
    }),
  );
  const stack: Array<{ block: Block; turns: number }> = [];
  let left = plates;
  while (left > 0) {
    const next = fitting
      .filter((item) => item.block.heightPlates <= left)
      .toSorted((a, b) => b.block.heightPlates - a.block.heightPlates)[0];
    if (!next) return null;
    stack.push(next);
    left -= next.block.heightPlates;
  }
  return stack;
}

function axleCovering(pools: TrainPools, half: number, maxHalf: number): AxlePart | null {
  return (
    pools.axles
      .filter((axle) => {
        const length = axle.span.to - axle.span.from;
        return length / 2 >= half && length / 2 <= maxHalf;
      })
      .toSorted((a, b) => a.span.to - a.span.from - (b.span.to - b.span.from))[0] ?? null
  );
}

export function placeAlong(
  model: TrainModel,
  part: { readonly reading: PartReading },
  localAxis: { readonly axis: Axis; readonly sign: Sign },
  localPoint: Vec3,
  worldAxis: { readonly axis: Axis; readonly sign: Sign },
  worldPoint: Vec3,
  color: number,
  unit: string,
): number {
  const [rotation] = rotationsTaking(localAxis, worldAxis);
  if (!rotation) throw new Error("no rotation takes the axis");
  return model.place(
    part.reading,
    rotation,
    subtract(worldPoint, apply(rotation, localPoint)),
    color,
    unit,
  );
}

export function pointOnLine(axis: Axis, at: readonly [number, number], along: number): Vec3 {
  const point: [number, number, number] = [0, 0, 0];
  const [p, q] = across(axis);
  point[axis] = along;
  point[p] = at[0];
  point[q] = at[1];
  return point;
}

export const PIVOT_PART_SUFFIX = " pivot";

export type AxleMode = "positive" | "gauge miss" | "one head band";

export interface HungAxle {
  readonly line: WheelLine;
  readonly radius: number;
  readonly occupied: readonly [number, number];
}

export interface AxleRequest {
  readonly carrier: Carrier;
  readonly bodyBottom: number;
  readonly xRange: readonly [number, number];
  readonly wheel: WheelPart;
  readonly rail: RailBands;
  readonly rails: ReadonlyArray<RailBands>;
  readonly mode: AxleMode;
  readonly sides: ReadonlyArray<Sign>;
  readonly lateralRange: readonly [number, number];
  readonly unit: string;
}

export interface SplitRequest {
  readonly bogie: Carrier;
  readonly body: Carrier;
  readonly xRange: readonly [number, number];
  readonly wheel: WheelPart;
  readonly rail: RailBands;
}

export function hangSplitAxle(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  request: SplitRequest,
): HungAxle | null {
  const { bogie, body: car, wheel, rail } = request;
  for (const seat of shuffled(random, positiveSeats(wheel, rail)).slice(0, SEAT_TRIES)) {
    const [innerEdge, outerEdge] = lateralExtent(wheel, seat);
    const holeSpan = lateralExtent({ ...wheel, lateral: [wheel.hole.from, wheel.hole.to] }, seat);
    for (const option of shuffled(random, bearingOptions(pools, LATERAL, false))) {
      const [width, depth] = footprint(option.block, option.turns);
      const zSize = depth * STUD_LDU;
      const leftZ = bogie.z0;
      const rightZ = bogie.z1;
      if (leftZ < -innerEdge + BEARING_CLEARANCE_LDU || leftZ + zSize > 0) continue;
      if (rightZ + zSize > innerEdge - BEARING_CLEARANCE_LDU || rightZ + zSize > car.z1) continue;
      const xs: number[] = [];
      for (let x = bogie.x0; x + width * STUD_LDU <= bogie.x1; x += STUD_LDU) {
        const holeX = x + option.holeX;
        if (holeX - wheel.radius >= request.xRange[0] && holeX + wheel.radius <= request.xRange[1])
          xs.push(x);
      }
      const x = pick(random, xs);
      if (x === null) continue;
      const leftPlates = Math.max(
        0,
        Math.ceil(
          (bogie.bottom - option.holeDepth + wheel.radius + MARGIN_LDU - car.bottom) / PLATE_LDU,
        ),
      );
      const axleY = bogie.bottom - leftPlates * PLATE_LDU - option.holeDepth;
      const rightPlates = (car.bottom - option.holeDepth - axleY) / PLATE_LDU;
      const leftStack = spacerStack(pools, width, depth, leftPlates);
      const rightStack = spacerStack(pools, width, depth, rightPlates);
      const leftAxle = axleCovering(
        pools,
        (Math.max(Math.abs(holeSpan[0]), Math.abs(holeSpan[1])) + Math.abs(leftZ + zSize)) / 2,
        (rightZ - leftZ - zSize) / 2 + outerEdge,
      );
      if (!leftStack || !rightStack || !leftAxle) continue;
      const checkpoint = model.checkpoint();
      const color = pickColor(random, pools);
      const hang = (
        carrier: Carrier,
        stack: ReadonlyArray<{ block: Block; turns: number }>,
        z: number,
        unit: string,
      ): number => {
        let previous = carrier.index;
        let top = carrier.bottom;
        for (const spacer of stack) {
          const index = placeBlock(
            model,
            pools,
            spacer.block,
            spacer.turns,
            [x, z],
            top,
            color,
            unit,
          );
          model.join(previous, index);
          previous = index;
          top -= spacer.block.heightPlates * PLATE_LDU;
        }
        const bearing = placeBlock(
          model,
          pools,
          option.block,
          option.turns,
          [x, z],
          top,
          color,
          unit,
        );
        model.join(previous, bearing);
        return bearing;
      };
      const leftBearing = hang(bogie, leftStack, leftZ, bogie.unit);
      const rightBearing = hang(car, rightStack, rightZ, car.unit);
      const holeX = x + option.holeX;
      const far = Math.max(Math.abs(holeSpan[0]), Math.abs(holeSpan[1]));
      const leftCentre = -(far + Math.abs(leftZ + zSize)) / 2;
      const placeShortAxle = (centre: number, unit: string): number =>
        placeAlong(
          model,
          leftAxle,
          { axis: leftAxle.span.axis, sign: 1 },
          pointOnLine(
            leftAxle.span.axis,
            leftAxle.span.at,
            (leftAxle.span.from + leftAxle.span.to) / 2,
          ),
          { axis: LATERAL, sign: 1 },
          [holeX, axleY, centre],
          pickColor(random, pools),
          unit,
        );
      const leftShaft = placeShortAxle(leftCentre, bogie.unit);
      const rightShaft = placeShortAxle((far + rightZ) / 2, car.unit);
      model.join(leftShaft, leftBearing);
      model.join(rightShaft, rightBearing);
      const wheels = (
        [
          [-1, leftShaft, bogie.unit],
          [1, rightShaft, car.unit],
        ] as const
      ).map(([side, shaft, unit]) => {
        const index = placeAlong(
          model,
          wheel,
          { axis: wheel.hole.axis, sign: 1 },
          pointOnLine(wheel.hole.axis, wheel.hole.at, 0),
          { axis: LATERAL, sign: (seat.sign * side) as Sign },
          [holeX, axleY, side * seat.centre],
          color,
          unit,
        );
        model.join(index, shaft);
        return index;
      });
      if (model.collidesSince(checkpoint)) {
        model.rollback(checkpoint);
        continue;
      }
      return {
        line: {
          x: holeX,
          y: axleY,
          unit: bogie.unit,
          instances: wheels,
          rail: rail.part,
          surfaces: wheels.map((instance, k) => ({
            instance,
            from: k === 0 ? -rail.outer : rail.inner,
            to: k === 0 ? -rail.inner : rail.outer,
          })),
          negative: "split across pivot",
        },
        radius: wheel.radius,
        occupied: [holeX - wheel.radius, holeX + wheel.radius],
      };
    }
  }
  return null;
}

export function hangAxle(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  request: AxleRequest,
): HungAxle | null {
  const { wheel, mode } = request;
  const seats =
    mode === "gauge miss" ? inboardSeats(wheel, request.rails) : positiveSeats(wheel, request.rail);
  for (const seat of shuffled(random, seats).slice(0, SEAT_TRIES)) {
    for (const option of shuffled(random, bearingOptions(pools, LATERAL, false))) {
      const checkpoint = model.checkpoint();
      const hung = hangAxleAt(model, pools, random, request, seat, option);
      if (hung && !model.collidesSince(checkpoint)) return hung;
      model.rollback(checkpoint);
    }
  }
  return null;
}

function hangAxleAt(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  request: AxleRequest,
  seat: WheelSeat,
  option: BearingOption,
): HungAxle | null {
  const { carrier, wheel, rail, mode } = request;
  const [innerEdge, outerEdge] = lateralExtent(wheel, seat);
  const holeSpan = lateralExtent({ ...wheel, lateral: [wheel.hole.from, wheel.hole.to] }, seat);
  const [width, depth] = footprint(option.block, option.turns);
  const bearingHeight = option.box.max[VERTICAL] - option.box.min[VERTICAL];
  if (wheel.radius <= bearingHeight - option.holeDepth + MARGIN_LDU) return null;
  const zSize = depth * STUD_LDU;
  const lowZ = Math.max(request.lateralRange[0], -innerEdge + BEARING_CLEARANCE_LDU);
  const highZ = Math.min(request.lateralRange[1], innerEdge - BEARING_CLEARANCE_LDU);
  const zCorners: number[] = [];
  for (let z = carrier.z0; z + zSize <= carrier.z1; z += STUD_LDU) {
    if (z >= lowZ && z + zSize <= highZ) zCorners.push(z);
  }
  const xCorners: number[] = [];
  for (let x = carrier.x0; x + width * STUD_LDU <= carrier.x1; x += STUD_LDU) {
    const holeX = x + option.holeX;
    const low = Math.min(holeX - wheel.radius, x);
    const high = Math.max(holeX + wheel.radius, x + width * STUD_LDU);
    if (low >= request.xRange[0] && high <= request.xRange[1]) xCorners.push(x);
  }
  const xCorner = pick(random, xCorners);
  const zCorner = pick(random, zCorners);
  if (xCorner === null || zCorner === null) return null;
  const above = carrier.bottom;
  const lateralUnderCarrier = outerEdge > carrier.z0 && innerEdge < carrier.z1;
  const ceiling = lateralUnderCarrier ? carrier.bottom : request.bodyBottom;
  const clearance = above - option.holeDepth + wheel.radius + MARGIN_LDU - ceiling;
  const spacerPlates = Math.max(0, Math.ceil(clearance / PLATE_LDU));
  const stack = spacerStack(pools, width, depth, spacerPlates);
  if (!stack) return null;
  const axleY = above - spacerPlates * PLATE_LDU - option.holeDepth;
  const axle = axleCovering(
    pools,
    Math.max(
      Math.abs(holeSpan[0]),
      Math.abs(holeSpan[1]),
      Math.abs(zCorner),
      Math.abs(zCorner + zSize),
    ),
    outerEdge + STUD_LDU * 2,
  );
  if (!axle) return null;
  const color = pickColor(random, pools);
  let previous = carrier.index;
  let top = above;
  for (const spacer of stack) {
    const index = placeBlock(
      model,
      pools,
      spacer.block,
      spacer.turns,
      [xCorner, zCorner],
      top,
      color,
      request.unit,
    );
    model.join(previous, index);
    previous = index;
    top -= spacer.block.heightPlates * PLATE_LDU;
  }
  const bearing = placeBlock(
    model,
    pools,
    option.block,
    option.turns,
    [xCorner, zCorner],
    top,
    color,
    request.unit,
  );
  model.join(previous, bearing);
  const x = xCorner + option.holeX;
  const axleIndex = placeAlong(
    model,
    axle,
    { axis: axle.span.axis, sign: 1 },
    pointOnLine(axle.span.axis, axle.span.at, (axle.span.from + axle.span.to) / 2),
    { axis: LATERAL, sign: 1 },
    [x, axleY, 0],
    pickColor(random, pools),
    request.unit,
  );
  model.join(axleIndex, bearing);
  const wheelColor = pickColor(random, pools);
  const instances: number[] = [];
  const surfaces: Surface[] = [];
  for (const side of request.sides) {
    const index = placeAlong(
      model,
      wheel,
      { axis: wheel.hole.axis, sign: 1 },
      pointOnLine(wheel.hole.axis, wheel.hole.at, 0),
      { axis: LATERAL, sign: (seat.sign * side) as Sign },
      [x, axleY, side * seat.centre],
      wheelColor,
      request.unit,
    );
    model.join(index, axleIndex);
    instances.push(index);
    surfaces.push({
      instance: index,
      from: side > 0 ? rail.inner : -rail.outer,
      to: side > 0 ? rail.outer : -rail.inner,
    });
  }
  return {
    line: {
      x,
      y: axleY,
      unit: request.unit,
      instances,
      rail: mode === "positive" ? rail.part : null,
      surfaces: mode === "positive" ? surfaces : [],
      negative: mode === "positive" ? null : mode,
    },
    radius: wheel.radius,
    occupied: [x - wheel.radius, x + wheel.radius],
  };
}

export function worldBottom(model: TrainModel, instance: number): number {
  return model.box(instance).min[VERTICAL];
}

interface LocalBand {
  readonly triangles: Float32Array;
  readonly line: AxisLine;
  readonly from: number;
  readonly to: number;
  readonly outward: Sign;
  readonly down: Vec3;
}

function localBand(
  model: TrainModel,
  instance: number,
  line: { readonly x: number; readonly y: number },
  from: number,
  to: number,
): LocalBand | null {
  const placement = model.placements[instance];
  if (!placement) return null;
  const inverse = transpose(placement.rotation);
  const localPoint = apply(inverse, subtract([line.x, line.y, 0], placement.position));
  const localDirection = apply(inverse, [0, 0, 1]);
  const axis = ([0, 1, 2] as const).find((candidate) => Math.abs(localDirection[candidate]) === 1);
  if (axis === undefined) return null;
  const sign = localDirection[axis] > 0 ? 1 : -1;
  const [p, q] = across(axis);
  const a = localPoint[axis] + sign * from;
  const b = localPoint[axis] + sign * to;
  const outwardWorld: Sign = from + to > 0 ? 1 : -1;
  return {
    triangles: placement.reading.triangles,
    line: { axis, at: [localPoint[p], localPoint[q]] },
    from: Math.min(a, b),
    to: Math.max(a, b),
    outward: (outwardWorld * sign) as Sign,
    down: apply(inverse, [0, -1, 0]),
  };
}

export function surfaceContact(
  model: TrainModel,
  surface: Surface,
  line: { readonly x: number; readonly y: number },
): boolean {
  const band = localBand(model, surface.instance, line, surface.from, surface.to);
  if (!band) return false;
  const bottom = line.y - worldBottom(model, surface.instance);
  return (
    contactAt(
      band.triangles,
      band.line,
      band.from,
      band.to,
      band.outward,
      band.down,
      CONTACT_FRACTION * bottom,
    ) !== null
  );
}

export function surfaceAbsent(
  model: TrainModel,
  instance: number,
  line: { readonly x: number; readonly y: number },
  from: number,
  to: number,
): boolean {
  const band = localBand(model, instance, line, from, to);
  return band === null || rimOver(band.triangles, band.line, band.from, band.to).radius === 0;
}

function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export interface PivotOption {
  readonly block: Block;
  readonly turns: number;
  readonly holes: ReadonlyArray<readonly [number, number]>;
  readonly box: Box;
}

export function pivotOptions(pools: TrainPools): ReadonlyArray<PivotOption> {
  return pools.pivots.flatMap((block) =>
    [0, 1].map((turns) => {
      const rotation = yaw(turns);
      const box = rotatedBounds(block.bounds, rotation);
      const holes = block.holes
        .filter((hole) => hole.axis === VERTICAL)
        .map((hole) => {
          const world = apply(rotation, pointOnLine(VERTICAL, hole.at, 0));
          return [world[TRAVEL] - box.min[TRAVEL], world[LATERAL] - box.min[LATERAL]] as const;
        });
      return { block, turns, holes, box };
    }),
  );
}

export interface PivotStack {
  readonly indices: ReadonlyArray<number>;
  readonly carrier: Carrier;
  readonly pivot: readonly [number, number];
}

export function stackAt(
  model: TrainModel,
  pools: TrainPools,
  option: PivotOption,
  corner: readonly [number, number],
  topY: number,
  plates: number,
  color: number,
  unit: string,
  joinTo: number | null,
): ReadonlyArray<number> {
  const indices: number[] = [];
  let previous = joinTo;
  for (let k = 0; k < plates; k++) {
    const index = placeBlock(
      model,
      pools,
      option.block,
      option.turns,
      corner,
      topY - k * PLATE_LDU,
      color,
      unit,
    );
    if (previous !== null) model.join(previous, index);
    indices.push(index);
    previous = index;
  }
  return indices;
}

export interface BogieRequest {
  readonly body: Carrier;
  readonly pivotRange: readonly [number, number];
  readonly unitBody: string;
  readonly unitBogie: string;
  readonly join: "pivot" | "rigid" | "two pivots";
  readonly lengthStuds: number;
  readonly cap: boolean;
}

export interface HungBogie {
  readonly bogie: Carrier;
  readonly pivots: ReadonlyArray<readonly [number, number]>;
  readonly bodyIndices: ReadonlyArray<number>;
  readonly bogieIndices: ReadonlyArray<number>;
  readonly pivotAxles: ReadonlyArray<number>;
}

export function hangBogie(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  request: BogieRequest,
): HungBogie | null {
  const { body } = request;
  const axleLengths = pivotAxles(pools).map((axle) => axle.span.to - axle.span.from);
  const options = pivotOptions(pools);
  const bogieOptions = options.filter((option) => {
    const [length] = footprint(option.block, option.turns);
    return (
      length >= request.lengthStuds &&
      option.holes.length >= (request.join === "two pivots" ? 2 : 1)
    );
  });
  const ordered = shuffled(random, bogieOptions).toSorted(
    (a, b) => footprint(a.block, a.turns)[0] - footprint(b.block, b.turns)[0],
  );
  for (const bogieOption of ordered) {
    const holes =
      request.join === "two pivots"
        ? pickTwo(random, bogieOption.holes)
        : [pick(random, bogieOption.holes)];
    if (holes.some((hole) => hole === null)) continue;
    const firstHole = holes[0];
    if (!firstHole) continue;
    const zCorner = -firstHole[1];
    const xCorners: number[] = [];
    const [length, width] = footprint(bogieOption.block, bogieOption.turns);
    for (let x = body.x0; x <= body.x1; x += STUD_LDU) {
      const pivotX = x + firstHole[0];
      if (pivotX < request.pivotRange[0] || pivotX > request.pivotRange[1]) continue;
      if (x < body.x0 || x + length * STUD_LDU > body.x1) continue;
      xCorners.push(x);
    }
    const xCorner = pick(random, xCorners);
    if (xCorner === null || zCorner < body.z0 || zCorner + width * STUD_LDU > body.z1) continue;
    const pivots = holes.flatMap((hole) =>
      hole ? [[xCorner + hole[0], zCorner + hole[1]] as const] : [],
    );
    const bodyOptions = options.filter((option) => option.holes.length > 0);
    const color = pickColor(random, pools);
    const checkpoint = model.checkpoint();
    if (request.join === "rigid") {
      if (!onLattice(xCorner, body.x0) || !onLattice(zCorner, body.z0)) continue;
      const placed = clearStackUnder(
        model,
        pools,
        random,
        body,
        bodyOptions,
        pivots[0] ?? [0, 0],
        1,
        request.unitBody,
      );
      if (!placed) continue;
      const bogieIndices = stackAt(
        model,
        pools,
        bogieOption,
        [xCorner, zCorner],
        placed.bottom,
        1,
        color,
        request.unitBogie,
        placed.indices.at(-1) ?? null,
      );
      const rigid = finishBogie(
        bogieOption,
        xCorner,
        zCorner,
        placed.bottom - PLATE_LDU,
        pivots,
        placed.indices,
        bogieIndices,
        [],
        request.unitBogie,
      );
      if (rigid && !model.collidesSince(checkpoint)) return rigid;
      model.rollback(checkpoint);
      continue;
    }
    const total = pick(random, axleLengths);
    const axle = pivotAxles(pools).find(
      (candidate) => candidate.span.to - candidate.span.from === total,
    );
    if (total === null || !axle) return null;
    const gapPlates = request.cap ? 2 : 1;
    const plates = total / PLATE_LDU - gapPlates;
    if (plates < 2) continue;
    const bodyPlates = 1 + random.int(plates - 1);
    const bogiePlates = plates - bodyPlates;
    const bodyIndices: number[] = [];
    for (const pivot of pivots) {
      const placed = clearStackUnder(
        model,
        pools,
        random,
        body,
        bodyOptions,
        pivot,
        bodyPlates,
        request.unitBody,
      );
      if (!placed) break;
      bodyIndices.push(...placed.indices);
    }
    if (bodyIndices.length !== pivots.length * bodyPlates) {
      model.rollback(checkpoint);
      continue;
    }
    const bogieTop = body.bottom - (bodyPlates + gapPlates) * PLATE_LDU;
    const bogieIndices = stackAt(
      model,
      pools,
      bogieOption,
      [xCorner, zCorner],
      bogieTop,
      bogiePlates,
      color,
      request.unitBogie,
      null,
    );
    const bogieBottom = bogieTop - bogiePlates * PLATE_LDU;
    const pivotPins = pivots.map((pivot) => {
      const index = placeAlong(
        model,
        axle,
        { axis: axle.span.axis, sign: 1 },
        pointOnLine(axle.span.axis, axle.span.at, axle.span.from),
        UP,
        [pivot[0], bogieBottom, pivot[1]],
        pickColor(random, pools),
        `${request.unitBogie}${PIVOT_PART_SUFFIX}`,
      );
      for (const member of [...bodyIndices, ...bogieIndices]) model.join(index, member);
      if (request.cap) {
        const bush = capOn(
          model,
          pools,
          random,
          pivot,
          body.bottom - bodyPlates * PLATE_LDU,
          `${request.unitBogie}${PIVOT_PART_SUFFIX}`,
        );
        if (bush !== null) model.join(bush, index);
      }
      return index;
    });
    const pivoted = finishBogie(
      bogieOption,
      xCorner,
      zCorner,
      bogieBottom,
      pivots,
      bodyIndices,
      bogieIndices,
      pivotPins,
      request.unitBogie,
    );
    if (pivoted && !model.collidesSince(checkpoint)) return pivoted;
    model.rollback(checkpoint);
  }
  return null;
}

function capOn(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  pivot: readonly [number, number],
  ceiling: number,
  unit: string,
): number | null {
  const bushes = pools.wheels.filter(
    (wheel) => wheel.hole.kind === "cross" && wheel.lateral[1] - wheel.lateral[0] <= PLATE_LDU,
  );
  const bush = pick(random, bushes);
  if (!bush) return null;
  return placeAlong(
    model,
    bush,
    { axis: bush.hole.axis, sign: 1 },
    pointOnLine(bush.hole.axis, bush.hole.at, bush.lateral[1]),
    UP,
    [pivot[0], ceiling, pivot[1]],
    pickColor(random, pools),
    unit,
  );
}

function pickTwo(
  random: SeededRandom,
  items: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<readonly [number, number] | null> {
  const order = items.toSorted((a, b) => a[0] - b[0]);
  const first = order[random.int(Math.max(1, Math.floor(order.length / 3)))] ?? null;
  const last =
    order[order.length - 1 - random.int(Math.max(1, Math.floor(order.length / 3)))] ?? null;
  return first === last ? [first, null] : [first, last];
}

export function pivotAxles(pools: TrainPools): ReadonlyArray<AxlePart> {
  return pools.axles.filter((axle) => {
    const plates = (axle.span.to - axle.span.from) / PLATE_LDU - 1;
    const { min, max } = axle.reading.bounds;
    const plain =
      max[axle.span.axis] - axle.span.to <= PLAIN_AXLE_LDU &&
      axle.span.from - min[axle.span.axis] <= PLAIN_AXLE_LDU;
    return plain && Number.isInteger(plates) && plates >= 2 && plates <= MAX_PIVOT_PLATES;
  });
}

function finishBogie(
  option: PivotOption,
  xCorner: number,
  zCorner: number,
  bottom: number,
  pivots: ReadonlyArray<readonly [number, number]>,
  bodyIndices: ReadonlyArray<number>,
  bogieIndices: ReadonlyArray<number>,
  pivotPins: ReadonlyArray<number>,
  unit: string,
): HungBogie | null {
  const index = bogieIndices.at(-1);
  if (index === undefined) return null;
  const [length, width] = footprint(option.block, option.turns);
  return {
    bogie: {
      index,
      unit,
      bottom,
      top: bottom + bogieIndices.length * PLATE_LDU,
      x0: xCorner,
      z0: zCorner,
      x1: xCorner + length * STUD_LDU,
      z1: zCorner + width * STUD_LDU,
    },
    pivots,
    bodyIndices,
    bogieIndices,
    pivotAxles: pivotPins,
  };
}

function clearStackUnder(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  options: ReadonlyArray<PivotOption>,
  pivot: readonly [number, number],
  plates: number,
  unit: string,
): { readonly indices: ReadonlyArray<number>; readonly bottom: number } | null {
  for (const option of shuffled(random, options)) {
    const checkpoint = model.checkpoint();
    const placed = pivotStackUnder(model, pools, random, body, option, pivot, plates, unit);
    if (placed && !model.collidesSince(checkpoint)) return placed;
    model.rollback(checkpoint);
  }
  return null;
}

function pivotStackUnder(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  option: PivotOption,
  pivot: readonly [number, number],
  plates: number,
  unit: string,
): { readonly indices: ReadonlyArray<number>; readonly bottom: number } | null {
  const [length, width] = footprint(option.block, option.turns);
  for (const hole of shuffled(random, option.holes)) {
    const corner = [pivot[0] - hole[0], pivot[1] - hole[1]] as const;
    if (!onLattice(corner[0], body.x0) || !onLattice(corner[1], body.z0)) continue;
    if (corner[0] < body.x0 || corner[0] + length * STUD_LDU > body.x1) continue;
    if (corner[1] < body.z0 || corner[1] + width * STUD_LDU > body.z1) continue;
    const indices = stackAt(
      model,
      pools,
      option,
      corner,
      body.bottom,
      plates,
      pickColor(random, pools),
      unit,
      body.index,
    );
    return { indices, bottom: body.bottom - plates * PLATE_LDU };
  }
  return null;
}

export interface MountedRunningPart {
  readonly lines: ReadonlyArray<WheelLine>;
  readonly indices: ReadonlyArray<number>;
  readonly occupied: readonly [number, number];
  readonly pivot: readonly [number, number] | null;
}

function lateralRotation(
  part: RunningPart,
  random: SeededRandom,
): { readonly rotation: Mat3; readonly line: RunningPart["lines"][number] } | null {
  const line = pick(random, part.lines);
  if (!line) return null;
  const [rotation] = rotationsTaking(
    { axis: line.axis, sign: 1 },
    { axis: LATERAL, sign: 1 },
  ).filter((candidate) => apply(candidate, [0, 1, 0])[VERTICAL] === 1);
  return rotation ? { rotation, line } : null;
}

function placeRunningPart(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  part: RunningPart,
  rotation: Mat3,
  position: Vec3,
  explode: boolean,
  unit: string,
): ReadonlyArray<number> | null {
  const color = pickColor(random, pools);
  if (!explode || !part.constituents)
    return [model.place(part.reading, rotation, position, color, unit)];
  const indices: number[] = [];
  for (const constituent of part.constituents) {
    const piece = pools.readings.get(constituent.reference);
    if (!piece) return null;
    indices.push(
      model.place(
        piece,
        multiply(rotation, constituent.rotation),
        add(position, apply(rotation, constituent.position)),
        constituent.inheritsColour ? color : constituent.color,
        unit,
      ),
    );
  }
  for (const a of indices) for (const b of indices) if (a < b) model.join(a, b);
  return indices;
}

function runningLines(
  model: TrainModel,
  part: RunningPart,
  indices: ReadonlyArray<number>,
  rotation: Mat3,
  position: Vec3,
  rails: ReadonlyArray<RailBands>,
  unit: string,
): ReadonlyArray<WheelLine> {
  return part.lines.map((each) => {
    const point = add(position, apply(rotation, pointOnLine(each.axis, each.at, 0)));
    const wheelLine = { x: point[TRAVEL], y: point[VERTICAL] };
    const contact = (rail: RailBands, side: number): number | undefined => {
      const from = side > 0 ? rail.inner : -rail.outer;
      const to = side > 0 ? rail.outer : -rail.inner;
      return indices.find((instance) => surfaceContact(model, { instance, from, to }, wheelLine));
    };
    const rail = rails.find((candidate) =>
      [1, -1].every((side) => contact(candidate, side) !== undefined),
    );
    const surfaces = rail
      ? [1, -1].flatMap((side) => {
          const instance = contact(rail, side);
          return instance === undefined
            ? []
            : [
                {
                  instance,
                  from: side > 0 ? rail.inner : -rail.outer,
                  to: side > 0 ? rail.outer : -rail.inner,
                },
              ];
        })
      : [];
    return {
      ...wheelLine,
      unit,
      instances: indices,
      rail: rail ? rail.part : null,
      surfaces,
      negative: null,
    };
  });
}

function midline(
  part: RunningPart,
  line: RunningPart["lines"][number],
  rotation: Mat3,
): Vec3 | null {
  const first = line.runs[0];
  const last = line.runs.at(-1);
  if (!first || !last) return null;
  return apply(rotation, pointOnLine(line.axis, line.at, (first.from + last.to) / 2));
}

export function mountRunningPart(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  carrier: Carrier,
  part: RunningPart,
  xRange: readonly [number, number],
  rails: ReadonlyArray<RailBands>,
  explode: boolean,
  unit: string,
): MountedRunningPart | null {
  const oriented = lateralRotation(part, random);
  if (!oriented || part.topStuds.length === 0) return null;
  const { rotation, line } = oriented;
  const box = rotatedBounds(part.reading.bounds, rotation);
  const mid = midline(part, line, rotation);
  if (!mid) return null;
  const studs = part.topStuds.map((stud) => apply(rotation, stud.origin));
  const z = -mid[LATERAL];
  if (!studs.every((stud) => onLattice(stud[LATERAL] + z - STUD_LDU / 2, carrier.z0))) return null;
  const xs: number[] = [];
  for (let x = carrier.x0 - box.min[TRAVEL]; x + box.max[TRAVEL] <= carrier.x1; x += STUD_LDU / 2) {
    if (!studs.every((stud) => onLattice(stud[TRAVEL] + x - STUD_LDU / 2, carrier.x0))) continue;
    if (x + box.min[TRAVEL] < xRange[0] || x + box.max[TRAVEL] > xRange[1]) continue;
    xs.push(x);
  }
  for (const x of shuffled(random, xs).slice(0, SEAT_TRIES)) {
    const checkpoint = model.checkpoint();
    const position: Vec3 = [x, carrier.bottom - box.max[VERTICAL], z];
    const indices = placeRunningPart(model, pools, random, part, rotation, position, explode, unit);
    if (indices && !model.collidesSince(checkpoint)) {
      for (const index of indices) model.join(index, carrier.index);
      return {
        lines: runningLines(model, part, indices, rotation, position, rails, unit),
        indices,
        occupied: [x + box.min[TRAVEL], x + box.max[TRAVEL]],
        pivot: null,
      };
    }
    model.rollback(checkpoint);
  }
  return null;
}

export function mountPinBogie(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  part: RunningPart,
  pivotRange: readonly [number, number],
  rails: ReadonlyArray<RailBands>,
  unitBody: string,
  unitBogie: string,
): MountedRunningPart | null {
  const pin = part.pivotPin;
  const oriented = lateralRotation(part, random);
  if (!pin || !oriented) return null;
  const { rotation } = oriented;
  const plates = Math.ceil(pin.height / PLATE_LDU);
  const box = rotatedBounds(part.reading.bounds, rotation);
  const pinWorld = apply(rotation, [pin.at[0], 0, pin.at[1]]);
  for (const option of shuffled(random, pivotOptions(pools))) {
    for (const hole of shuffled(random, option.holes)) {
      const [length, width] = footprint(option.block, option.turns);
      const xs: number[] = [];
      for (let x = body.x0; x + length * STUD_LDU <= body.x1; x += STUD_LDU) {
        const pivotX = x + hole[0];
        if (pivotX >= pivotRange[0] && pivotX <= pivotRange[1]) xs.push(x);
      }
      const zCorner = -hole[1];
      if (!onLattice(zCorner, body.z0) || zCorner < body.z0 || zCorner + width * STUD_LDU > body.z1)
        continue;
      for (const x of shuffled(random, xs).slice(0, SEAT_TRIES)) {
        const checkpoint = model.checkpoint();
        const stack = stackAt(
          model,
          pools,
          option,
          [x, zCorner],
          body.bottom,
          plates,
          pickColor(random, pools),
          unitBody,
          body.index,
        );
        const pivot = [x + hole[0], 0] as const;
        const collar = body.bottom - plates * PLATE_LDU;
        const position: Vec3 = [
          pivot[0] - pinWorld[0],
          collar - pin.collar,
          pivot[1] - pinWorld[2],
        ];
        const indices = placeRunningPart(
          model,
          pools,
          random,
          part,
          rotation,
          position,
          false,
          unitBogie,
        );
        for (const index of indices ?? []) for (const member of stack) model.join(index, member);
        if (indices && !model.collidesSince(checkpoint)) {
          return {
            lines: runningLines(model, part, indices, rotation, position, rails, unitBogie),
            indices,
            occupied: [position[TRAVEL] + box.min[TRAVEL], position[TRAVEL] + box.max[TRAVEL]],
            pivot,
          };
        }
        model.rollback(checkpoint);
      }
    }
  }
  return null;
}

export type EndVariant = "pin" | "pin and buffer" | "pin and outer pin" | "off-axis pin";

export function endFeature(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  end: Sign,
  variant: EndVariant,
  unit: string,
): EndFeature | null {
  for (let attempt = 0; attempt < END_TRIES; attempt++) {
    const checkpoint = model.checkpoint();
    const feature = endFeatureOnce(model, pools, random, body, end, variant, unit);
    if (feature && !model.collidesSince(checkpoint)) return feature;
    model.rollback(checkpoint);
  }
  return null;
}

function endFeatureOnce(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  end: Sign,
  variant: EndVariant,
  unit: string,
): EndFeature | null {
  const axis: Axis = variant === "off-axis pin" ? LATERAL : TRAVEL;
  const pin = pick(random, pools.pins);
  if (!pin) return null;
  const xEnd = end > 0 ? body.x1 : body.x0;
  for (const option of shuffled(random, bearingOptions(pools, axis, true))) {
    const [width, depth] = footprint(option.block, option.turns);
    const xSize = width * STUD_LDU;
    const zSize = depth * STUD_LDU;
    const xCorner = end > 0 ? xEnd - xSize : xEnd;
    const zCorner =
      body.z0 + STUD_LDU * random.int(Math.max(1, (body.z1 - body.z0 - zSize) / STUD_LDU + 1));
    if (zCorner + zSize > body.z1) continue;
    const brick = placeBlockOn(
      model,
      pools,
      option.block,
      option.turns,
      [xCorner, zCorner],
      body.top,
      pickColor(random, pools),
      unit,
    );
    model.join(brick, body.index);
    const holeY =
      body.top + (option.box.max[VERTICAL] - option.box.min[VERTICAL]) - option.holeDepth;
    const brickBox = model.box(brick);
    if (axis === TRAVEL) {
      const holeZ = holeLateral(model, brick, option);
      const pinIndex = placePin(
        model,
        pools,
        random,
        pin,
        { axis: TRAVEL, sign: end },
        [xEnd, holeY, holeZ],
        unit,
      );
      model.join(pinIndex, brick);
      const innerX = end > 0 ? brickBox.min[TRAVEL] : brickBox.max[TRAVEL];
      const candidates = [
        { instance: pinIndex, tip: [xEnd + end * pin.span.half, holeY, holeZ] as Vec3 },
      ];
      const notCandidates: Array<EndFeature["notCandidates"][number]> = [
        { instance: brick, at: [innerX, holeY, holeZ], reason: "inward" },
      ];
      if (variant === "pin") return { candidates, notCandidates };
      const reach = Math.ceil((pin.span.half + 1) / STUD_LDU);
      const buffer = overhang(
        model,
        pools,
        random,
        body,
        end,
        reach + 1,
        [zCorner, zCorner + zSize],
        unit,
      );
      if (!buffer) return null;
      notCandidates.push({ instance: buffer.index, at: buffer.tip, reason: "buffer" });
      if (variant === "pin and buffer") return { candidates, notCandidates };
      const outer = outerPin(model, pools, random, buffer, end, pin, unit);
      if (!outer) return null;
      const ordered = [...outer.candidates, ...candidates].toSorted(
        (a, b) => end * (b.tip[TRAVEL] - a.tip[TRAVEL]),
      );
      return { candidates: ordered, notCandidates: [...notCandidates, ...outer.notCandidates] };
    }
    const holeX = brickBox.min[TRAVEL] + option.holeX;
    const side: Sign = zCorner + zSize / 2 >= 0 ? 1 : -1;
    const faceZ = side > 0 ? brickBox.max[LATERAL] : brickBox.min[LATERAL];
    const pinIndex = placePin(
      model,
      pools,
      random,
      pin,
      { axis: LATERAL, sign: side },
      [holeX, holeY, faceZ],
      unit,
    );
    model.join(pinIndex, brick);
    return {
      candidates: [],
      notCandidates: [
        {
          instance: pinIndex,
          at: [holeX, holeY, faceZ + side * pin.span.half],
          reason: "off-axis",
        },
        {
          instance: brick,
          at: [holeX, holeY, side > 0 ? brickBox.min[LATERAL] : brickBox.max[LATERAL]],
          reason: "off-axis",
        },
      ],
    };
  }
  return null;
}

function holeLateral(model: TrainModel, brick: number, option: BearingOption): number {
  const placement = model.placements[brick];
  if (!placement) return 0;
  const world = add(
    placement.position,
    apply(placement.rotation, pointOnLine(option.hole.axis, option.hole.at, 0)),
  );
  return world[LATERAL];
}

function placePin(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  pin: PinPart,
  direction: { readonly axis: Axis; readonly sign: Sign },
  collar: Vec3,
  unit: string,
): number {
  return placeAlong(
    model,
    pin,
    { axis: pin.span.axis, sign: 1 },
    pointOnLine(pin.span.axis, pin.span.at, pin.span.centre),
    direction,
    collar,
    pickColor(random, pools),
    unit,
  );
}

interface Overhang {
  readonly index: number;
  readonly tip: Vec3;
  readonly top: number;
  readonly outer: number;
  readonly z: readonly [number, number];
}

function overhang(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  end: Sign,
  reach: number,
  avoid: readonly [number, number],
  unit: string,
): Overhang | null {
  for (const plate of shuffled(random, pools.plates)) {
    for (const turns of [0, 1]) {
      const [length, width] = footprint(plate, turns);
      if (length < reach + 1 || width > 2) continue;
      const zSize = width * STUD_LDU;
      const zCorners: number[] = [];
      for (let z = body.z0; z + zSize <= body.z1; z += STUD_LDU) {
        if (z + zSize <= avoid[0] || z >= avoid[1]) zCorners.push(z);
      }
      const zCorner = pick(random, zCorners);
      if (zCorner === null) continue;
      const outer = (end > 0 ? body.x1 : body.x0) + end * reach * STUD_LDU;
      const xCorner = end > 0 ? outer - length * STUD_LDU : outer;
      const index = placeBlockOn(
        model,
        pools,
        plate,
        turns,
        [xCorner, zCorner],
        body.top,
        pickColor(random, pools),
        unit,
      );
      model.join(index, body.index);
      return {
        index,
        tip: [outer, body.top + PLATE_LDU / 2, zCorner + zSize / 2],
        top: body.top + PLATE_LDU,
        outer,
        z: [zCorner, zCorner + zSize],
      };
    }
  }
  return null;
}

function outerPin(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  base: Overhang,
  end: Sign,
  pin: PinPart,
  unit: string,
): EndFeature | null {
  for (const option of shuffled(random, bearingOptions(pools, TRAVEL, true))) {
    const [width, depth] = footprint(option.block, option.turns);
    if (depth * STUD_LDU > base.z[1] - base.z[0]) continue;
    const xCorner = end > 0 ? base.outer - width * STUD_LDU : base.outer;
    const brick = placeBlockOn(
      model,
      pools,
      option.block,
      option.turns,
      [xCorner, base.z[0]],
      base.top,
      pickColor(random, pools),
      unit,
    );
    model.join(brick, base.index);
    const brickBox = model.box(brick);
    const holeY =
      base.top + (option.box.max[VERTICAL] - option.box.min[VERTICAL]) - option.holeDepth;
    const holeZ = holeLateral(model, brick, option);
    const pinIndex = placePin(
      model,
      pools,
      random,
      pin,
      { axis: TRAVEL, sign: end },
      [base.outer, holeY, holeZ],
      unit,
    );
    model.join(pinIndex, brick);
    const innerX = end > 0 ? brickBox.min[TRAVEL] : brickBox.max[TRAVEL];
    return {
      candidates: [{ instance: pinIndex, tip: [base.outer + end * pin.span.half, holeY, holeZ] }],
      notCandidates: [{ instance: brick, at: [innerX, holeY, holeZ], reason: "inward" }],
    };
  }
  return null;
}

export function verticalLink(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  pivot: readonly [number, number],
  bottom: number,
  top: number,
  members: ReadonlyArray<number>,
  unit: string,
): number | null {
  const axle = pick(
    random,
    pivotAxles(pools).filter(
      (candidate) => candidate.span.to - candidate.span.from === top - bottom,
    ),
  );
  if (!axle) return null;
  const index = placeAlong(
    model,
    axle,
    { axis: axle.span.axis, sign: 1 },
    pointOnLine(axle.span.axis, axle.span.at, axle.span.from),
    UP,
    [pivot[0], bottom, pivot[1]],
    pickColor(random, pools),
    unit,
  );
  for (const member of members) model.join(index, member);
  return index;
}

export function linkLengths(pools: TrainPools): ReadonlyArray<number> {
  return [...new Set(pivotAxles(pools).map((axle) => axle.span.to - axle.span.from))].toSorted(
    (a, b) => a - b,
  );
}

export interface PlacedStack {
  readonly indices: ReadonlyArray<number>;
  readonly pivot: readonly [number, number];
  readonly box: Box;
}

export function stackWithHoleAt(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  options: ReadonlyArray<PivotOption>,
  pivot: readonly [number, number],
  topY: number,
  plates: number,
  latticeX: number,
  latticeZ: number,
  fits: (box: Box) => boolean,
  unit: string,
  joinTo: number | null,
): PlacedStack | null {
  for (const option of shuffled(random, options)) {
    for (const hole of shuffled(random, option.holes)) {
      const corner = [pivot[0] - hole[0], pivot[1] - hole[1]] as const;
      if (!onLattice(corner[0], latticeX) || !onLattice(corner[1], latticeZ)) continue;
      const box = {
        min: [corner[0], topY - plates * PLATE_LDU, corner[1]] as const,
        max: [
          corner[0] + (option.box.max[0] - option.box.min[0]),
          topY,
          corner[1] + (option.box.max[2] - option.box.min[2]),
        ] as const,
      };
      if (!fits(box)) continue;
      const checkpoint = model.checkpoint();
      const indices = stackAt(
        model,
        pools,
        option,
        corner,
        topY,
        plates,
        pickColor(random, pools),
        unit,
        joinTo,
      );
      if (!model.collidesSince(checkpoint)) return { indices, pivot, box };
      model.rollback(checkpoint);
    }
  }
  return null;
}
