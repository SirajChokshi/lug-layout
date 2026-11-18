import type { Axis, HoleLine } from "./technic-frames.ts";

export type Vec3 = readonly [number, number, number];

export interface PinSegment extends HoleLine {
  readonly radius: number;
}

export interface AssemblyPart {
  readonly reference: string;
  readonly min: Vec3;
  readonly max: Vec3;
  readonly holes: ReadonlyArray<HoleLine>;
  readonly pin: PinSegment | null;
}

export type Assembly = ReadonlyArray<AssemblyPart>;

export interface PinContacts {
  readonly pins: number;
  readonly inHole: number;
  readonly colliding: number;
  readonly free: number;
}

const AXES: ReadonlyArray<Axis> = [0, 1, 2];

function shiftedLine<T extends HoleLine>(line: T, offset: Vec3): T {
  const [first, second] = AXES.filter((axis) => axis !== line.axis);
  return {
    ...line,
    at: [line.at[0] + offset[first ?? 0], line.at[1] + offset[second ?? 0]],
    from: line.from + offset[line.axis],
    to: line.to + offset[line.axis],
  };
}

function shiftedVec(vector: Vec3, offset: Vec3): Vec3 {
  return [vector[0] + offset[0], vector[1] + offset[1], vector[2] + offset[2]];
}

export function translated(assembly: Assembly, offset: Vec3): Assembly {
  return assembly.map((part) => ({
    reference: part.reference,
    min: shiftedVec(part.min, offset),
    max: shiftedVec(part.max, offset),
    holes: part.holes.map((hole) => shiftedLine(hole, offset)),
    pin: part.pin ? shiftedLine(part.pin, offset) : null,
  }));
}

function overlap(a: AssemblyPart, b: AssemblyPart, axis: Axis): readonly [number, number] {
  return [Math.max(a.min[axis], b.min[axis]), Math.min(a.max[axis], b.max[axis])];
}

function boxesOverlap(a: AssemblyPart, b: AssemblyPart): boolean {
  return AXES.every((axis) => {
    const [low, high] = overlap(a, b, axis);
    return high > low;
  });
}

function pinThroughHole(pinPart: AssemblyPart, holder: AssemblyPart): boolean {
  const pin = pinPart.pin;
  if (!pin) return false;
  const [low, high] = overlap(pinPart, holder, pin.axis);
  return holder.holes.some(
    (hole) =>
      hole.axis === pin.axis &&
      hole.at[0] === pin.at[0] &&
      hole.at[1] === pin.at[1] &&
      hole.from <= low &&
      high <= hole.to,
  );
}

function collide(a: AssemblyPart, b: AssemblyPart): boolean {
  return boxesOverlap(a, b) && !pinThroughHole(a, b) && !pinThroughHole(b, a);
}

export function collisions(assembly: Assembly, others: Assembly = []): number {
  let count = 0;
  for (let i = 0; i < assembly.length; i++) {
    const a = assembly[i];
    if (!a) continue;
    const partners = others.length > 0 ? others : assembly.slice(i + 1);
    for (const b of partners) if (collide(a, b)) count++;
  }
  return count;
}

export function pinContacts(subject: Assembly, neighbour: Assembly): PinContacts {
  let pins = 0;
  let inHole = 0;
  let colliding = 0;
  for (const part of subject) {
    if (!part.pin) continue;
    pins++;
    const touched = neighbour.filter((other) => boxesOverlap(part, other));
    if (touched.length === 0) continue;
    if (touched.every((other) => pinThroughHole(part, other))) inHole++;
    else colliding++;
  }
  return { pins, inHole, colliding, free: pins - inHole - colliding };
}
