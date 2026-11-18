import {
  addExactDecimal,
  EXACT_DECIMAL_ZERO,
  exactDecimal,
  multiplyExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
} from "@brr/math";
import type { LdrawLibrary } from "./library.ts";
import { isStudPrimitive } from "./parse.ts";

export type ExactVec3 = readonly [ExactDecimal, ExactDecimal, ExactDecimal];

type ExactAffine = readonly ExactDecimal[];

export interface ExactPolygon {
  readonly vertices: ReadonlyArray<ExactVec3>;
}

const SUBFILE_NUMBER_COUNT = 12;
const ONE = exactDecimal(1n, 0);
const EXACT_IDENTITY: ExactAffine = [
  ONE,
  EXACT_DECIMAL_ZERO,
  EXACT_DECIMAL_ZERO,
  EXACT_DECIMAL_ZERO,
  ONE,
  EXACT_DECIMAL_ZERO,
  EXACT_DECIMAL_ZERO,
  EXACT_DECIMAL_ZERO,
  ONE,
  EXACT_DECIMAL_ZERO,
  EXACT_DECIMAL_ZERO,
  EXACT_DECIMAL_ZERO,
];

function entry(matrix: ExactAffine, index: number): ExactDecimal {
  const value = matrix[index];
  if (value === undefined) throw new Error(`an affine transform has no entry ${index}`);
  return value;
}

function dot3(
  a: ExactDecimal,
  x: ExactDecimal,
  b: ExactDecimal,
  y: ExactDecimal,
  c: ExactDecimal,
  z: ExactDecimal,
): ExactDecimal {
  return addExactDecimal(
    addExactDecimal(multiplyExactDecimal(a, x), multiplyExactDecimal(b, y)),
    multiplyExactDecimal(c, z),
  );
}

function applyExactly(matrix: ExactAffine, [px, py, pz]: ExactVec3): ExactVec3 {
  const at = (index: number) => entry(matrix, index);
  return [
    addExactDecimal(dot3(at(0), px, at(1), py, at(2), pz), at(9)),
    addExactDecimal(dot3(at(3), px, at(4), py, at(5), pz), at(10)),
    addExactDecimal(dot3(at(6), px, at(7), py, at(8), pz), at(11)),
  ];
}

function composeExactly(outer: ExactAffine, inner: ExactAffine): ExactAffine {
  const o = (index: number) => entry(outer, index);
  const i = (index: number) => entry(inner, index);
  const linear = [0, 1, 2].flatMap((row) =>
    [0, 1, 2].map((column) =>
      dot3(o(row * 3), i(column), o(row * 3 + 1), i(column + 3), o(row * 3 + 2), i(column + 6)),
    ),
  );
  const [tx, ty, tz] = applyExactly(outer, [i(9), i(10), i(11)]);
  return [...linear, tx, ty, tz];
}

function exactTokens(tokens: ReadonlyArray<string>, from: number, count: number): ExactDecimal[] {
  return tokens.slice(from, from + count).map(parseExactDecimal);
}

function placementOf(tokens: ReadonlyArray<string>): ExactAffine {
  const numbers = exactTokens(tokens, 1, SUBFILE_NUMBER_COUNT);
  if (numbers.length !== SUBFILE_NUMBER_COUNT) {
    throw new Error(`a type-1 line needs ${SUBFILE_NUMBER_COUNT} numbers, got ${numbers.length}`);
  }
  const at = (index: number) => entry(numbers, index);
  return [at(3), at(4), at(5), at(6), at(7), at(8), at(9), at(10), at(11), at(0), at(1), at(2)];
}

function verticesOf(tokens: ReadonlyArray<string>, count: number): ReadonlyArray<ExactVec3> {
  const numbers = exactTokens(tokens, 1, count * 3);
  return Array.from({ length: count }, (_, index): ExactVec3 => {
    const [x, y, z] = numbers.slice(index * 3, index * 3 + 3);
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error(`a polygon line needs ${count * 3} numbers`);
    }
    return [x, y, z];
  });
}

export interface ExactPlacement {
  readonly file: string;
  readonly origin: ExactVec3;
  readonly vertices: ReadonlyArray<ExactVec3>;
}

function visitPolygons(
  library: LdrawLibrary,
  name: string,
  world: ExactAffine,
  skipStuds: boolean,
  emit: (polygon: ExactPolygon) => void,
): void {
  const file = library.load(name);
  if (file === undefined) throw new Error(`${name} is not in the pinned library`);
  for (const line of file.lines) {
    if (line.kind === "geometry" && (line.type === 3 || line.type === 4)) {
      emit({
        vertices: verticesOf(line.tokens, line.type).map((vertex) => applyExactly(world, vertex)),
      });
    } else if (line.kind === "subfile" && !(skipStuds && isStudPrimitive(line.reference))) {
      visitPolygons(
        library,
        line.reference,
        composeExactly(world, placementOf(line.tokens)),
        skipStuds,
        emit,
      );
    }
  }
}

export function exactPolygons(
  library: LdrawLibrary,
  part: string,
  skipStuds: boolean,
): ReadonlyArray<ExactPolygon> {
  const polygons: ExactPolygon[] = [];
  visitPolygons(library, `${part}.dat`.toLowerCase(), EXACT_IDENTITY, skipStuds, (polygon) =>
    polygons.push(polygon),
  );
  return polygons;
}

export function exactPlacements(
  library: LdrawLibrary,
  part: string,
  files: ReadonlySet<string>,
): ReadonlyArray<ExactPlacement> {
  const placements: ExactPlacement[] = [];
  const visit = (name: string, world: ExactAffine): void => {
    const file = library.load(name);
    if (file === undefined) throw new Error(`${name} is not in the pinned library`);
    for (const line of file.lines) {
      if (line.kind !== "subfile" || isStudPrimitive(line.reference)) continue;
      const placement = composeExactly(world, placementOf(line.tokens));
      if (!files.has(line.reference)) {
        visit(line.reference, placement);
        continue;
      }
      const vertices: ExactVec3[] = [];
      visitPolygons(library, line.reference, placement, false, (polygon) =>
        vertices.push(...polygon.vertices),
      );
      const origin: ExactVec3 = [entry(placement, 9), entry(placement, 10), entry(placement, 11)];
      placements.push({ file: line.reference, origin, vertices });
    }
  };
  visit(`${part}.dat`.toLowerCase(), EXACT_IDENTITY);
  return placements;
}
