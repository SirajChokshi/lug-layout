import { type SeededRandom } from "../generator.ts";
import { type Vec3 } from "../assembly.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import { meetsHeadBand } from "./head-band-contact.ts";
import { VERTICAL } from "./part-geometry.ts";
import { pivotOptions, stackAt } from "./pivot-stacks.ts";
import {
  type Carrier,
  LATERAL,
  type RailHeadBands,
  SEAT_TRIES,
  TRAVEL,
  footprint,
  headBandSpan,
  onLattice,
  pickColor,
  pointOnLine,
  rotatedBounds,
} from "./placement.ts";
import { type TrainModel, add, apply, multiply, rotationsTaking } from "./train-model.ts";
import type { PlannedWheelset } from "./train-plan.ts";
import type { Mat3, RunningGearPart, TrainPools } from "./train-pools.ts";
export interface MountedRunningGear {
  readonly wheelsets: ReadonlyArray<PlannedWheelset>;
  readonly indices: ReadonlyArray<number>;
  readonly occupied: readonly [number, number];
  readonly pivot: readonly [number, number] | null;
}

function lateralRotation(
  part: RunningGearPart,
  random: SeededRandom,
): { readonly rotation: Mat3; readonly line: RunningGearPart["axes"][number] } | null {
  const line = random.choice(part.axes);
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
  part: RunningGearPart,
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

function plannedWheelsets(
  model: TrainModel,
  part: RunningGearPart,
  indices: ReadonlyArray<number>,
  rotation: Mat3,
  position: Vec3,
  rails: ReadonlyArray<RailHeadBands>,
  unit: string,
): ReadonlyArray<PlannedWheelset> {
  return part.axes.map((each) => {
    const point = add(position, apply(rotation, pointOnLine(each.axis, each.at, 0)));
    const wheelLine = { x: point[TRAVEL], y: point[VERTICAL] };
    const contact = (rail: RailHeadBands, side: number): number | undefined =>
      indices.find((instance) =>
        meetsHeadBand(model, { instance, headBand: headBandSpan(rail, side) }, wheelLine),
      );
    const rail = rails.find((candidate) =>
      [1, -1].every((side) => contact(candidate, side) !== undefined),
    );
    const rollingSurfaces = rail
      ? [1, -1].flatMap((side) => {
          const instance = contact(rail, side);
          return instance === undefined ? [] : [{ instance, headBand: headBandSpan(rail, side) }];
        })
      : [];
    return {
      ...wheelLine,
      contactRadius: null,
      unit,
      instances: indices,
      rail: rail ? rail.part : null,
      rollingSurfaces,
      negative: null,
    };
  });
}

function midline(
  part: RunningGearPart,
  line: RunningGearPart["axes"][number],
  rotation: Mat3,
): Vec3 | null {
  const first = line.runs[0];
  const last = line.runs.at(-1);
  if (!first || !last) return null;
  return apply(rotation, pointOnLine(line.axis, line.at, (first.from + last.to) / 2));
}

function everyOnRail(wheelsets: ReadonlyArray<PlannedWheelset>): boolean {
  return (
    wheelsets.length > 0 &&
    wheelsets.every((wheelset) => wheelset.rail !== null && wheelset.rollingSurfaces.length === 2)
  );
}

export function mountRunningGear(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  carrier: Carrier,
  part: RunningGearPart,
  xRange: readonly [number, number],
  rails: ReadonlyArray<RailHeadBands>,
  explode: boolean,
  unit: string,
): MountedRunningGear | null {
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
  for (const x of random.shuffled(xs).slice(0, SEAT_TRIES)) {
    const checkpoint = model.checkpoint();
    const position: Vec3 = [x, carrier.bottom - box.max[VERTICAL], z];
    const indices = placeRunningPart(model, pools, random, part, rotation, position, explode, unit);
    const wheelsets = indices
      ? plannedWheelsets(model, part, indices, rotation, position, rails, unit)
      : [];
    if (indices && everyOnRail(wheelsets) && !model.collidesSince(checkpoint)) {
      for (const index of indices) model.join(index, carrier.index);
      return {
        wheelsets,
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
  part: RunningGearPart,
  pivotRange: readonly [number, number],
  rails: ReadonlyArray<RailHeadBands>,
  unitBody: string,
  unitBogie: string,
): MountedRunningGear | null {
  const pin = part.pivotPin;
  const oriented = lateralRotation(part, random);
  if (!pin || !oriented) return null;
  const { rotation } = oriented;
  const plates = Math.ceil(pin.height / PLATE_LDU);
  const box = rotatedBounds(part.reading.bounds, rotation);
  const pinWorld = apply(rotation, [pin.at[0], 0, pin.at[1]]);
  for (const option of random.shuffled(pivotOptions(pools))) {
    for (const hole of random.shuffled(option.holes)) {
      const [length, width] = footprint(option.block, option.turns);
      const xs: number[] = [];
      for (let x = body.x0; x + length * STUD_LDU <= body.x1; x += STUD_LDU) {
        const pivotX = x + hole[0];
        if (pivotX >= pivotRange[0] && pivotX <= pivotRange[1]) xs.push(x);
      }
      const zCorner = -hole[1];
      if (!onLattice(zCorner, body.z0) || zCorner < body.z0 || zCorner + width * STUD_LDU > body.z1)
        continue;
      for (const x of random.shuffled(xs).slice(0, SEAT_TRIES)) {
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
        const wheelsets = indices
          ? plannedWheelsets(model, part, indices, rotation, position, rails, unitBogie)
          : [];
        if (indices && everyOnRail(wheelsets) && !model.collidesSince(checkpoint)) {
          return {
            wheelsets,
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
