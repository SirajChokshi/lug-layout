import {
  addExactRational,
  compareExactRational,
  exactRational,
  exactRationalFromDecimal,
  multiplyExactRational,
  parseExactDecimal,
  subtractExactRational,
  type ExactRational,
} from "@brr/math";
import {
  AXIS_FREE,
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
} from "../connect/connector-table.ts";
import {
  MODEL_ROOT,
  NO_FRAME,
  type PartInstances,
  type SubmodelFrames,
} from "../connect/submodel-frames.ts";
import type { ExactBox } from "./exact-boxes.ts";
import type { PartExtents } from "./part-extents.ts";
import type { WrittenTransforms } from "./written-transforms.ts";

type ExactAffine = ReadonlyArray<ExactRational>;

const WRITTEN_NUMBERS = 12;
const AXES = 3;
const ROW = 4;
const TRANSLATION = 3;
const ROTATION_START = 3;
const MODEL_UP_ROW = 1;
const CORNERS = 8;
const Y_UP_SIGNS = [1n, -1n, -1n] as const;
const AXIS_CODES = [
  [AXIS_POS_X, AXIS_NEG_X],
  [AXIS_POS_Y, AXIS_NEG_Y],
  [AXIS_POS_Z, AXIS_NEG_Z],
] as const;
const ZERO = exactRational(0n, 1n);
const ONE = exactRational(1n, 1n);
const IDENTITY: ExactAffine = [ONE, ZERO, ZERO, ZERO, ZERO, ONE, ZERO, ZERO, ZERO, ZERO, ONE, ZERO];

function writtenNumber(token: string): ExactRational | null {
  try {
    return exactRationalFromDecimal(parseExactDecimal(token));
  } catch {
    return null;
  }
}

function entry(m: ExactAffine, row: number, column: number): ExactRational {
  return m[row * ROW + column] ?? ZERO;
}

function scaled(value: ExactRational, sign: bigint): ExactRational {
  return multiplyExactRational(value, exactRational(sign, 1n));
}

function yUpAffine(text: string | undefined): ExactAffine | null {
  const tokens = text?.split(" ") ?? [];
  if (tokens.length !== WRITTEN_NUMBERS) return null;
  const values = tokens.map(writtenNumber);
  const out: ExactRational[] = [];
  for (let r = 0; r < AXES; r++) {
    const rowSign = Y_UP_SIGNS[r] ?? 1n;
    for (let c = 0; c < AXES; c++) {
      const value = values[ROTATION_START + r * AXES + c];
      if (!value) return null;
      out.push(scaled(value, rowSign * (Y_UP_SIGNS[c] ?? 1n)));
    }
    const translation = values[r];
    if (!translation) return null;
    out.push(scaled(translation, rowSign));
  }
  return out;
}

function determinant(m: ExactAffine): ExactRational {
  const minor = (r: number, a: number, b: number): ExactRational =>
    subtractExactRational(
      multiplyExactRational(entry(m, 1, a), entry(m, 2, b)),
      multiplyExactRational(entry(m, 1, b), entry(m, 2, a)),
    );
  return [minor(0, 1, 2), minor(0, 2, 0), minor(0, 0, 1)].reduce(
    (sum, cofactor, c) => addExactRational(sum, multiplyExactRational(entry(m, 0, c), cofactor)),
    ZERO,
  );
}

function composed(outer: ExactAffine, inner: ExactAffine): ExactAffine {
  const out: ExactRational[] = [];
  for (let r = 0; r < AXES; r++) {
    for (let c = 0; c < ROW; c++) {
      let sum = c === TRANSLATION ? entry(outer, r, TRANSLATION) : ZERO;
      for (let k = 0; k < AXES; k++) {
        sum = addExactRational(sum, multiplyExactRational(entry(outer, r, k), entry(inner, k, c)));
      }
      out.push(sum);
    }
  }
  return out;
}

function mapped(m: ExactAffine, point: ReadonlyArray<ExactRational>, row: number): ExactRational {
  let sum = entry(m, row, TRANSLATION);
  for (let k = 0; k < AXES; k++) {
    sum = addExactRational(sum, multiplyExactRational(entry(m, row, k), point[k] ?? ZERO));
  }
  return sum;
}

export class WrittenPoses {
  private readonly lines = new Map<number, ExactAffine | null>();
  private readonly chains = new Map<number, ExactAffine | null>();
  private readonly boxes = new Map<number, ExactBox | null>();
  private readonly nodes: number;

  constructor(
    private readonly frames: SubmodelFrames,
    private readonly instances: PartInstances,
    private readonly extents: ReadonlyArray<PartExtents | null>,
    private readonly written: WrittenTransforms | null,
  ) {
    this.nodes = instances.submodels?.count ?? 0;
  }

  up(frame: number): number | null {
    const chain = this.chain(MODEL_ROOT, frame);
    if (!chain) return null;
    const row = [0, 1, 2].map((c) => compareExactRational(entry(chain, MODEL_UP_ROW, c), ZERO));
    const axes = row.flatMap((sign, dimension) => (sign === 0 ? [] : [{ sign, dimension }]));
    const [only] = axes;
    if (axes.length !== 1 || !only) return AXIS_FREE;
    return AXIS_CODES[only.dimension]?.[only.sign > 0 ? 0 : 1] ?? AXIS_FREE;
  }

  box(instance: number, frame: number): ExactBox | null {
    const key = (frame - NO_FRAME) * this.instances.count + instance;
    const known = this.boxes.get(key);
    if (known !== undefined) return known;
    const box = this.exactBox(instance, frame);
    this.boxes.set(key, box);
    return box;
  }

  private exactBox(instance: number, frame: number): ExactBox | null {
    const part = this.extents[this.instances.partIndex[instance] ?? -1];
    const holder = this.chain(frame, this.frames.frameOf(instance));
    const line = this.line(-1 - instance, () => this.written?.instance[instance]);
    if (!part || !holder || !line || !this.chain(MODEL_ROOT, frame)) return null;
    const pose = composed(holder, line);
    const intervals: Array<{ low: ExactRational; high: ExactRational }> = [];
    for (let row = 0; row < AXES; row++) {
      let low: ExactRational | null = null;
      let high: ExactRational | null = null;
      for (let corner = 0; corner < CORNERS; corner++) {
        const point = [0, 1, 2].map((k) =>
          (corner >> k) & 1 ? (part.max[k] ?? ZERO) : (part.min[k] ?? ZERO),
        );
        const value = mapped(pose, point, row);
        if (low === null || compareExactRational(value, low) < 0) low = value;
        if (high === null || compareExactRational(value, high) > 0) high = value;
      }
      intervals.push({ low: low ?? ZERO, high: high ?? ZERO });
    }
    return intervals;
  }

  private chain(frame: number, node: number): ExactAffine | null {
    if (node === frame) return IDENTITY;
    if (node === MODEL_ROOT) return null;
    const key = (frame - NO_FRAME) * (this.nodes + 1) + node;
    const known = this.chains.get(key);
    if (known !== undefined) return known;
    const above = this.chain(frame, this.frames.parentFrame(node));
    const line = this.line(node, () => this.written?.placement[node]);
    const chain = above && line ? composed(above, line) : null;
    this.chains.set(key, chain);
    return chain;
  }

  private line(key: number, text: () => string | undefined): ExactAffine | null {
    const known = this.lines.get(key);
    if (known !== undefined) return known;
    const affine = yUpAffine(text());
    const line = affine && compareExactRational(determinant(affine), ZERO) !== 0 ? affine : null;
    this.lines.set(key, line);
    return line;
  }
}
