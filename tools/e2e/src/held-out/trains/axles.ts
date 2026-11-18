import { type SeededRandom } from "../generator.ts";
import { type Vec3 } from "../assembly.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import { type Block, type Sign, VERTICAL, rollingContact, roundProfile } from "./part-geometry.ts";
import {
  BEARING_CLEARANCE_LDU,
  type BearingOption,
  CONTACT_FRACTION,
  type Carrier,
  LATERAL,
  LATERAL_SEARCH_LDU,
  MARGIN_LDU,
  type RailHeadBands,
  SEAT_TRIES,
  bearingOptions,
  footprint,
  pickColor,
  placeAlong,
  placeBlock,
  pointOnLine,
  spacerStack,
} from "./placement.ts";
import type { TrainModel } from "./train-model.ts";
import type { HeadBandContact, PlannedWheelset } from "./train-plan.ts";
import type { AxlePart, TrainPools, WheelPart } from "./train-pools.ts";
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
    const rim = roundProfile(wheel.reading.triangles, wheel.hole, from + i, from + i + 1);
    radius[i] = rim.radius;
    smooth[i] = rim.smooth ? 1 : 0;
  }
  const profile = { from, radius, smooth };
  profiles.set(wheel, profile);
  return profile;
}

function seatCandidate(wheel: WheelPart, seat: WheelSeat, rail: RailHeadBands): boolean {
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

function seatContacts(wheel: WheelPart, seat: WheelSeat, rail: RailHeadBands): boolean {
  const a = seat.sign * (rail.inner - seat.centre);
  const b = seat.sign * (rail.outer - seat.centre);
  const contact = rollingContact(
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

export function positiveSeats(wheel: WheelPart, rail: RailHeadBands): ReadonlyArray<WheelSeat> {
  const seats: WheelSeat[] = [];
  for (const sign of [1, -1] as const) {
    for (let centre = 0; centre <= LATERAL_SEARCH_LDU; centre++) {
      const seat = { sign, centre };
      if (seatCandidate(wheel, seat, rail) && seatContacts(wheel, seat, rail)) seats.push(seat);
    }
  }
  return seats;
}

function inboardSeats(
  wheel: WheelPart,
  rails: ReadonlyArray<RailHeadBands>,
): ReadonlyArray<WheelSeat> {
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

export type AxleMode = "positive" | "gauge miss" | "one head band";

export interface HungAxle {
  readonly wheelset: PlannedWheelset;
  readonly radius: number;
  readonly occupied: readonly [number, number];
}

export interface AxleRequest {
  readonly carrier: Carrier;
  readonly bodyBottom: number;
  readonly xRange: readonly [number, number];
  readonly wheel: WheelPart;
  readonly rail: RailHeadBands;
  readonly rails: ReadonlyArray<RailHeadBands>;
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
  readonly rail: RailHeadBands;
}

function headBand(rail: RailHeadBands, side: Sign): readonly [number, number] {
  return side > 0 ? [rail.inner, rail.outer] : [-rail.outer, -rail.inner];
}

function hangBearing(
  model: TrainModel,
  pools: TrainPools,
  carrier: Carrier,
  option: BearingOption,
  corner: readonly [number, number],
  stack: ReadonlyArray<{ readonly block: Block; readonly turns: number }>,
  color: number,
  unit: string,
): number {
  let previous = carrier.index;
  let top = carrier.bottom;
  for (const spacer of stack) {
    const index = placeBlock(model, pools, spacer.block, spacer.turns, corner, top, color, unit);
    model.join(previous, index);
    previous = index;
    top -= spacer.block.heightPlates * PLATE_LDU;
  }
  const bearing = placeBlock(model, pools, option.block, option.turns, corner, top, color, unit);
  model.join(previous, bearing);
  return bearing;
}

function placeShaft(
  model: TrainModel,
  axle: AxlePart,
  centre: Vec3,
  color: number,
  unit: string,
): number {
  return placeAlong(
    model,
    axle,
    { axis: axle.span.axis, sign: 1 },
    pointOnLine(axle.span.axis, axle.span.at, (axle.span.from + axle.span.to) / 2),
    { axis: LATERAL, sign: 1 },
    centre,
    color,
    unit,
  );
}

function placeWheel(
  model: TrainModel,
  wheel: WheelPart,
  seat: WheelSeat,
  side: Sign,
  axle: readonly [number, number],
  color: number,
  unit: string,
): number {
  return placeAlong(
    model,
    wheel,
    { axis: wheel.hole.axis, sign: 1 },
    pointOnLine(wheel.hole.axis, wheel.hole.at, 0),
    { axis: LATERAL, sign: (seat.sign * side) as Sign },
    [axle[0], axle[1], side * seat.centre],
    color,
    unit,
  );
}

function holeReach(wheel: WheelPart, seat: WheelSeat): number {
  const [near, far] = lateralExtent({ ...wheel, lateral: [wheel.hole.from, wheel.hole.to] }, seat);
  return Math.max(Math.abs(near), Math.abs(far));
}

export function hangSplitAxle(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  request: SplitRequest,
): HungAxle | null {
  const { bogie, body: car, wheel, rail } = request;
  for (const seat of random.shuffled(positiveSeats(wheel, rail)).slice(0, SEAT_TRIES)) {
    const [innerEdge] = lateralExtent(wheel, seat);
    const reach = holeReach(wheel, seat);
    for (const option of random.shuffled(bearingOptions(pools, LATERAL, false))) {
      const [width, depth] = footprint(option.block, option.turns);
      const zSize = depth * STUD_LDU;
      let rightZ: number | null = null;
      for (let z = car.z1 - zSize; z >= Math.max(bogie.z1, 0); z -= STUD_LDU) {
        if (z + zSize <= innerEdge - BEARING_CLEARANCE_LDU) rightZ = z;
      }
      let leftZ: number | null = null;
      for (let z = bogie.z0; z + zSize <= Math.min(bogie.z1, 0); z += STUD_LDU) {
        if (z >= -innerEdge + BEARING_CLEARANCE_LDU) leftZ = z;
      }
      if (leftZ === null || rightZ === null) continue;
      const xs: number[] = [];
      for (let x = bogie.x0; x + width * STUD_LDU <= bogie.x1; x += STUD_LDU) {
        const holeX = x + option.holeX;
        if (
          holeX - wheel.radius >= request.xRange[0] &&
          holeX + wheel.radius <= request.xRange[1]
        ) {
          xs.push(x);
        }
      }
      const x = random.choice(xs);
      if (x === null) continue;
      const clearance = bogie.bottom - option.holeDepth + wheel.radius + MARGIN_LDU - car.bottom;
      const leftPlates = Math.max(0, Math.ceil(clearance / PLATE_LDU));
      const axleY = bogie.bottom - leftPlates * PLATE_LDU - option.holeDepth;
      const rightPlates = (car.bottom - option.holeDepth - axleY) / PLATE_LDU;
      const leftStack = spacerStack(pools, width, depth, leftPlates);
      const rightStack = spacerStack(pools, width, depth, rightPlates);
      const leftInner = leftZ + zSize;
      const leftShaft = axleCovering(pools, (leftInner + reach) / 2, Infinity);
      const rightShaft = axleCovering(pools, (reach - rightZ) / 2, Infinity);
      if (!leftStack || !rightStack || !leftShaft || !rightShaft) continue;
      const checkpoint = model.checkpoint();
      const color = pickColor(random, pools);
      const holeX = x + option.holeX;
      const halves = [
        {
          side: -1 as Sign,
          carrier: bogie,
          stack: leftStack,
          z: leftZ,
          shaft: leftShaft,
          centre: leftInner - (leftShaft.span.to - leftShaft.span.from) / 2,
        },
        {
          side: 1 as Sign,
          carrier: car,
          stack: rightStack,
          z: rightZ,
          shaft: rightShaft,
          centre: rightZ + (rightShaft.span.to - rightShaft.span.from) / 2,
        },
      ];
      const wheels = halves.map(({ side, carrier, stack, z, shaft, centre }) => {
        const bearing = hangBearing(
          model,
          pools,
          carrier,
          option,
          [x, z],
          stack,
          color,
          carrier.unit,
        );
        const axle = placeShaft(
          model,
          shaft,
          [holeX, axleY, centre],
          pickColor(random, pools),
          carrier.unit,
        );
        model.join(axle, bearing);
        const index = placeWheel(model, wheel, seat, side, [holeX, axleY], color, carrier.unit);
        model.join(index, axle);
        return index;
      });
      if (model.collidesSince(checkpoint)) {
        model.rollback(checkpoint);
        continue;
      }
      return {
        wheelset: {
          x: holeX,
          y: axleY,
          unit: bogie.unit,
          instances: wheels,
          rail: rail.part,
          surfaces: wheels.map((instance, k) => {
            const [from, to] = headBand(rail, halves[k]?.side ?? 1);
            return { instance, from, to };
          }),
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
  for (const seat of random.shuffled(seats).slice(0, SEAT_TRIES)) {
    for (const option of random.shuffled(bearingOptions(pools, LATERAL, false))) {
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
  const xCorner = random.choice(xCorners);
  const zCorner = random.choice(zCorners);
  if (xCorner === null || zCorner === null) return null;
  const lateralUnderCarrier = outerEdge > carrier.z0 && innerEdge < carrier.z1;
  const ceiling = lateralUnderCarrier ? carrier.bottom : request.bodyBottom;
  const clearance = carrier.bottom - option.holeDepth + wheel.radius + MARGIN_LDU - ceiling;
  const spacerPlates = Math.max(0, Math.ceil(clearance / PLATE_LDU));
  const stack = spacerStack(pools, width, depth, spacerPlates);
  if (!stack) return null;
  const axleY = carrier.bottom - spacerPlates * PLATE_LDU - option.holeDepth;
  const shaft = axleCovering(
    pools,
    Math.max(holeReach(wheel, seat), Math.abs(zCorner), Math.abs(zCorner + zSize)),
    outerEdge + STUD_LDU * 2,
  );
  if (!shaft) return null;
  const color = pickColor(random, pools);
  const bearing = hangBearing(
    model,
    pools,
    carrier,
    option,
    [xCorner, zCorner],
    stack,
    color,
    request.unit,
  );
  const x = xCorner + option.holeX;
  const axle = placeShaft(model, shaft, [x, axleY, 0], pickColor(random, pools), request.unit);
  model.join(axle, bearing);
  const wheelColor = pickColor(random, pools);
  const instances = request.sides.map((side) => {
    const index = placeWheel(model, wheel, seat, side, [x, axleY], wheelColor, request.unit);
    model.join(index, axle);
    return index;
  });
  const surfaces: HeadBandContact[] = instances.map((instance, k) => {
    const [from, to] = headBand(rail, request.sides[k] ?? 1);
    return { instance, from, to };
  });
  return {
    wheelset: {
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
