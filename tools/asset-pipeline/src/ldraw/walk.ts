import {
  applyToPoint,
  compose,
  IDENTITY,
  translationOf,
  type Affine,
  type Vec3,
} from "./affine.ts";
import type { WalkResult } from "./closure.ts";
import type { LdrawLibrary } from "./library.ts";
import { polygonVertices, subfilePlacement } from "./parse.ts";

const INHERIT_COLOR = 16;

export interface PlacedReference {
  readonly file: string;
  readonly color: number;
  readonly world: Affine;
  readonly positionToleranceLdu: number;
  readonly rotationTolerance: number;
}

export interface PlacedPolygon {
  readonly color: number;
  readonly vertices: ReadonlyArray<Vec3>;
}

export interface WalkVisitor {
  readonly reference?: (placed: PlacedReference) => "descend" | "skip";
  readonly polygon?: (placed: PlacedPolygon) => void;
}

function resolveColor(own: number, inherited: number): number {
  return own === INHERIT_COLOR ? inherited : own;
}

export function walkPart(
  library: LdrawLibrary,
  fileName: string,
  visitor: WalkVisitor,
): WalkResult {
  const visitedFiles = new Set<string>();
  const missingFiles = new Set<string>();

  const visit = (name: string, parent: PlacedReference): void => {
    const file = library.load(name);
    if (file === undefined) {
      missingFiles.add(name);
      return;
    }
    visitedFiles.add(name);
    for (const line of file.lines) {
      if (line.kind === "geometry" && (line.type === 3 || line.type === 4)) {
        visitor.polygon?.({
          color: resolveColor(Number(line.tokens[0]), parent.color),
          vertices: polygonVertices(line).map((vertex) => applyToPoint(parent.world, vertex)),
        });
      } else if (line.kind === "subfile") {
        const placement = subfilePlacement(line);
        const placed: PlacedReference = {
          file: line.reference,
          color: resolveColor(placement.color, parent.color),
          world: compose(parent.world, placement.transform),
          positionToleranceLdu:
            parent.positionToleranceLdu +
            parent.rotationTolerance * Math.hypot(...translationOf(placement.transform)) +
            placement.translationUnit,
          rotationTolerance: parent.rotationTolerance + placement.rotationUnit,
        };
        if ((visitor.reference?.(placed) ?? "descend") === "descend") visit(placed.file, placed);
      }
    }
  };

  const root = fileName.toLowerCase();
  visit(root, {
    file: root,
    color: INHERIT_COLOR,
    world: IDENTITY,
    positionToleranceLdu: 0,
    rotationTolerance: 0,
  });
  return { visitedFiles, missingFiles };
}
