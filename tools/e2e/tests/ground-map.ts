export interface GroundSample {
  readonly sx: number;
  readonly sy: number;
  readonly x: number;
  readonly z: number;
}

export interface GroundMap {
  screenOf(x: number, z: number): { readonly sx: number; readonly sy: number };
}

const UNKNOWNS = 8;
const MIN_SAMPLES = 4;

interface Normalizer {
  readonly offsetA: number;
  readonly offsetB: number;
  readonly scale: number;
}

function normalizer(values: ReadonlyArray<readonly [number, number]>): Normalizer {
  const meanA = values.reduce((sum, [a]) => sum + a, 0) / values.length;
  const meanB = values.reduce((sum, [, b]) => sum + b, 0) / values.length;
  const spread =
    values.reduce((sum, [a, b]) => sum + Math.hypot(a - meanA, b - meanB), 0) / values.length;
  return { offsetA: meanA, offsetB: meanB, scale: spread > 0 ? 1 / spread : 1 };
}

function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(matrix[row]?.[col] ?? 0) > Math.abs(matrix[pivot]?.[col] ?? 0)) pivot = row;
    }
    const pivotRow = matrix[pivot];
    const colRow = matrix[col];
    if (!pivotRow || !colRow || Math.abs(pivotRow[col] ?? 0) < 1e-12) {
      throw new Error("the ground samples do not determine a projection");
    }
    matrix[pivot] = colRow;
    matrix[col] = pivotRow;
    [rhs[pivot], rhs[col]] = [rhs[col] ?? 0, rhs[pivot] ?? 0];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const target = matrix[row];
      if (!target) continue;
      const factor = (target[col] ?? 0) / (pivotRow[col] ?? 1);
      for (let k = col; k < n; k++) target[k] = (target[k] ?? 0) - factor * (pivotRow[k] ?? 0);
      rhs[row] = (rhs[row] ?? 0) - factor * (rhs[col] ?? 0);
    }
  }
  return rhs.map((value, i) => value / (matrix[i]?.[i] ?? 1));
}

export function fitGroundMap(samples: ReadonlyArray<GroundSample>): GroundMap {
  if (samples.length < MIN_SAMPLES) throw new Error("too few ground samples for a projection");
  const world = normalizer(samples.map((s) => [s.x, s.z]));
  const screen = normalizer(samples.map((s) => [s.sx, s.sy]));
  const normal = Array.from({ length: UNKNOWNS }, () => Array.from({ length: UNKNOWNS }, () => 0));
  const rhs = Array.from({ length: UNKNOWNS }, () => 0);
  const accumulate = (row: ReadonlyArray<number>, value: number): void => {
    for (let i = 0; i < UNKNOWNS; i++) {
      const line = normal[i];
      if (!line) continue;
      for (let j = 0; j < UNKNOWNS; j++) line[j] = (line[j] ?? 0) + (row[i] ?? 0) * (row[j] ?? 0);
      rhs[i] = (rhs[i] ?? 0) + (row[i] ?? 0) * value;
    }
  };
  for (const sample of samples) {
    const x = (sample.x - world.offsetA) * world.scale;
    const z = (sample.z - world.offsetB) * world.scale;
    const u = (sample.sx - screen.offsetA) * screen.scale;
    const v = (sample.sy - screen.offsetB) * screen.scale;
    accumulate([x, z, 1, 0, 0, 0, -x * u, -z * u], u);
    accumulate([0, 0, 0, x, z, 1, -x * v, -z * v], v);
  }
  const [h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0, h8 = 0] = solve(normal, rhs);
  return {
    screenOf(xLdu, zLdu) {
      const x = (xLdu - world.offsetA) * world.scale;
      const z = (zLdu - world.offsetB) * world.scale;
      const w = h7 * x + h8 * z + 1;
      return {
        sx: (h1 * x + h2 * z + h3) / w / screen.scale + screen.offsetA,
        sy: (h4 * x + h5 * z + h6) / w / screen.scale + screen.offsetB,
      };
    },
  };
}
