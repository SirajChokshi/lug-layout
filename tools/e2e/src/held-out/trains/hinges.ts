import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { SeededRandom } from "../generator.ts";
import { type Sign, VERTICAL } from "./part-geometry.ts";
import {
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
import type { TrainModel } from "./train-model.ts";
import type { TrainPools } from "./train-pools.ts";

export function hangHinge(
  model: TrainModel,
  pools: TrainPools,
  random: SeededRandom,
  carrier: Carrier,
  bodyBottom: number,
): boolean {
  const pin = random.choice(pools.pins);
  const options = bearingOptions(pools, LATERAL, true);
  if (!pin || options.length === 0) return false;
  for (let attempt = 0; attempt < END_TRIES; attempt++) {
    const option = random.choice(options);
    if (!option) return false;
    const [width, depth] = footprint(option.block, option.turns);
    const xSize = width * STUD_LDU;
    const zSize = depth * STUD_LDU;
    const columns = Math.floor((carrier.x1 - carrier.x0 - xSize) / STUD_LDU) + 1;
    if (columns < 1 || zSize > carrier.z1 - carrier.z0) continue;
    const height = option.box.max[VERTICAL] - option.box.min[VERTICAL];
    if (carrier.top + height > bodyBottom - PLATE_LDU) continue;
    const side: Sign = random.int(2) === 0 ? 1 : -1;
    const xCorner = carrier.x0 + STUD_LDU * random.int(columns);
    const checkpoint = model.checkpoint();
    const color = pickColor(random, pools);
    const holder = placeBlockOn(
      model,
      pools,
      option.block,
      option.turns,
      [xCorner, side > 0 ? carrier.z1 - zSize : carrier.z0],
      carrier.top,
      color,
      carrier.unit,
    );
    model.join(holder, carrier.index);
    const box = model.box(holder);
    const holeX = box.min[TRAVEL] + option.holeX;
    const holeY =
      carrier.top + (option.box.max[VERTICAL] - option.box.min[VERTICAL]) - option.holeDepth;
    const faceZ = side > 0 ? box.max[LATERAL] : box.min[LATERAL];
    const pinIndex = placeAlong(
      model,
      pin,
      { axis: pin.span.axis, sign: 1 },
      pointOnLine(pin.span.axis, pin.span.at, pin.span.centre),
      { axis: LATERAL, sign: side },
      [holeX, holeY, faceZ],
      pickColor(random, pools),
      carrier.unit,
    );
    model.join(pinIndex, holder);
    const swing = placeBlockOn(
      model,
      pools,
      option.block,
      option.turns,
      [xCorner, side > 0 ? faceZ : faceZ - zSize],
      carrier.top,
      color,
      carrier.unit,
    );
    model.join(pinIndex, swing);
    if (!model.collidesSince(checkpoint)) return true;
    model.rollback(checkpoint);
  }
  return false;
}
