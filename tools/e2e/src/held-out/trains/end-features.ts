import { type SeededRandom } from "../generator.ts";
import { type Vec3 } from "../assembly.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import { type Axis, type Sign, VERTICAL } from "./part-geometry.ts";
import {
  type BearingOption,
  type Carrier,
  END_TRIES,
  LATERAL,
  TRAVEL,
  bearingOptions,
  footprint,
  pickColor,
  placeAlong,
  placeBlockOn,
  pointOnLine,
} from "./placement.ts";
import { type TrainModel, add, apply } from "./train-model.ts";
import type { PlannedEnd } from "./train-plan.ts";
import type { PinPart, TrainPools } from "./train-pools.ts";
export type EndVariant = "pin" | "pin and buffer" | "pin and outer pin" | "off-axis pin";

export function buildEnd(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  end: Sign,
  variant: EndVariant,
  unit: string,
): PlannedEnd | null {
  for (let attempt = 0; attempt < END_TRIES; attempt++) {
    const checkpoint = model.checkpoint();
    const feature = buildEndOnce(model, pools, random, body, end, variant, unit);
    if (feature && !model.collidesSince(checkpoint)) return feature;
    model.rollback(checkpoint);
  }
  return null;
}

function buildEndOnce(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  body: Carrier,
  end: Sign,
  variant: EndVariant,
  unit: string,
): PlannedEnd | null {
  const axis: Axis = variant === "off-axis pin" ? LATERAL : TRAVEL;
  const pin = random.choice(pools.pins);
  if (!pin) return null;
  const xEnd = end > 0 ? body.x1 : body.x0;
  for (const option of random.shuffled(bearingOptions(pools, axis, true))) {
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
      const nonCandidates: Array<PlannedEnd["nonCandidates"][number]> = [
        { instance: brick, at: [innerX, holeY, holeZ], reason: "inward" },
      ];
      if (variant === "pin") return { candidates, nonCandidates };
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
      nonCandidates.push({ instance: buffer.index, at: buffer.tip, reason: "buffer" });
      if (variant === "pin and buffer") return { candidates, nonCandidates };
      const outer = outerPin(model, pools, random, buffer, end, pin, unit);
      if (!outer) return null;
      const ordered = [...outer.candidates, ...candidates].toSorted(
        (a, b) => end * (b.tip[TRAVEL] - a.tip[TRAVEL]),
      );
      return { candidates: ordered, nonCandidates: [...nonCandidates, ...outer.nonCandidates] };
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
      nonCandidates: [
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
  for (const plate of random.shuffled(pools.plates)) {
    for (const turns of [0, 1]) {
      const [length, width] = footprint(plate, turns);
      if (length < reach + 1 || width > 2) continue;
      const zSize = width * STUD_LDU;
      const zCorners: number[] = [];
      for (let z = body.z0; z + zSize <= body.z1; z += STUD_LDU) {
        if (z + zSize <= avoid[0] || z >= avoid[1]) zCorners.push(z);
      }
      const zCorner = random.choice(zCorners);
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
): PlannedEnd | null {
  for (const option of random.shuffled(bearingOptions(pools, TRAVEL, true))) {
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
      nonCandidates: [{ instance: brick, at: [innerX, holeY, holeZ], reason: "inward" }],
    };
  }
  return null;
}
