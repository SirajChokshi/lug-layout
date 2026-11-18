export type Axis = 0 | 1 | 2;

export interface HoleLine {
  readonly axis: Axis;
  readonly at: readonly [number, number];
  readonly from: number;
  readonly to: number;
}

export interface PinFrame {
  readonly axis: Axis;
  readonly halfLength: number;
  readonly radius: number;
}

export interface LdrawBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const HOLE_PRIMITIVE = /^(peghole|connhole|beamhole|beamhol)\w*\.dat$/iu;
const PIN_PRIMITIVE = /^(connect|confric)\w*\.dat$/iu;
const PATH_SEPARATOR = /[\\/]/u;
const FIELDS = /\s+/u;
const REFERENCE_FIELD = 14;
const POSITION_FIELD = 2;
const LOCAL_Y_COLUMN = [4, 7, 10] as const;
const AXES: ReadonlyArray<Axis> = [0, 1, 2];

interface Reference {
  readonly file: string;
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

function references(text: string): Reference[] {
  const out: Reference[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(FIELDS);
    if (fields[0] !== "1" || fields.length <= REFERENCE_FIELD) continue;
    const numbers = fields.slice(POSITION_FIELD, REFERENCE_FIELD).map(Number);
    if (numbers.some((value) => !Number.isFinite(value))) continue;
    const file = fields.slice(REFERENCE_FIELD).join(" ").split(PATH_SEPARATOR).at(-1) ?? "";
    out.push({
      file,
      position: [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0],
      direction: [
        numbers[LOCAL_Y_COLUMN[0]] ?? 0,
        numbers[LOCAL_Y_COLUMN[1]] ?? 0,
        numbers[LOCAL_Y_COLUMN[2]] ?? 0,
      ],
    });
  }
  return out;
}

function axisOf(direction: readonly [number, number, number]): { axis: Axis; sign: number } | null {
  const nonZero = AXES.filter((axis) => direction[axis] !== 0);
  const axis = nonZero[0];
  if (nonZero.length !== 1 || axis === undefined) return null;
  return { axis, sign: Math.sign(direction[axis]) };
}

function across(
  axis: Axis,
  position: readonly [number, number, number],
): readonly [number, number] {
  const [first, second] = AXES.filter((other) => other !== axis);
  return [position[first ?? 0], position[second ?? 0]];
}

export function holeLines(ldrawText: string): ReadonlyArray<HoleLine> {
  const lines = new Map<
    string,
    { axis: Axis; at: readonly [number, number]; from: number; to: number }
  >();
  for (const reference of references(ldrawText)) {
    if (!HOLE_PRIMITIVE.test(reference.file)) continue;
    const oriented = axisOf(reference.direction);
    if (!oriented) continue;
    const at = across(oriented.axis, reference.position);
    const along = reference.position[oriented.axis];
    const key = `${oriented.axis} ${at[0]} ${at[1]}`;
    const known = lines.get(key);
    lines.set(
      key,
      known
        ? { ...known, from: Math.min(known.from, along), to: Math.max(known.to, along) }
        : { axis: oriented.axis, at, from: along, to: along },
    );
  }
  return [...lines.values()].filter((line) => line.to > line.from);
}

export function pinFrame(ldrawText: string, bounds: LdrawBounds): PinFrame | null {
  const halves = references(ldrawText).flatMap((reference) => {
    if (!PIN_PRIMITIVE.test(reference.file)) return [];
    if (reference.position.some((value) => value !== 0)) return [];
    const oriented = axisOf(reference.direction);
    return oriented ? [oriented] : [];
  });
  const first = halves[0];
  if (!first) return null;
  const sameAxis = halves.filter((half) => half.axis === first.axis);
  if (!sameAxis.some((half) => half.sign !== first.sign)) return null;
  const halfLength = bounds.max[first.axis];
  if (bounds.min[first.axis] !== -halfLength || halfLength <= 0) return null;
  const radius = Math.max(
    ...AXES.filter((axis) => axis !== first.axis).map((axis) =>
      Math.max(-bounds.min[axis], bounds.max[axis]),
    ),
  );
  return { axis: first.axis, halfLength, radius };
}
