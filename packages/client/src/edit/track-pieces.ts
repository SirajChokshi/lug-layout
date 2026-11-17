import type { TrackPiece } from "@brr/schema/bundle";
import { conjugateZeta16, pose16, pose16Equals, type Pose16 } from "@brr/math";

export type Lever = "straight" | "branching";

const FORMED_VARIANT = /-f\d+$/u;
const LEVER_TITLE: ReadonlyArray<readonly [RegExp, Lever]> = [
  [/\s+Straight$/u, "straight"],
  [/\s+Branching$/u, "branching"],
];

export interface PieceElement {
  readonly element: string;
  readonly title: string;
}

interface Entry {
  readonly index: number;
  readonly piece: TrackPiece;
  readonly element: string;
  readonly lever: Lever | null;
  readonly title: string;
}

function mirrorPose(pose: Pose16): Pose16 {
  return pose16(conjugateZeta16(pose.position), -pose.heading);
}

function sameEnds(a: ReadonlyArray<Pose16>, b: ReadonlyArray<Pose16>): boolean {
  return (
    a.length === b.length && a.every((end, i) => b[i] !== undefined && pose16Equals(end, b[i]))
  );
}

function mirrors(a: TrackPiece, b: TrackPiece): boolean {
  if (a.connectors.length !== b.connectors.length) return false;
  return a.connectors.every((end) => {
    const image = mirrorPose(end.pose);
    return b.connectors.some((other) => pose16Equals(image, other.pose));
  });
}

function leverOf(title: string): { readonly lever: Lever; readonly title: string } | null {
  for (const [pattern, lever] of LEVER_TITLE) {
    if (pattern.test(title)) return { lever, title: title.replace(pattern, "") };
  }
  return null;
}

function entryOf(piece: TrackPiece, index: number, formed: boolean): Entry {
  const element = piece.part.replace(FORMED_VARIANT, "");
  if (!formed) return { index, piece, element, lever: null, title: piece.title };
  const lever = leverOf(piece.title);
  if (!lever) {
    throw new Error(`${piece.id}: a formed switch variant whose title names no lever position`);
  }
  return { index, piece, element, lever: lever.lever, title: lever.title };
}

export class TrackPieceSet {
  private readonly entries = new Map<number, Entry>();

  constructor(pieces: ReadonlyArray<readonly [number, TrackPiece]>) {
    const variants = new Map<string, number>();
    for (const [, piece] of pieces) {
      const element = piece.part.replace(FORMED_VARIANT, "");
      variants.set(element, (variants.get(element) ?? 0) + 1);
    }
    for (const [index, piece] of pieces) {
      const element = piece.part.replace(FORMED_VARIANT, "");
      this.entries.set(index, entryOf(piece, index, (variants.get(element) ?? 0) > 1));
    }
    for (const entry of this.entries.values()) {
      if (entry.lever === null) continue;
      const other = this.thrown(entry.index);
      if (other === null) throw new Error(`${entry.piece.id}: no other lever position for it`);
    }
  }

  private entry(index: number): Entry {
    const entry = this.entries.get(index);
    if (!entry) throw new RangeError(`catalog piece ${index} is not a placeable track piece`);
    return entry;
  }

  palette(): ReadonlyArray<number> {
    return [...this.entries.values()]
      .filter((entry) => entry.lever === null || entry.lever === "straight")
      .map((entry) => entry.index);
  }

  lever(index: number): Lever | null {
    return this.entry(index).lever;
  }

  element(index: number): PieceElement {
    const { element, title } = this.entry(index);
    return { element, title };
  }

  thrown(index: number): number | null {
    const entry = this.entry(index);
    if (entry.lever === null) return null;
    const ends = entry.piece.connectors.map((c) => c.pose);
    for (const other of this.entries.values()) {
      if (other.element !== entry.element || other.lever === null || other.lever === entry.lever) {
        continue;
      }
      if (
        sameEnds(
          ends,
          other.piece.connectors.map((c) => c.pose),
        )
      ) {
        return other.index;
      }
    }
    return null;
  }

  mirrored(index: number): number | null {
    const entry = this.entry(index);
    if (entry.piece.kind !== "switch") return null;
    for (const other of this.entries.values()) {
      if (other.element === entry.element || other.lever !== entry.lever) continue;
      if (mirrors(entry.piece, other.piece)) return other.index;
    }
    return null;
  }
}
