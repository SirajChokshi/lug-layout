import { type SeededRandom } from "../generator.ts";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { Block } from "./part-geometry.ts";
import {
  BODY_SLACK_STUDS,
  BODY_TRIES,
  type Carrier,
  footprint,
  pickColor,
  placeBlockOn,
} from "./placement.ts";
import type { TrainModel } from "./train-model.ts";
import type { TrainPools } from "./train-pools.ts";
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
  const width = random.choice([...strips.keys()]);
  const options = width === null ? [] : (strips.get(width) ?? []);
  if (width === null || options.length === 0) return null;
  const single = options.filter(
    (option) => option.length >= minLength && option.length <= minLength + BODY_SLACK_STUDS,
  );
  const chosen = random.choice(single);
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
    const next = random.choice(fitting);
    if (!next) return null;
    row.push(next);
    total += next.length;
  }
  return row.length >= 2 && (exact === null || total === exact) ? row : null;
}
