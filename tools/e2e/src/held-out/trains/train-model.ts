import { AXES, type Axis, type Sign } from "./part-geometry.ts";
import type { Box, PartReading } from "./part-readings.ts";
import type { Mat3 } from "./train-pools.ts";
import type { Vec3 } from "../assembly.ts";

const QUARTER_TURNS = 4;
const COS = [1, 0, -1, 0] as const;
const SIN = [0, 1, 0, -1] as const;
const C = [1, -1, -1] as const;
const OVERLAP_LDU = 0.5;
const AUTHOR = "0 Author: lug-layout held-out generator";
const LICENSE = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt";

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[row * 3 + k] ?? 0) * (b[k * 3 + column] ?? 0);
      out.push(sum + 0);
    }
  }
  return out as unknown as Mat3;
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + 0,
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2] + 0,
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2] + 0,
  ];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function yaw(turns: number): Mat3 {
  const k = ((turns % QUARTER_TURNS) + QUARTER_TURNS) % QUARTER_TURNS;
  const c = COS[k] ?? 1;
  const s = SIN[k] ?? 0;
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function unitVector(axis: Axis, sign: Sign): Vec3 {
  const v: [number, number, number] = [0, 0, 0];
  v[axis] = sign;
  return v;
}

function determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

const PERMUTATIONS: ReadonlyArray<readonly [Axis, Axis, Axis]> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

const CUBE_ROTATIONS: ReadonlyArray<Mat3> = PERMUTATIONS.flatMap((permutation) =>
  [1, -1].flatMap((a) =>
    [1, -1].flatMap((b) =>
      [1, -1].map((c) => {
        const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        const signs = [a, b, c];
        for (let row = 0; row < 3; row++) {
          m[row * 3 + (permutation[row] ?? 0)] = signs[row] ?? 1;
        }
        return m as unknown as Mat3;
      }),
    ),
  ),
).filter((m) => determinant(m) > 0);

export function rotationsTaking(
  from: { readonly axis: Axis; readonly sign: Sign },
  to: { readonly axis: Axis; readonly sign: Sign },
): ReadonlyArray<Mat3> {
  const target = unitVector(to.axis, to.sign);
  return CUBE_ROTATIONS.filter((m) => {
    const image = apply(m, unitVector(from.axis, from.sign));
    return AXES.every((axis) => image[axis] === target[axis]);
  });
}

export function transformedBox(box: Box, rotation: Mat3, position: Vec3): Box {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const local: Vec3 = [
      corner & 1 ? box.max[0] : box.min[0],
      corner & 2 ? box.max[1] : box.min[1],
      corner & 4 ? box.max[2] : box.min[2],
    ];
    const world = add(apply(rotation, local), position);
    for (const axis of AXES) {
      min[axis] = Math.min(min[axis], world[axis]);
      max[axis] = Math.max(max[axis], world[axis]);
    }
  }
  return { min, max };
}

export interface Placement {
  readonly reading: PartReading;
  readonly rotation: Mat3;
  readonly position: Vec3;
  readonly color: number;
  readonly unit: string;
}

export class TrainModel {
  readonly placements: Placement[] = [];
  private readonly joins = new Set<string>();

  place(reading: PartReading, rotation: Mat3, position: Vec3, color: number, unit: string): number {
    this.placements.push({ reading, rotation, position, color, unit });
    return this.placements.length - 1;
  }

  checkpoint(): number {
    return this.placements.length;
  }

  rollback(checkpoint: number): void {
    this.placements.length = checkpoint;
    for (const key of this.joins) {
      const [a = 0, b = 0] = key.split(" ").map(Number);
      if (a >= checkpoint || b >= checkpoint) this.joins.delete(key);
    }
  }

  join(a: number, b: number): void {
    this.joins.add(a < b ? `${a} ${b}` : `${b} ${a}`);
  }

  joined(a: number, b: number): boolean {
    return this.joins.has(a < b ? `${a} ${b}` : `${b} ${a}`);
  }

  box(index: number): Box {
    const placement = this.placements[index];
    if (!placement) throw new Error(`no placement ${index}`);
    return transformedBox(placement.reading.bounds, placement.rotation, placement.position);
  }

  collidesSince(checkpoint: number): boolean {
    return this.collisions(checkpoint).length > 0;
  }

  collisions(since = 0): ReadonlyArray<readonly [number, number]> {
    const boxes = this.placements.map((_, index) => this.box(index));
    const out: Array<readonly [number, number]> = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = Math.max(i + 1, since); j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b || this.joined(i, j)) continue;
        const overlaps = AXES.every(
          (axis) =>
            Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > OVERLAP_LDU,
        );
        if (overlaps) out.push([i, j]);
      }
    }
    return out;
  }

  ldraw(name: string, title: string): string {
    const lines = this.placements.map(({ reading, rotation, position, color }) => {
      const ldrawPosition = position.map((value, axis) => value * (C[axis] ?? 1) + 0);
      const ldrawRotation = rotation.map(
        (value, k) => value * (C[Math.floor(k / 3)] ?? 1) * (C[k % 3] ?? 1) + 0,
      );
      return `1 ${color} ${[...ldrawPosition, ...ldrawRotation].join(" ")} ${reading.reference}`;
    });
    return [`0 ${title}`, `0 Name: ${name}`, AUTHOR, LICENSE, ...lines, ""].join("\n");
  }
}
