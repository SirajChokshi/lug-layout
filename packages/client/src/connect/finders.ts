import type {
  LatticeStudFinder,
  MateFinder,
  SparseConnectorFinder,
  TrackEndFinder,
} from "@brr/domain";

export const LATTICE_FAMILY = 0;
export const SPARSE_FAMILY = 1;
export const TRACK_FAMILY = 2;

export function solverFinders(
  lattice: LatticeStudFinder,
  sparse: SparseConnectorFinder,
  track: TrackEndFinder,
): ReadonlyArray<MateFinder> {
  const finders: MateFinder[] = [];
  finders[LATTICE_FAMILY] = lattice;
  finders[SPARSE_FAMILY] = sparse;
  finders[TRACK_FAMILY] = track;
  return finders;
}
